import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../server.js';
import { createDiagnostics } from '../diagnostics.js';

function http(url, body) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => { clearTimeout(timer); if (error) reject(error); else resolve(value); };
    const req = request(url, { agent: false, method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } : {} }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => finish(null, { status: res.statusCode, text }));
      res.on('error', error => finish(error));
    });
    const timer = setTimeout(() => req.destroy(new Error('HTTP verification deadline')), 3000);
    req.on('error', error => finish(error)); req.end(body);
  });
}
async function deadline(work, message) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 3000); })]); }
  finally { clearTimeout(timer); }
}
const rows = log => log.exportJSONL().trim().split('\n').filter(Boolean).map(JSON.parse);
async function fixture(work) {
  const base = await mkdtemp(path.join(tmpdir(), 'dev-tracker-release-connection-'));
  try { await work(base); }
  finally {
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    assert.ok(path.basename(base).startsWith('dev-tracker-release-connection-'));
    await rm(base, { recursive: true, force: true });
  }
}

test('an occupied fixed port reports the failure and preserves the service already using it', () => fixture(async base => {
  const occupant = createServer((_, res) => res.end('occupant-still-serving'));
  await new Promise(resolve => occupant.listen(0, '127.0.0.1', resolve));
  const port = occupant.address().port, diagnostics = createDiagnostics();
  let unexpected;
  try {
    await assert.rejects(startServer({ storage: path.join(base, 'store'), port, diagnostics }).then(server => { unexpected = server; }), error => error.code === 'EADDRINUSE');
    assert.equal((await http(`http://127.0.0.1:${port}/`)).text, 'occupant-still-serving', 'startup must not stop or replace the port owner');
    assert.ok(rows(diagnostics).some(row => row.event === 'error' && row.stage === 'server' && row.code === 'EADDRINUSE'), 'exportable diagnostics must preserve the observed startup failure');
  } finally {
    if (unexpected) await unexpected.shutdown().catch(() => {});
    await new Promise(resolve => occupant.close(resolve));
  }
}));

test('an incomplete HTTP body cannot hold record backups open before business work begins', () => fixture(async base => {
  const server = await startServer({ storage: path.join(base, 'store'), port: 0 });
  const url = `http://127.0.0.1:${server.address().port}`;
  let incomplete;
  try {
    const context = JSON.parse((await http(url + '/api/state')).text).context;
    const body = JSON.stringify({ id: 'root', action: 'rename', text: 'late-private-change', sessionId: context.sessionId });
    incomplete = request(url + '/api/action', { agent: false, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    incomplete.on('error', () => {});
    const response = new Promise((resolve, reject) => { incomplete.once('response', res => { res.resume(); res.once('end', () => resolve(res.statusCode)); }); incomplete.once('error', reject); });
    response.catch(() => {});
    const connected = new Promise(resolve => incomplete.once('socket', socket => socket.once('connect', resolve)));
    const headersReceived = new Promise(resolve => server.once('request', resolve));
    incomplete.write('{'); await deadline(Promise.all([connected, headersReceived]), 'incomplete request headers deadline');
    let timer;
    try {
      await Promise.race([server.backupRecords(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('incomplete HTTP body blocked backup')), 1500); })]);
    } finally { clearTimeout(timer); }
    assert.equal((await http(url + '/api/connection')).status, 200, 'maintenance admission must reopen after backup');
    const archive = await server.backupRecords();
    await server.restoreRecords(archive);
    incomplete.end(body.slice(1));
    assert.equal(await deadline(response, 'late body response deadline'), 500, 'a body admitted before restore must not gain permission to mutate the restored records');
  } finally { incomplete?.destroy(); server.closeAllConnections(); await deadline(server.shutdown(), 'shutdown cleanup deadline'); }
}));

test('shutdown drains storage and releases its port so a fresh server can reopen the same address', () => fixture(async base => {
  const storage = path.join(base, 'store'), diagnostics = createDiagnostics();
  let server = await startServer({ storage, port: 0, diagnostics });
  const port = server.address().port, url = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await http(url + '/api/connection')).status, 200);
    await server.shutdown();
    assert.equal(server.listening, false, 'the application must release the listener before reporting shutdown');
    assert.ok(rows(diagnostics).some(row => row.event === 'close'), 'the export must distinguish a completed listener close');
    server = await startServer({ storage, port, diagnostics });
    assert.equal((await http(url + '/api/connection')).status, 200, 'reopening must use the released port successfully');
    assert.equal(rows(diagnostics).filter(row => row.event === 'listen').length, 2);
  } finally { if (server.listening) await server.shutdown(); }
}));

test('MCP response diagnostics identify timing and status without exporting window identities or project payloads', () => fixture(async base => {
  const diagnostics = createDiagnostics();
  const project = path.join(base, 'private-project-marker'); await mkdir(project);
  const server = await startServer({ storage: path.join(base, 'store'), port: 0, diagnostics });
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'release-diagnostic-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp')));
    const bindingResult = await client.callTool({ name: 'bind_session', arguments: { projectRoot: project, label: 'private-label-marker' } });
    assert.notEqual(bindingResult.isError, true, bindingResult.content[0].text);
    const binding = JSON.parse(bindingResult.content[0].text);
    const handoff = await client.callTool({ name: 'get_handoff', arguments: { sessionId: binding.sessionId } });
    assert.notEqual(handoff.isError, true, handoff.content[0].text);
    assert.equal(JSON.parse(handoff.content[0].text).snapshot.project.root, project);
    const window = await server.createWindow();
    await http(url + `/w/${window.id}/mcp`, JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name: 'get_map', arguments: { sessionId: 'private-session-marker', payload: 'private-body-marker' } } }));
    const exported = diagnostics.exportJSONL(), calls = rows(diagnostics).filter(row => row.event === 'mcp_http');
    assert.ok(calls.some(row => row.method === 'POST' && row.status === 200), 'a finished MCP response must produce an HTTP outcome');
    for (const row of calls) {
      assert.deepEqual(Object.keys(row), ['time', 'event', 'stage', 'method', 'status', 'durationMs']);
      assert.equal(row.stage, 'mcp'); assert.ok(row.durationMs >= 0);
    }
    for (const privateValue of [window.id, binding.sessionId, 'private-project-marker', 'private-label-marker', 'private-session-marker', 'private-body-marker']) assert.equal(exported.includes(privateValue), false, 'connection exports must not carry identities or project data');
  } finally { await client.close(); await server.shutdown(); }
}));
