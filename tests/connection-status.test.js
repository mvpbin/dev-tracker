import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../server.js';
import packageInfo from '../package.json' with { type: 'json' };

test('connection reports only observed MCP calls for the displayed project and resets on restart', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dev-tracker-connection-'));
  const a = path.join(base, 'a'), b = path.join(base, 'b'), storage = path.join(base, 'store');
  await mkdir(a); await mkdir(b);
  let server = await startServer({ storage, port: 0 });
  let url = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'connection-test', version: '1' });
  const connection = (prefix = '') => fetch(url + prefix + '/api/connection').then(r => r.json());
  const tool = (name, args = {}) => client.callTool({ name, arguments: args });
  const bind = async (projectRoot, label) => JSON.parse((await tool('bind_session', { projectRoot, label })).content[0].text);
  try {
    const empty = await connection();
    assert.equal(empty.mcp, true); assert.equal(empty.version, packageInfo.version);
    assert.deepEqual(empty.sessions, [], 'a window binding alone cannot imply AI activity');
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp')));
    assert.equal((await tool('get_map', { sessionId: 'unknown' })).isError, true);
    assert.equal((await tool('bind_session', { projectRoot: path.join(base, 'missing'), label: 'Invalid' })).isError, true);
    assert.deepEqual((await connection()).sessions, [], 'unbound failures cannot be attributed to the current project');
    const sa = await bind(a, 'Chat A'), sb = await bind(b, 'Chat B'), sa2 = await bind(a, 'Chat A2');
    await server.selectProject(a);
    let state = await connection();
    assert.deepEqual(state.sessions.map(s => s.sessionId), [sa2.sessionId, sa.sessionId]);
    assert.notEqual(state.sessionId, sa.sessionId, 'the API retains the independent window identity');
    assert.deepEqual(Object.keys(state.sessions[0]).sort(), ['label', 'lastCallAt', 'pending', 'sessionId', 'status', 'tool']);
    assert.equal(state.sessions[0].tool, 'bind_session'); assert.equal(state.sessions[0].status, 'success');
    assert.ok(Number.isFinite(Date.parse(state.sessions[0].lastCallAt)));
    assert.equal((await tool('get_node', { sessionId: sa.sessionId, id: 'missing-private-id' })).isError, true);
    state = await connection();
    assert.equal(state.sessions[0].sessionId, sa.sessionId); assert.equal(state.sessions[0].status, 'error');
    assert.equal(state.sessions[0].pending, 0);
    const before = JSON.stringify(state.sessions);
    await tool('get_map', { sessionId: 'unknown' });
    assert.equal((await tool('get_node', { sessionId: sa.sessionId, id: 123 })).isError, true);
    const response = await fetch(url + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: '{}' });
    assert.equal(response.status, 403);
    assert.equal(JSON.stringify((await connection()).sessions), before, 'rejected calls must not fabricate activity');
    const gate = path.join(base, 'release');
    await writeFile(path.join(a, 'wait.test.cjs'), `const fs = require('node:fs'); require('node:test')('wait', async () => { const end = Date.now() + 5000; while (!fs.existsSync(${JSON.stringify(gate)})) { if (Date.now() > end) throw new Error('gate timeout'); await new Promise(r => setTimeout(r, 10)); } });`);
    const running = tool('run_tests', { sessionId: sa.sessionId, id: 'root' });
    try {
      const deadline = Date.now() + 3000;
      while ((await connection()).sessions[0].pending !== 1) {
        assert.ok(Date.now() < deadline, 'the running call must become observable before completion');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await tool('get_node', { sessionId: sa.sessionId, id: 'missing' });
      const active = (await connection()).sessions[0];
      assert.equal(active.status, 'running'); assert.equal(active.pending, 1); assert.equal(active.tool, 'get_node');
    } finally { await writeFile(gate, 'release'); await running; }
    const completed = (await connection()).sessions[0];
    assert.equal(completed.status, 'error', 'an older call finishing last must not overwrite the latest tool result');
    assert.equal(completed.pending, 0);
    const window = await server.createWindow();
    await server.selectProject(b, window.id);
    assert.deepEqual((await connection(`/w/${window.id}`)).sessions.map(s => s.sessionId), [sb.sessionId]);
    await client.close(); await server.shutdown();
    server = await startServer({ storage, port: 0 }); url = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual((await connection()).sessions, [], 'persisted bindings are not observed calls in a new server lifetime');
  } finally {
    await client.close(); await server.shutdown();
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    await rm(base, { recursive: true, force: true });
  }
});
