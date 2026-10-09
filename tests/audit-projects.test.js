import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

async function fixture(work) {
  const base = await mkdtemp(path.join(tmpdir(), 'dev-tracker-audit-projects-'));
  let server;
  const storage = path.join(base, 'store'), a = path.join(base, 'a'), b = path.join(base, 'b');
  try {
    await Promise.all([mkdir(storage), mkdir(a), mkdir(b)]);
    await work({ base, storage, a, b, start: async () => {
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      server = await startServer({ storage, port: 0 });
      return server;
    } });
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    assert.ok(path.basename(base).startsWith('dev-tracker-audit-projects-'));
    await rm(base, { recursive: true, force: true });
  }
}

test('the first MCP binding adopts legacy requirements before AI writes and survives UI selection and restart', async () => fixture(async ({ storage, a, b, start }) => {
  const legacy = JSON.stringify({ nodes: [{ id: 'root', parent: null, title: 'Existing map', status: 'idle', tasks: [{ text: 'Original requirement' }], notes: [] }], events: [] });
  await writeFile(path.join(storage, 'project.json'), legacy);
  let server = await start();
  const session = await server.bindSession({ projectRoot: a, label: 'First AI' });
  assert.equal(JSON.parse(await readFile(path.join(storage, 'active-project.json'), 'utf8')).root.toLowerCase(), a.toLowerCase(), 'MCP adoption records the first project even before UI selection');
  let context = await server.resolveContext({}, session);
  assert.equal(context.getState().nodes[0].title, 'Existing map', 'binding must expose existing requirements before the AI can overwrite them');
  await context.applyAction({ action: 'add', id: 'root', text: 'AI addition' }, 'ai');
  await server.selectProject(a);
  assert.equal(context.getState().nodes[1].title, 'AI addition', 'later UI selection must preserve edits made through MCP');
  const other = await server.bindSession({ projectRoot: b, label: 'Other AI' });
  assert.equal((await server.resolveContext({}, other)).getState().nodes[0].tasks.length, 0, 'legacy requirements belong to only the first successful project');
  assert.equal(await readFile(path.join(storage, 'project.json'), 'utf8'), legacy, 'adoption preserves the original backup');
  server = await start();
  context = await server.resolveContext({}, session);
  assert.equal(context.getState().nodes[0].tasks[0].text, 'Original requirement');
  assert.equal(context.getState().nodes[1].title, 'AI addition');
}));

test('a failed first MCP binding does not capture the unassigned map or project pointer', async () => fixture(async ({ storage, base, a, start }) => {
  await writeFile(path.join(storage, 'project.json'), JSON.stringify({ nodes: [{ id: 'root', parent: null, title: 'Before failure', status: 'idle', tasks: [], notes: [] }], events: [] }));
  const candidate = path.join(base, 'file'); await writeFile(candidate, 'not a directory');
  const server = await start();
  await assert.rejects(server.bindSession({ projectRoot: candidate, label: 'Invalid' }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const initial = await fetch(url + '/api/state').then(response => response.json());
  const response = await fetch(url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rename', id: 'root', text: 'After failure', sessionId: initial.context.sessionId }) });
  assert.equal(response.status, 200);
  const session = await server.bindSession({ projectRoot: a, label: 'Valid' });
  assert.equal((await server.resolveContext({}, session)).getState().nodes[0].title, 'After failure', 'retry must adopt the latest unassigned edits');
}));

test('HTTP writes reject missing or obsolete window identities instead of changing the newly selected project', async () => fixture(async ({ a, b, start }) => {
  const server = await start(), url = `http://127.0.0.1:${server.address().port}`;
  await server.selectProject(a);
  const old = await fetch(url + '/api/state').then(response => response.json());
  await server.selectProject(b);
  const current = await fetch(url + '/api/state').then(response => response.json());
  await writeFile(path.join(b, 'intent.test.cjs'), "require('node:test')('intent', () => require('node:assert/strict').equal(2 + 2, 4));");
  await server.evidence.scan();
  const changeId = server.evidence.get().changes[0].id;
  const requests = [
    ['action', { action: 'rename', id: 'root', text: 'Intended for old project' }],
    ['tests', { id: 'root' }],
    ['evidence/link', { kind: 'file', changeId, id: 'root' }]
  ];
  for (const [endpoint, body] of requests) {
    for (const identity of [{}, { sessionId: old.context.sessionId }]) {
      const response = await fetch(url + '/api/' + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...identity }) });
      assert.equal(response.status, 409, `${endpoint} must reject stale/missing UI identity`);
      assert.match((await response.json()).error, /项目|会话/);
    }
  }
  assert.deepEqual((await fetch(url + '/api/state').then(response => response.json())).nodes, current.nodes, 'rejected old actions cannot rename or add requirements to the new map');
  assert.equal(server.evidence.get().tests.length, 0, 'old UI requests cannot execute tests in another project');
  assert.equal(server.evidence.get().changes[0].node, null, 'old UI requests cannot attach another project changes');
  const accepted = await fetch(url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rename', id: 'root', text: 'Current project', sessionId: current.context.sessionId }) });
  assert.equal(accepted.status, 200, 'the current window can still save normally');
}));
