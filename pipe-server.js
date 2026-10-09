import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { protectDirectory, writeDiscovery, removeDiscovery } from './pipe-config.js';

function validDiscovery(value) {
  return value?.version === 1 && /^[0-9a-f-]{36}$/.test(value.runId || '') && value.pipePath === `\\\\.\\pipe\\dev-tracker-${value.runId}` && /^[0-9a-f]{64}$/.test(value.token || '');
}

async function checkPrevious(directory) {
  let previous;
  try { previous = JSON.parse(await readFile(path.join(directory, 'discovery.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!validDiscovery(previous)) throw new Error('Existing pipe discovery is invalid; refusing to replace it');
  await new Promise((resolve, reject) => {
    const request = http.request({ socketPath: previous.pipePath, path: '/mcp', method: 'GET', headers: { Host: 'localhost', Authorization: `Bearer ${previous.token}` }, agent: false }, response => {
      response.resume();
      const error = new Error(response.statusCode === 405 ? 'An authenticated pipe coordinator is already running' : `Existing pipe discovery returned unexpected status ${response.statusCode}`);
      error.code = response.statusCode === 405 ? 'EADDRINUSE' : 'EPIPE';
      request.destroy(); reject(error);
    });
    const timer = setTimeout(() => { const error = new Error('Existing pipe discovery probe timed out; refusing to replace it'); error.code = 'ETIMEDOUT'; request.destroy(error); }, 1000);
    request.once('close', () => clearTimeout(timer));
    request.once('error', error => { if (error.code === 'ENOENT') resolve(); else reject(error); });
    request.end();
  });
}

/**
 * Attach an authenticated named-pipe listener to the shared HTTP coordinator.
 * The caller must hold exclusive single-instance ownership for `directory` and
 * the shared server; this function does not provide a cross-process lock.
 */
export async function startPipeServer(server, { directory }) {
  const handler = server.listeners('request')[0];
  if (typeof handler !== 'function') throw new Error('The shared HTTP server has no request handler');
  const acl = await protectDirectory(directory);
  await checkPrevious(directory);
  const runId = randomUUID(), token = randomBytes(32).toString('hex');
  const discovery = { version: 1, runId, pipePath: `\\\\.\\pipe\\dev-tracker-${runId}`, token, pid: process.pid };
  const expected = Buffer.from(`Bearer ${token}`);
  const pipe = http.createServer((req, res) => {
    const received = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) { res.writeHead(401); res.end(); return; }
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return; }
    handler(req, res);
  });
  await new Promise((resolve, reject) => { pipe.once('error', reject); pipe.listen(discovery.pipePath, resolve); });
  let configPath;
  try { configPath = await writeDiscovery(directory, discovery); }
  catch (error) { await new Promise(resolve => pipe.close(resolve)); throw error; }
  let closing;
  const close = () => closing ||= (async () => {
    // The coordinator must drain business operations before force-closing pipe HTTP bodies.
    await new Promise((resolve, reject) => { pipe.close(error => error ? reject(error) : resolve()); pipe.closeAllConnections(); });
    try { await removeDiscovery(configPath, runId); }
    catch (error) { return { cleanupWarning: error.code || 'DISCOVERY_CLEANUP_FAILED' }; }
  })();
  return { configPath, discovery, close, acl };
}
