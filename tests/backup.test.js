import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackup, restoreBackup } from '../backup.js';
import { startServer } from '../server.js';

test('record restore replaces maps and bindings without touching worktree code; failed install rolls back', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'tracker-backup-'));
  try {
    await writeFile(path.join(storage, 'sessions.json'), '{}');
    await writeFile(path.join(storage, 'project.json'), JSON.stringify({ nodes: [{ id: 'root', title: 'before', tasks: [], notes: [] }], events: [], journal: [{ summary: 'history' }] }));
    await mkdir(path.join(storage, 'worktrees')); await writeFile(path.join(storage, 'worktrees', 'code.js'), 'code');
    const archive = await createBackup(storage);
    assert.equal(archive.entries.length, 2);
    await writeFile(path.join(storage, 'project.json'), JSON.stringify({ nodes: [{ id: 'root', title: 'after', tasks: [], notes: [] }], events: [] }));
    await restoreBackup(storage, archive);
    assert.equal(await readFile(path.join(storage, 'project.json'), 'utf8'), archive.entries.find(e => e.path === 'project.json').content);
    assert.equal(await readFile(path.join(storage, 'worktrees', 'code.js'), 'utf8'), 'code');
    await assert.rejects(restoreBackup(storage, { ...archive, entries: [...archive.entries, { path: '../escape.json', content: '{}' }] }), /path/);
    await assert.rejects(restoreBackup(storage, { ...archive, entries: [...archive.entries, { path: 'project.json\n', content: '{"root":null}' }] }), /path/);
    await assert.rejects(restoreBackup(storage, { ...archive, entries: [...archive.entries, { path: 'evidence.json', content: JSON.stringify({ root: null, files: {}, changes: [], tests: [{}] }) }] }), /Invalid evidence/);
    assert.deepEqual((await createBackup(storage)).entries, archive.entries, 'invalid paths and unusable test fingerprints cannot alter records');
    await assert.rejects(restoreBackup(storage, { ...archive, entries: [...archive.entries, archive.entries[0]] }), /duplicate/);
    for (const invalid of [null, { nodes: [null], events: [] }, { nodes: [{ id: 'root', title: 'bad', tasks: [null], notes: [] }], events: [] }]) {
      const entries = archive.entries.map(e => e.path === 'project.json' ? { ...e, content: JSON.stringify(invalid) } : e);
      await assert.rejects(restoreBackup(storage, { ...archive, entries }), /Invalid/);
    }
    const extra = `projects/${'a'.repeat(64)}/project.json`;
    await mkdir(path.join(storage, 'projects')); await writeFile(path.join(storage, 'projects', 'a'.repeat(64)), 'blocked directory');
    await assert.rejects(restoreBackup(storage, { ...archive, entries: [...archive.entries, { path: extra, content: archive.entries.find(e => e.path === 'project.json').content }] }));
    assert.deepEqual((await createBackup(storage)).entries, archive.entries, 'a partial install must restore the prior record set');
    await writeFile(path.join(storage, 'project.json'), '{broken');
    await assert.rejects(createBackup(storage), SyntaxError);
    await assert.rejects(restoreBackup(storage, { ...archive, entries: [...archive.entries, { path: extra, content: archive.entries.find(e => e.path === 'project.json').content }] }));
    assert.equal(await readFile(path.join(storage, 'project.json'), 'utf8'), '{broken', 'rollback preserves even the original damaged bytes');
    await restoreBackup(storage, archive);
    assert.deepEqual((await createBackup(storage)).entries, archive.entries, 'a valid archive repairs damaged existing records');
  } finally { await rm(storage, { recursive: true, force: true }); }
});

test('full record replacement removes later maps, rejects symlink records and missing selected folders before writes', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'tracker-backup-paths-'));
  try {
    await writeFile(path.join(storage, 'sessions.json'), '{}');
    const archive = await createBackup(storage);
    const later = path.join(storage, 'projects', 'b'.repeat(64));
    await mkdir(later, { recursive: true });
    await writeFile(path.join(later, 'project.json'), JSON.stringify({ nodes: [{ id: 'root', title: 'later', tasks: [], notes: [] }], events: [] }));
    await restoreBackup(storage, archive);
    await assert.rejects(readFile(path.join(later, 'project.json')), { code: 'ENOENT' });
    const outside = await mkdtemp(path.join(tmpdir(), 'tracker-backup-outside-'));
    try {
      await rm(path.join(storage, 'projects'), { recursive: true });
      await symlink(outside, path.join(storage, 'projects'), 'junction');
      await assert.rejects(createBackup(storage), /symlink/);
      await assert.rejects(restoreBackup(storage, archive), /symlink/);
      await rm(path.join(storage, 'projects'));
    } finally { await rm(outside, { recursive: true, force: true }); }
    const missing = path.join(storage, 'missing');
    const { createHash } = await import('node:crypto');
    const identity = createHash('sha256').update(process.platform === 'win32' ? missing.toLowerCase() : missing).digest('hex');
    const entries = [...archive.entries, { path: 'active-project.json', content: JSON.stringify({ root: missing }) }, { path: `projects/${identity}/evidence.json`, content: JSON.stringify({ root: missing, files: {}, changes: [], tests: [] }) }];
    await assert.rejects(restoreBackup(storage, { ...archive, entries }), { code: 'ENOENT' });
    assert.deepEqual((await createBackup(storage)).entries, archive.entries, 'missing project preflight cannot replace usable records');
  } finally { await rm(storage, { recursive: true, force: true }); }
});

test('maintenance drains accepted writes, rejects old contexts after restore and permits restart', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'tracker-maintenance-'));
  let server;
  try {
    server = await startServer({ storage, port: 0 });
    const context = await server.resolveContext({ trackerWindowId: 'default' });
    const writing = context.applyAction({ action: 'rename', id: 'root', text: 'saved before snapshot' });
    const backing = server.backupRecords();
    await assert.rejects(server.createWindow(), /维护/);
    await writing;
    const archive = await backing;
    assert.equal(JSON.parse(archive.entries.find(e => e.path === 'project.json').content).nodes[0].title, 'saved before snapshot');
    await server.restoreRecords(archive);
    assert.throws(() => context.getState(), /维护/);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/state`);
    assert.equal(response.status, 503);
    await server.shutdown(); server = await startServer({ storage, port: 0 });
    assert.equal((await server.resolveContext({ trackerWindowId: 'default' })).getState().nodes[0].title, 'saved before snapshot');
  } finally { if (server?.listening) await server.shutdown(); await rm(storage, { recursive: true, force: true }); }
});

test('shutdown waits for an accepted restore transaction before permitting process exit', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'tracker-backup-close-'));
  let server;
  try {
    server = await startServer({ storage, port: 0 });
    const archive = await server.backupRecords();
    let restored = false;
    const restoration = server.restoreRecords(archive).then(result => { restored = true; return result; });
    await server.shutdown();
    assert.equal(restored, true, 'the desktop may exit only after every accepted record transaction settles');
    await restoration;
    assert.equal(server.listening, false);
    assert.deepEqual((await createBackup(storage)).entries, archive.entries, 'shutdown must preserve the completed restored record set');
  } finally { if (server?.listening) await server.shutdown(); await rm(storage, { recursive: true, force: true }); }
});
