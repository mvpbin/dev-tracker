import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { createEvidence } from '../evidence.js';

test('folder identity keeps maps, associations and executed evidence independent across restart', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dev-tracker-projects-'));
  let server;
  try {
    const a = path.join(base, 'a'), b = path.join(base, 'b'), storage = path.join(a, 'nested', 'store');
    await mkdir(storage, { recursive: true }); await mkdir(b);
    const legacy = { nodes: [{ id: 'root', parent: null, title: 'Legacy', status: 'pending', tasks: [{ text: 'Original requirement' }], notes: [] }], events: [] };
    await writeFile(path.join(storage, 'project.json'), JSON.stringify(legacy));
    const tracker = await createEvidence(storage);
    await tracker.select(a);
    await writeFile(path.join(a, 'code.js'), 'module.exports = 1'); await tracker.scan();
    const changeId = tracker.get().changes[0].id;
    await tracker.link('file', changeId, 'root', 'manual');
    const originalEvidence = await readFile(path.join(storage, 'evidence.json'), 'utf8');
    server = await startServer({ storage, port: 0 });
    let url = `http://127.0.0.1:${server.address().port}`;
    const state = () => fetch(url + '/api/state').then(r => r.json());
    const action = async title => fetch(url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rename', id: 'root', text: title, sessionId: (await state()).context.sessionId }) }).then(r => r.json());
    assert.equal((await state()).nodes[0].title, 'Legacy');
    assert.equal(server.evidence.get().root, await realpath(a));
    await server.evidence.select(a);
    assert.equal(server.evidence.get().changes.find(c => c.id === changeId).node, 'root');
    await action('Project A');
    await assert.rejects(server.selectProject(storage), /框架记录目录/);
    await assert.rejects(server.selectProject(path.join(storage, 'projects')), /框架记录目录/);
    assert.equal((await state()).nodes[0].title, 'Project A', 'managed storage cannot become the active project or replace its map');
    assert.equal(server.evidence.get().root, await realpath(a));
    await server.selectProject(b);
    assert.equal((await state()).nodes[0].tasks.length, 0, 'a new folder does not inherit another folder requirements');
    assert.equal(server.evidence.get().changes.length, 0);
    await action('Project B');
    await assert.rejects(server.selectProject(path.join(base, 'missing')));
    assert.equal((await state()).nodes[0].title, 'Project B', 'failed selection leaves the active map intact');
    await new Promise(resolve => server.close(resolve));
    server = await startServer({ storage, port: 0 }); url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await state()).nodes[0].title, 'Project B');
    assert.equal(server.evidence.get().root, await realpath(b));
    await server.evidence.select(a);
    assert.equal((await state()).nodes[0].title, 'Project A');
    assert.equal(server.evidence.get().changes.find(c => c.id === changeId).node, 'root');
    await writeFile(path.join(a, 'slow.test.cjs'), "require('node:test')('wait', async () => { await new Promise(r => setTimeout(r, 150)); });");
    const run = server.evidence.run('root');
    await assert.rejects(server.selectProject(b), /测试运行期间/);
    assert.equal((await run).passed, true);
    await server.selectProject(b); assert.equal(server.evidence.get().tests.length, 0);
    await server.selectProject(a); assert.equal(server.evidence.get().tests.length, 1);
    assert.ok(server.evidence.get().changes.every(c => !c.path.startsWith('nested/store/')), 'partition writes are excluded from project evidence');
    assert.equal(await readFile(path.join(storage, 'project.json'), 'utf8'), JSON.stringify(legacy), 'migration preserves original map');
    assert.equal(await readFile(path.join(storage, 'evidence.json'), 'utf8'), originalEvidence, 'migration preserves original evidence');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(base), path.resolve(tmpdir())); assert.ok(path.basename(base).startsWith('dev-tracker-projects-'));
    await rm(base, { recursive: true, force: true });
  }
});

test('first folder adopts an unassigned legacy map once', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dev-tracker-projects-'));
  let server;
  try {
    const storage = path.join(base, 'store'), a = path.join(base, 'a'), b = path.join(base, 'b');
    await mkdir(storage); await mkdir(a); await mkdir(b);
    await writeFile(path.join(storage, 'project.json'), JSON.stringify({ nodes: [{ id: 'root', parent: null, title: 'Unassigned', tasks: [], notes: [], status: 'idle' }], events: [] }));
    server = await startServer({ storage, port: 0 });
    const state = () => fetch(`http://127.0.0.1:${server.address().port}/api/state`).then(r => r.json());
    await server.selectProject(a); assert.equal((await state()).nodes[0].title, 'Unassigned');
    await server.selectProject(b); assert.notEqual((await state()).nodes[0].title, 'Unassigned');
    await server.selectProject(a); assert.equal((await state()).nodes[0].title, 'Unassigned');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(base), path.resolve(tmpdir())); assert.ok(path.basename(base).startsWith('dev-tracker-projects-'));
    await rm(base, { recursive: true, force: true });
  }
});

test('failed first selection does not capture an obsolete unassigned map', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dev-tracker-projects-'));
  let server;
  try {
    const storage = path.join(base, 'store'), candidate = path.join(base, 'candidate');
    await mkdir(storage);
    await writeFile(candidate, 'not a directory');
    await writeFile(path.join(storage, 'project.json'), JSON.stringify({ nodes: [{ id: 'root', parent: null, title: 'Original', tasks: [], notes: [], status: 'idle' }], events: [] }));
    server = await startServer({ storage, port: 0 });
    const url = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(server.selectProject(candidate));
    assert.equal(server.evidence.get().root, null);
    const context = await fetch(url + '/api/state').then(r => r.json());
    const response = await fetch(url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rename', id: 'root', text: 'Latest unassigned edits', sessionId: context.context.sessionId }) });
    assert.equal(response.status, 200);
    const latestLegacy = await readFile(path.join(storage, 'project.json'), 'utf8');
    await rm(candidate); await mkdir(candidate);
    await server.selectProject(candidate);
    const state = await fetch(url + '/api/state').then(r => r.json());
    assert.equal(state.nodes[0].title, 'Latest unassigned edits', 'retry adopts the current map rather than data copied during a failed attempt');
    assert.equal(await readFile(path.join(storage, 'project.json'), 'utf8'), latestLegacy, 'successful adoption retains the edited legacy file');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(base), path.resolve(tmpdir())); assert.ok(path.basename(base).startsWith('dev-tracker-projects-'));
    await rm(base, { recursive: true, force: true });
  }
});
