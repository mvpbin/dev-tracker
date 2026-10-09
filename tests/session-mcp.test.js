import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../server.js';

test('explicit chat bindings survive UI switches and keep parallel task ownership separate', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dev-tracker-session-mcp-'));
  const a = path.join(base, 'a'), b = path.join(base, 'b');
  await mkdir(a); await mkdir(b);
  const server = await startServer({ storage: path.join(base, 'store'), port: 0 });
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = [new Client({ name: 'chat-a', version: '1' }), new Client({ name: 'chat-b', version: '1' })];
  const decode = result => { assert.notEqual(result.isError, true, result.content[0].text); return JSON.parse(result.content[0].text); };
  const bind = async (client, root, label) => decode(await client.callTool({ name: 'bind_session', arguments: { projectRoot: root, label } }));
  const call = async (client, sessionId, name, args = {}) => client.callTool({ name, arguments: { ...args, sessionId } });
  try {
    for (const client of clients) await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp')));
    assert.equal((await clients[0].callTool({ name: 'get_map', arguments: {} })).isError, true);
    assert.equal((await call(clients[0], 'unknown', 'get_map')).isError, true);
    const sa = await bind(clients[0], a, 'Chat A'), sb = await bind(clients[1], b, 'Chat B');
    await Promise.all([
      call(clients[0], sa.sessionId, 'update_node', { id: 'root', action: 'add', text: 'A work' }).then(decode),
      call(clients[1], sb.sessionId, 'update_node', { id: 'root', action: 'add', text: 'B work' }).then(decode)
    ]);
    await server.selectProject(b);
    const ma = decode(await call(clients[0], sa.sessionId, 'get_map'));
    const mb = decode(await call(clients[1], sb.sessionId, 'get_map'));
    assert.equal(ma[1].title, 'A work', 'changing the default UI project must not redirect another chat');
    assert.equal(mb[1].title, 'B work');
    const transfer = decode(await call(clients[0], sa.sessionId, 'get_handoff'));
    assert.equal(transfer.context.projectRoot.toLowerCase(), a.toLowerCase());
    assert.equal(transfer.context.sessionId, sa.sessionId);
    assert.match(transfer.markdown, /sessionId/);
    const sbSame = await bind(clients[1], a, 'Chat B same project');
    decode(await call(clients[0], sa.sessionId, 'update_node', { id: ma[1].id, action: 'start' }));
    const conflict = await call(clients[1], sbSame.sessionId, 'update_node', { id: ma[1].id, action: 'start' });
    assert.equal(conflict.isError, true, 'parallel chats must not silently steal an active task');
    decode(await call(clients[1], sbSame.sessionId, 'update_node', { id: 'root', action: 'add', text: 'Separate task' }));
    const map = decode(await call(clients[0], sa.sessionId, 'get_map'));
    decode(await call(clients[1], sbSame.sessionId, 'update_node', { id: map[2].id, action: 'start' }));
    const active = decode(await call(clients[0], sa.sessionId, 'get_map')).filter(n => n.status === 'active');
    assert.equal(active.length, 2, 'starting another chat task must not pause existing work');
    assert.equal(new Set(active.map(n => n.owner.sessionId)).size, 2);
    assert.equal((await call(clients[1], sbSame.sessionId, 'update_node', { id: ma[1].id, action: 'record', text: 'Wrong owner' })).isError, true);
  } finally {
    for (const client of clients) await client.close();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    await rm(base, { recursive: true, force: true });
  }
});
