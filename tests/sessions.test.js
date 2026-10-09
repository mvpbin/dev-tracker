import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

test('window switches cannot redirect bound chats, and shared-root owners do not pause each other', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dev-tracker-sessions-'));
  let server;
  try {
    const a = path.join(base, 'a'), b = path.join(base, 'b'), storage = path.join(base, 'store');
    await mkdir(a); await mkdir(b);
    server = await startServer({ storage, port: 0 });
    const wa = await server.createWindow(), wb = await server.createWindow();
    await server.selectProject(a, wa.id); await server.selectProject(b, wb.id);
    const url = `http://127.0.0.1:${server.address().port}`;
    const state = w => fetch(url + w.path + 'api/state').then(r => r.json());
    const call = async (w, args) => {
      const response = await fetch(url + w.path + 'api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...args, sessionId: (await state(w)).context.sessionId }) });
      return { status: response.status, value: await response.json() };
    };
    await Promise.all([call(wa, { action: 'rename', id: 'root', text: 'A' }), call(wb, { action: 'rename', id: 'root', text: 'B' })]);
    assert.equal((await state(wa)).nodes[0].title, 'A'); assert.equal((await state(wb)).nodes[0].title, 'B');
    const chat = await server.bindSession({ projectRoot: a, label: 'chat A' });
    await server.selectProject(b, wa.id);
    const ctx = await server.resolveContext({}, chat);
    assert.equal(ctx.getState().nodes[0].title, 'A', 'a fixed chat still resolves project A after its window switches');
    await ctx.applyAction({ action: 'add', id: 'root', text: 'one' }, 'ai');
    await ctx.applyAction({ action: 'add', id: 'root', text: 'two' }, 'ai');
    const [one, two] = ctx.getState().nodes.slice(1);
    const other = await server.bindSession({ projectRoot: a, label: 'chat A2' });
    const ctx2 = await server.resolveContext({}, other);
    await Promise.all([ctx.applyAction({ action: 'start', id: one.id }, 'ai'), ctx2.applyAction({ action: 'start', id: two.id }, 'ai')]);
    assert.equal(ctx.getState().nodes.filter(n => n.status === 'active').length, 2, 'different owners keep independent active nodes');
    await assert.rejects(ctx2.applyAction({ action: 'start', id: one.id }, 'ai'), /另一会话/);
    await assert.rejects(ctx2.applyAction({ action: 'rename', id: one.id, text: 'stolen' }, 'ai'), /另一会话/);
    await ctx2.applyAction({ action: 'record', id: one.id, text: 'User observed a problem' });
    await ctx.applyAction({ action: 'pause', id: one.id }, 'ai');
    await ctx2.applyAction({ action: 'start', id: one.id }, 'ai');
    assert.equal(ctx.getState().nodes.find(n => n.id === two.id).status, 'pending', 'starting another task pauses only this owner previous task');
    await writeFile(path.join(a, 'intent.test.cjs'), "require('node:test')('real execution', () => require('node:assert/strict').equal(2 + 2, 4));");
    const executed = await ctx2.runTests(one.id);
    assert.equal(executed.sessionId, other.sessionId);
    assert.equal(executed.passed, true);
    const change = ctx2.evidence.get().changes.find(c => c.path === 'intent.test.cjs');
    await ctx2.linkEvidence({ kind: 'file', changeId: change.id, id: one.id }, 'ai');
    assert.equal(ctx2.evidence.get().changes.find(c => c.id === change.id).association.sessionId, other.sessionId);
    await assert.rejects(server.resolveContext({}, {}), /bind_session/);
    await new Promise(resolve => server.close(resolve));
    server = await startServer({ storage, port: 0 });
    const resumed = await server.resolveContext({}, other);
    assert.equal(resumed.projectRoot, await realpath(a));
    assert.equal(resumed.getState().nodes.find(n => n.id === one.id).owner.sessionId, other.sessionId, 'session and claim survive service restart');
    assert.equal(resumed.evidence.get().tests[0].sessionId, other.sessionId, 'executed evidence preserves requesting owner across restart');
    assert.equal(resumed.evidence.get().changes.find(c => c.id === change.id).association.sessionId, other.sessionId);
    const newWindow = await server.createWindow(); await server.selectProject(a, newWindow.id);
    const restartedUrl = `http://127.0.0.1:${server.address().port}`;
    const view = await fetch(restartedUrl + newWindow.path + 'api/state').then(r => r.json());
    const pause = await fetch(restartedUrl + newWindow.path + 'api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause', id: one.id, sessionId: view.context.sessionId }) });
    assert.equal(pause.status, 200, 'the user can release an abandoned owner after restart');
    assert.equal(resumed.getState().nodes.find(n => n.id === one.id).owner, undefined);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(base), path.resolve(tmpdir())); assert.ok(path.basename(base).startsWith('dev-tracker-sessions-'));
    await rm(base, { recursive: true, force: true });
  }
});
