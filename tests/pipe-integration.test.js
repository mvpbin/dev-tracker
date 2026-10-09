import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../server.js';
import { startPipeServer } from '../pipe-server.js';
import { createDiagnostics } from '../diagnostics.js';
import { removeDiscovery } from '../pipe-config.js';

async function deadline(work, label) { let timer; try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), 8000); })]); } finally { clearTimeout(timer); } }
function request({ url, socketPath, token, body, route = '/mcp' }) {
  return new Promise((resolve, reject) => {
    const address = url ? new URL(url) : null;
    const req = http.request({ ...(address ? { hostname: address.hostname, port: address.port, path: address.pathname } : { socketPath, path: route }), agent: false, method: body ? 'POST' : 'GET', headers: { Host: 'localhost', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', data => text += data); res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, text }); }); res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(Error('request deadline')), 3000); req.on('error', error => { clearTimeout(timer); reject(error); }); req.end(body);
  });
}

test('authenticated stdio pipe and HTTP share one coordinator, rotate discovery and persist concurrent work', { timeout: 45000 }, async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'tracker-production-pipe-'));
  const projectRoot = path.join(base, 'project'), storage = path.join(base, 'store'), directory = path.join(base, 'connection'); await mkdir(projectRoot);
  const diagnostics = createDiagnostics(), clients = [], pipes = [];
  let server;
  const result = { startedAtUtc: new Date().toISOString(), checks: [], childStderr: [] };
  async function connect(configPath, pipePath) {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--require', fileURLToPath(new URL('./fixtures/pipe-only-guard.cjs', import.meta.url)), fileURLToPath(new URL('../mcp-stdio.mjs', import.meta.url)), '--config', configPath], stderr: 'pipe', env: { ...process.env, PIPE_GUARD_LOG: path.join(base, 'socket-guard.jsonl'), PIPE_GUARD_PATH: pipePath } });
    const client = new Client({ name: 'production-pipe-integration', version: '1' }); clients.push({ client, transport });
    transport.stderr.on('data', data => result.childStderr.push(String(data)));
    await deadline(client.connect(transport), 'stdio initialize deadline'); return client;
  }
  async function call(client, name, args) { const response = await deadline(client.callTool({ name, arguments: args }), 'tool deadline'); assert.notEqual(response.isError, true, response.content[0].text); return JSON.parse(response.content[0].text); }
  try {
    server = await startServer({ storage, port: 0, diagnostics });
    const first = await startPipeServer(server, { directory }); pipes.push(first);
    const config = JSON.parse(await readFile(first.configPath, 'utf8'));
    assert.deepEqual(config, first.discovery); assert.equal(config.version, 1); assert.ok(/^[0-9a-f]{64}$/.test(config.token));
    assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false); result.checks.push('discovery is complete after atomic rename and contains no temporary residue');
    assert.equal((await request({ socketPath: config.pipePath })).status, 401);
    assert.equal((await request({ socketPath: config.pipePath, token: 'wrong-token' })).status, 401);
    assert.equal((await request({ socketPath: config.pipePath, token: config.token, route: '/api/state' })).status, 404); result.checks.push('missing/wrong bearer token and non-MCP pipe paths fail closed');
    const [a, b] = await Promise.all([connect(first.configPath, config.pipePath), connect(first.configPath, config.pipePath)]);
    const [sa, sb] = await Promise.all([call(a, 'bind_session', { projectRoot, label: 'pipe-a' }), call(b, 'bind_session', { projectRoot, label: 'pipe-b' })]);
    await server.selectProject(projectRoot);
    const tool = (client, session, name, args = {}) => call(client, name, { sessionId: session.sessionId, ...args });
    assert.equal((await tool(a, sa, 'get_handoff')).snapshot.project.root, projectRoot);
    await Promise.all(Array.from({ length: 20 }, (_, id) => tool(id % 2 ? b : a, id % 2 ? sb : sa, 'update_node', { id: 'root', action: 'add', text: `shared-${id}` })));
    const ui = JSON.parse((await request({ url: `http://127.0.0.1:${server.address().port}/api/state` })).text);
    assert.equal(ui.nodes.length, 21); assert.equal(new Set(ui.nodes.slice(1).map(node => node.title)).size, 20);
    assert.equal((await tool(b, sb, 'get_map')).length, 21); result.checks.push('two stdio clients and HTTP see twenty serialized writes in the same state');
    const malformed = path.join(base, 'malformed.json'); await writeFile(malformed, JSON.stringify({ ...config, token: 'invalid' }));
    try {
      const invalid = await connect(malformed, config.pipePath);
      await assert.rejects(call(invalid, 'get_map', { sessionId: sa.sessionId }));
    } catch (error) { assert.match(error.message, /closed|pipe|config|connection/i); }
    result.checks.push('malformed discovery fails without fallback');
    await assert.rejects(startPipeServer(server, { directory }), error => error.code === 'EADDRINUSE');
    assert.equal((await tool(a, sa, 'get_map')).length, 21); result.checks.push('live discovery cannot be overwritten and the original coordinator remains usable');
    await removeDiscovery(first.configPath, 'different-generation');
    assert.equal(JSON.parse(await readFile(first.configPath, 'utf8')).runId, config.runId); result.checks.push('generation mismatch cannot remove another discovery owner');
    for (const { client } of clients) await client.close();
    await server.shutdown();
    await first.close(); await assert.rejects(access(first.configPath), { code: 'ENOENT' });
    await writeFile(path.join(directory, 'discovery.json'), JSON.stringify(config));
    server = await startServer({ storage, port: 0, diagnostics });
    const restarted = await startPipeServer(server, { directory }); pipes.push(restarted);
    assert.notEqual(restarted.discovery.token, config.token); assert.notEqual(restarted.discovery.runId, config.runId);
    const resumed = await connect(restarted.configPath, restarted.discovery.pipePath);
    assert.equal((await tool(resumed, sa, 'get_map')).length, 21); result.checks.push('restart replaces stale discovery and preserves the old session and all writes');
    const attempts = (await readFile(path.join(base, 'socket-guard.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(attempts.length && attempts.every(row => row.namedPipe && !row.tcp)); result.checks.push('stdio-to-coordinator sockets use only named pipe while HTTP UI remains available');
    assert.equal(diagnostics.exportJSONL().includes(config.token), false); assert.equal(diagnostics.exportJSONL().includes(restarted.discovery.token), false); result.checks.push('diagnostic export excludes bearer tokens');
  } catch (error) { result.error = { name: error.name, message: error.message }; throw error; }
  finally {
    for (const { client } of clients) await deadline(client.close(), 'client close').catch(() => {});
    if (server?.listening) await deadline(server.shutdown(), 'server close');
    for (const pipe of pipes) await deadline(pipe.close(), 'pipe close').catch(() => {});
    result.completedAtUtc = new Date().toISOString(); await mkdir('test-results', { recursive: true }); await writeFile(`test-results/pipe-integration-${Date.now()}.json`, JSON.stringify(result, null, 2));
    assert.equal(path.dirname(base), path.resolve(tmpdir())); assert.ok(path.basename(base).startsWith('tracker-production-pipe-')); await rm(base, { recursive: true, force: true });
  }
});
