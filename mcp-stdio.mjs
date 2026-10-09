import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createPipeFetch, validatePipeConfig } from './pipe-fetch.js';

export async function runStdioBridge(argv) {
  const client = new Client({ name: 'dev-tracker-stdio', version: '1' });
  const lifecycle = new AbortController();
  let server, closing, code = 0, complete;
  const closed = new Promise(resolve => { complete = resolve; });
  const report = phase => process.stderr.write(`Dev Tracker MCP ${phase} failed\n`);
  const stop = () => {
    lifecycle.abort();
    if (!closing) closing = Promise.resolve().then(() => Promise.allSettled([client.close(), server?.close()])).then(() => { process.stdin.pause(); complete(); });
    return closing;
  };
  const outputError = () => { code = 1; report('output'); void stop(); };
  process.stdin.once('end', stop); process.stdin.once('close', stop);
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.stdout.once('error', outputError);
  try {
    if (argv.length !== 2 || argv[0] !== '--config') throw new Error('Explicit --config path required');
    const config = validatePipeConfig(JSON.parse(await readFile(argv[1], 'utf8')));
    const pipeFetch = createPipeFetch(config);
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: (input, init = {}) => pipeFetch(input, { ...init, signal: AbortSignal.any([lifecycle.signal, ...(init.signal ? [init.signal] : [])]) }) });
    let ready, failed;
    const upstream = new Promise((resolve, reject) => { ready = resolve; failed = reject; }); upstream.catch(() => {});
    server = new Server({ name: 'dev-tracker-stdio', version: '1' }, { capabilities: { tools: {} }, instructions: 'First bind_session with the actual projectRoot and chat label; pass sessionId on every subsequent tool call. Read get_handoff and verify its project root before work.' });
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => { await upstream; return client.listTools(request.params, { signal: extra.signal }); });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => { await upstream; return client.callTool(request.params, undefined, { signal: extra.signal }); });
    server.onerror = () => { report('protocol'); };
    server.onclose = stop; client.onclose = stop;
    client.onerror = () => { if (!lifecycle.signal.aborted) { code = 1; report('connection'); void stop(); } };
    await server.connect(new StdioServerTransport());
    client.connect(transport).then(ready, failed);
    await upstream;
    await closed;
  } catch { if (!lifecycle.signal.aborted) { code = 1; report('startup'); } await stop(); }
  finally { process.stdin.off('end', stop); process.stdin.off('close', stop); process.off('SIGINT', stop); process.off('SIGTERM', stop); process.stdout.off('error', outputError); }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runStdioBridge(process.argv.slice(2));
