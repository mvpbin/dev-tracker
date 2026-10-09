import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { validateJournal, selectJournal } from '../journal.js';

test('journal claims remain separate from legacy notes and persist only in the intended project', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dev-tracker-journal-'));
  let server;
  try {
    const storage = path.join(base, 'store'), a = path.join(base, 'a'), b = path.join(base, 'b');
    await mkdir(storage); await mkdir(a); await mkdir(b);
    const legacy = { nodes: [{ id: 'root', title: 'Legacy', parent: null, status: 'idle', tasks: [], notes: [{ text: 'Old note', source: 'manual' }] }], events: [] };
    await writeFile(path.join(storage, 'project.json'), JSON.stringify(legacy));
    server = await startServer({ storage, port: 0 });
    await assert.rejects(server.appendJournal({ nodeId: 'root', summary: 'Unbound' }), /projectRoot/);
    await server.selectProject(a);
    const args = { projectRoot: await realpath(a), nodeId: 'root', summary: 'Implemented parser', approach: 'Structured parsing', reason: 'Preserve quoted values', verification: 'AI says tests passed', pitfalls: 'Quotes', next: 'User trial', source: 'executed' };
    await assert.rejects(server.appendJournal({ ...args, projectRoot: b }), /does not match/);
    await assert.rejects(server.appendJournal({ ...args, nodeId: 'removed' }), /node does not exist/);
    const entry = await server.appendJournal(args);
    assert.equal(entry.source, 'ai', 'a claimed verification cannot masquerade as executed evidence');
    assert.equal(entry.fingerprint, server.evidence.get().fingerprint);
    const snapshot = await fetch(`http://127.0.0.1:${server.address().port}/api/state`).then(r => r.json());
    assert.equal('journal' in snapshot, false, 'routine state polling must not embed the unbounded journal');
    assert.deepEqual(snapshot.nodes[0].notes, legacy.nodes[0].notes);
    assert.equal(server.evidence.get().tests.length, 0, 'verification text does not create test evidence');
    await server.selectProject(b);
    assert.equal((await server.getJournal()).total, 0);
    await assert.rejects(server.appendJournal(args), /does not match/);
    await new Promise(resolve => server.close(resolve));
    server = await startServer({ storage, port: 0 });
    assert.equal((await server.getJournal()).total, 0);
    await server.selectProject(a);
    assert.deepEqual((await server.getJournal()).entries, [entry]);
    const url = `http://127.0.0.1:${server.address().port}/api/journal`;
    assert.equal((await fetch(url + '?query=quoted&limit=1').then(r => r.json())).total, 1);
    assert.equal((await fetch(url + '?limit=11')).status, 400);
    const context = await fetch(`http://127.0.0.1:${server.address().port}/api/state`).then(r => r.json());
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: context.context.sessionId }) })).status, 404, 'manual HTTP clients have no journal write route');
    await rm(a, { recursive: true });
    await assert.rejects(server.appendJournal(args));
    assert.equal((await server.getJournal()).total, 1, 'a missing project cannot append with a stale fingerprint');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    assert.ok(path.basename(base).startsWith('dev-tracker-journal-'));
    await rm(base, { recursive: true, force: true });
  }
});

test('bounded keyword pagination searches structured claims without changing stored history', () => {
  const state = { nodes: [{ id: 'root' }], journal: Array.from({ length: 12 }, (_, id) => ({ id: String(id), nodeId: id === 0 ? 'other' : 'root', summary: 'Change', reason: id % 2 ? 'Quoted strings' : '', source: 'ai' })) };
  const evidence = { root: 'project' };
  const first = selectJournal(state, evidence, { nodeId: 'root', query: 'QUOTED', limit: 2 });
  assert.deepEqual(first.entries.map(e => e.id), ['11', '9']);
  assert.equal(first.total, 6); assert.equal(first.nextOffset, 2);
  assert.deepEqual(selectJournal(state, evidence, { query: 'quoted', offset: 4, limit: 2 }).entries.map(e => e.id), ['3', '1']);
  assert.equal(selectJournal(state, evidence, { query: 'quoted', offset: 4, limit: 2 }).nextOffset, null);
  first.entries[0].summary = 'Mutated';
  assert.equal(state.journal[11].summary, 'Change', 'callers cannot edit an append-only record through a read result');
  assert.throws(() => selectJournal(state, evidence, { offset: -1 }));
  assert.throws(() => selectJournal(state, evidence, { query: 'x'.repeat(201) }));
  assert.throws(() => validateJournal({ projectRoot: 'project', nodeId: 'root', summary: 'x'.repeat(301) }, state, evidence));
  assert.throws(() => validateJournal({ projectRoot: 'project', nodeId: 'root', summary: ' ' }, state, evidence));
  assert.throws(() => validateJournal({ projectRoot: 'project', nodeId: 'root', summary: 'Change', next: 'x'.repeat(2001) }, state, evidence));
  assert.equal(validateJournal({ projectRoot: 'project', nodeId: 'root', summary: 'Change' }, state, evidence).verification, '');
  assert.throws(() => validateJournal({ projectRoot: 'project', nodeId: 'root', summary: 'Change' }, { ...state, journal: Array(10000).fill({}) }, evidence), /existing entries are preserved/);
});
