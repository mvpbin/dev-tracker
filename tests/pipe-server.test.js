import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { startServer } from '../server.js';
import { startPipeServer } from '../pipe-server.js';

function request(discovery, url, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: discovery.pipePath, path: url, method: body ? 'POST' : 'GET', agent: false, headers: { Host: 'localhost', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } : {}) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('authenticated pipe shares the existing coordinator state and rejects foreign requests before mutation', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'tracker-pipe-production-'));
  let server, pipe;
  try {
    server = await startServer({ storage: path.join(base, 'records'), port: 0 });
    pipe = await startPipeServer(server, { directory: path.join(base, 'discovery') });
    assert.equal(pipe.acl.platform, 'win32');
    assert.equal(pipe.acl.protected, true);
    assert.ok(pipe.acl.rules.every(rule => rule.sid === pipe.acl.accountSid && rule.type === 'Allow'));
    assert.equal((await request(pipe.discovery, '/mcp')).status, 401);
    assert.equal((await request(pipe.discovery, '/mcp', 'foreign')).status, 401);
    assert.equal((await request(pipe.discovery, '/api/state', pipe.discovery.token)).status, 404);
    assert.equal((await request(pipe.discovery, '/mcp', pipe.discovery.token)).status, 405);
    const context = await server.resolveContext({ trackerWindowId: 'default' });
    await context.applyAction({ action: 'rename', id: 'root', text: 'shared coordinator' });
    const unauthorized = await request(pipe.discovery, '/mcp', 'foreign', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'update_node', arguments: { sessionId: context.sessionId, id: 'root', action: 'rename', text: 'unauthorized change' } } });
    assert.equal(unauthorized.status, 401);
    assert.equal(context.getState().nodes[0].title, 'shared coordinator', 'foreign pipe credentials cannot mutate the shared records');
    const reply = await request(pipe.discovery, '/mcp', pipe.discovery.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_map', arguments: { sessionId: context.sessionId } } });
    assert.equal(reply.status, 200);
    assert.equal(JSON.parse(JSON.parse(reply.text).result.content[0].text)[0].title, 'shared coordinator', 'pipe reads the same in-memory map updated through the HTTP coordinator');
    assert.equal(JSON.parse(await readFile(pipe.configPath, 'utf8')).runId, pipe.discovery.runId);
    await pipe.close(); await assert.rejects(readFile(pipe.configPath), { code: 'ENOENT' });
  } finally { if (pipe) await pipe.close(); if (server?.listening) await server.shutdown(); await rm(base, { recursive: true, force: true }); }
});

test('live discovery cannot be overwritten and stale crash discovery rotates without removing records', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'tracker-pipe-rotation-'));
  let server, first, second;
  try {
    server = await startServer({ storage: path.join(base, 'records'), port: 0 });
    const directory = path.join(base, 'discovery');
    first = await startPipeServer(server, { directory });
    await assert.rejects(startPipeServer(server, { directory }), { code: 'EADDRINUSE' });
    assert.equal(JSON.parse(await readFile(first.configPath, 'utf8')).runId, first.discovery.runId);
    await first.close();
    await writeFile(first.configPath, JSON.stringify(first.discovery));
    second = await startPipeServer(server, { directory });
    assert.notEqual(first.discovery.token, second.discovery.token);
    assert.notEqual(first.discovery.pipePath, second.discovery.pipePath);
    assert.equal(JSON.parse(await readFile(second.configPath, 'utf8')).runId, second.discovery.runId, 'an older owner cannot delete the replacement discovery');
    assert.equal((await request(second.discovery, '/mcp', first.discovery.token)).status, 401);
    assert.ok(await readFile(path.join(base, 'records', 'sessions.json'), 'utf8'));
  } finally { if (first) await first.close(); if (second) await second.close(); if (server?.listening) await server.shutdown(); await rm(base, { recursive: true, force: true }); }
});

test('closing after the coordinator drain bounds incomplete bodies and cannot write a late mutation', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'tracker-pipe-body-'));
  let server, pipe, incomplete;
  try {
    const storage = path.join(base, 'records');
    server = await startServer({ storage, port: 0 });
    pipe = await startPipeServer(server, { directory: path.join(base, 'discovery') });
    const session = await server.bindSession({ projectRoot: base, label: 'body close test' });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'update_node', arguments: { sessionId: session.sessionId, id: 'root', action: 'rename', text: 'must never arrive' } } });
    incomplete = http.request({ socketPath: pipe.discovery.pipePath, path: '/mcp', method: 'POST', agent: false, headers: { Host: 'localhost', Authorization: `Bearer ${pipe.discovery.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    incomplete.on('error', () => {});
    const connected = new Promise(resolve => incomplete.once('socket', socket => socket.once('connect', resolve)));
    incomplete.write('{'); await connected;
    await server.shutdown();
    await pipe.close();
    assert.equal(incomplete.destroyed, true, 'force close is applied only after central business writes have drained');
    server = await startServer({ storage, port: 0 });
    assert.notEqual((await server.resolveContext({}, session)).getState().nodes[0].title, 'must never arrive');
  } finally { incomplete?.destroy(); if (pipe) await pipe.close(); if (server?.listening) await server.shutdown(); await rm(base, { recursive: true, force: true }); }
});

test('closed pipe remains closed when its own discovery file is malformed, with a repeatable generic cleanup warning', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'tracker-pipe-cleanup-'));
  let server, pipe;
  try {
    server = await startServer({ storage: path.join(base, 'records'), port: 0 });
    pipe = await startPipeServer(server, { directory: path.join(base, 'discovery') });
    await writeFile(pipe.configPath, '{malformed');
    const first = await pipe.close();
    assert.deepEqual(first, { cleanupWarning: 'DISCOVERY_CLEANUP_FAILED' });
    assert.deepEqual(await pipe.close(), first, 'close is idempotent after the listener is closed');
    await assert.rejects(request(pipe.discovery, '/mcp', pipe.discovery.token));
    assert.equal(JSON.stringify(first).includes(pipe.discovery.token), false, 'cleanup warnings cannot expose bearer credentials');
  } finally { if (pipe) await pipe.close(); if (server?.listening) await server.shutdown(); await rm(base, { recursive: true, force: true }); }
});
