import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createPipeFetch, validatePipeConfig } from '../pipe-fetch.js';

test('pipe fetch authenticates the fixed endpoint and rejects routing or oversized input before sending', async () => {
  const runId = randomUUID(), pipePath = '\\\\.\\pipe\\dev-tracker-' + runId, token = 'a'.repeat(64);
  const config = validatePipeConfig({ version: 1, runId, pipePath, token });
  let requests = 0;
  const server = createServer((request, response) => { requests++; assert.equal(request.headers.authorization, 'Bearer ' + token); assert.equal(request.url, '/mcp'); response.writeHead(204); response.end(); });
  await new Promise(resolve => server.listen(pipePath, resolve));
  try {
    const fetch = createPipeFetch(config);
    assert.equal((await fetch('http://localhost/mcp', { method: 'DELETE', headers: { authorization: 'wrong' } })).status, 204);
    await assert.rejects(fetch('http://127.0.0.1/mcp'), /URL/);
    await assert.rejects(fetch('http://localhost/mcp', { method: 'PUT' }), /method/);
    await assert.rejects(fetch('http://localhost/mcp', { method: 'POST', body: 'x'.repeat(100 * 1024 + 1) }), /limit/);
    assert.equal(requests, 1, 'rejected inputs must not initiate requests or retry');
    assert.throws(() => validatePipeConfig({ ...config, runId: randomUUID() }), /configuration/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('closing stdin cancels hung pipe initialization and returns without leaking credentials or protocol output', { timeout: 10000 }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'dev-tracker-pipe-bridge-'));
  const runId = randomUUID(), pipePath = '\\\\.\\pipe\\dev-tracker-' + runId, token = 'b'.repeat(64);
  const configFile = path.join(folder, 'discovery.json');
  await writeFile(configFile, JSON.stringify({ version: 1, runId, pipePath, token }));
  const server = createServer(() => {}); let child, timer;
  await new Promise(resolve => server.listen(pipePath, resolve));
  try {
    const received = once(server, 'request');
    child = spawn(process.execPath, ['mcp-stdio.mjs', '--config', configFile], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    await received;
    const closed = once(child, 'exit'), started = Date.now(); child.stdin.end();
    const [code] = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Bridge remained alive after EOF')), 2000); })]);
    assert.equal(code, 0, 'EOF is a normal lifecycle shutdown even during initialization');
    assert.ok(Date.now() - started < 2000); assert.equal(stdout, ''); assert.equal(stderr.includes(token), false);
  } finally { clearTimeout(timer); if (child?.exitCode === null) child.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(folder, { recursive: true, force: true }); }
});
