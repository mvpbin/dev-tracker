import http from 'node:http';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const PIPE = new RegExp('^' + String.raw`\\\\\.\\pipe\\dev-tracker-` + UUID + '$');
const MAX_RESPONSE = 8 * 1024 * 1024;

export function validatePipeConfig(config) {
  if (!config || config.version !== 1 || typeof config.runId !== 'string' || !new RegExp('^' + UUID + '$').test(config.runId) || config.pipePath !== '\\\\.\\pipe\\dev-tracker-' + config.runId || typeof config.token !== 'string' || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid MCP pipe configuration');
  return config;
}

export function createPipeFetch({ pipePath, token }) {
  if (typeof pipePath !== 'string' || PIPE.exec(pipePath)?.[0] !== pipePath || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid MCP pipe credentials');
  return async (input, init = {}) => {
    if (new URL(input instanceof URL ? input : String(input)).href !== 'http://localhost/mcp') throw new Error('Invalid MCP pipe URL');
    const method = String(init.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'DELETE'].includes(method)) throw new Error('Invalid MCP pipe method');
    if (init.body != null && typeof init.body !== 'string' && !Buffer.isBuffer(init.body)) throw new Error('Invalid MCP request body');
    const body = init.body == null ? null : Buffer.from(init.body);
    if (body?.length > 100 * 1024) throw new Error('MCP request body exceeds limit');
    const headers = new Headers(init.headers || {});
    headers.set('host', 'localhost'); headers.set('authorization', 'Bearer ' + token);
    const signal = init.signal;
    if (signal?.aborted) throw new DOMException('MCP request aborted', 'AbortError');
    return new Promise((resolve, reject) => {
      let settled = false, size = 0;
      const request = http.request({ socketPath: pipePath, path: '/mcp', method, headers: Object.fromEntries(headers), agent: false }, response => {
        const chunks = [];
        response.on('data', chunk => { size += chunk.length; if (size > MAX_RESPONSE) request.destroy(new Error('MCP response exceeds limit')); else chunks.push(chunk); });
        response.once('end', () => {
          if (settled) return;
          try { const result = new Response([204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks), { status: response.statusCode, statusText: response.statusMessage, headers: response.headers }); settled = true; resolve(result); }
          catch (error) { settled = true; reject(error); }
        });
        response.once('error', error => { if (!settled) { settled = true; reject(error); } });
        response.once('aborted', () => request.destroy(new Error('MCP response aborted')));
      });
      const abort = () => request.destroy(new DOMException('MCP request aborted', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => request.destroy(new Error('MCP pipe request deadline exceeded')), 150000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      request.once('error', error => { cleanup(); if (!settled) { settled = true; reject(error); } }); request.once('close', cleanup);
      if (body) request.write(body);
      request.end();
    });
  };
}
