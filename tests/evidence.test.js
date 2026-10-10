import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createEvidence } from '../evidence.js';
const exec = promisify(execFile);

test('Git source filtering preserves initialized submodule sources and their untracked work', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dev-tracker-submodule-scan-'));
  try {
    const root = path.join(base, 'project'), child = path.join(root, 'module');
    await mkdir(child, { recursive: true });
    await exec('git', ['init', root]); await exec('git', ['init', child]);
    await writeFile(path.join(child, 'tracked.test.cjs'), "require('node:test')('tracked source', () => {});");
    await exec('git', ['-C', child, 'add', '.']);
    await exec('git', ['-C', child, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
    const head = (await exec('git', ['-C', child, 'rev-parse', 'HEAD'])).stdout.trim();
    await exec('git', ['-C', root, 'update-index', '--add', '--cacheinfo', `160000,${head},module`]);
    await writeFile(path.join(child, 'new.test.cjs'), "require('node:test')('untracked source', () => {});");
    const tracker = await createEvidence(path.join(base, 'store'));
    await tracker.select(root);
    const result = await tracker.run('root');
    assert.deepEqual(result.testFiles, ['module/new.test.cjs', 'module/tracked.test.cjs'], 'source filtering cannot silently omit a nested repository');
    assert.equal(result.passed, true);
    await writeFile(path.join(child, 'new.test.cjs'), "throw new Error('source changed');");
    await tracker.scan();
    assert.equal(tracker.get().tests[0].current, false);
  } finally {
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    assert.ok(path.basename(base).startsWith('dev-tracker-submodule-scan-'));
    await rm(base, { recursive: true, force: true });
  }
});
test('observed changes invalidate passing tests and remain unattributed; Git is measured', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dev-tracker-evidence-'));
  try {
    const root = path.join(base, 'project'), storage = path.join(base, 'store'); await mkdir(root);
    await writeFile(path.join(root, 'sample.test.cjs'), "require('node:test')('real test', () => require('node:assert/strict').equal(1, 1));");
    await exec('git', ['init', root]);
    await writeFile(path.join(root, '.gitignore'), '.tmp/\nexports/\n');
    await mkdir(path.join(root, '.tmp')); await mkdir(path.join(root, 'exports'));
    await writeFile(path.join(root, '.tmp', 'generated.test.cjs'), "throw new Error('ignored output must not run');");
    await writeFile(path.join(root, 'exports', 'generated.test.cjs'), "throw new Error('ignored output must not run');");
    const tracker = await createEvidence(storage); await tracker.select(root);
    assert.equal(tracker.get().git.available, true);
    assert.match(tracker.get().git.status, /sample.test.cjs/);
    const first = await tracker.run('root'); assert.equal(first.passed, true, JSON.stringify(first));
    assert.equal(tracker.get().tests[0].current, true);
    await writeFile(path.join(root, 'code.js'), 'const value = 2;'); await tracker.scan();
    assert.equal(tracker.get().tests[0].current, false);
    assert.equal(tracker.get().changes[0].node, null);
    assert.equal(tracker.get().changes[0].type, 'added');
    const change = tracker.get().changes[0];
    await tracker.link('file', change.id, 'root', 'ai');
    await tracker.select(root);
    assert.equal(tracker.get().changes.find(c => c.id === change.id).node, 'root', 'reopening the same project preserves history and associations');
    assert.equal(tracker.get().tests.length, 1, 'reselecting the same project does not erase tests');
    assert.equal((await createEvidence(storage)).get().changes[0].association.source, 'ai', 'association survives restart without claiming authorship');
    await tracker.link('git', tracker.get().gitChanges[0].id, 'root', 'manual');
    await assert.rejects(tracker.link('file', 'missing', 'root', 'ai'));
    assert.ok(tracker.get().gitChanges.length > 0, 'Git working tree changes are recorded, not inferred from AI reports');
    await writeFile(path.join(root, 'code.js'), 'const value = 3;'); await tracker.scan();
    assert.equal(tracker.get().changes[0].type, 'modified');
    assert.equal(tracker.get().changes[0].node, null, 'linking one revision must not attribute future edits');
    await tracker.link('file', change.id, null, 'manual');
    assert.equal(tracker.get().changes.find(c => c.id === change.id).node, null);
    await rm(path.join(root, 'code.js')); await tracker.scan();
    assert.equal(tracker.get().changes[0].type, 'deleted');
    await writeFile(path.join(root, 'sample.test.cjs'), "require('node:test')('failure', () => require('node:assert/strict').equal(1, 2));");
    assert.equal((await tracker.run('root')).passed, false);
    assert.equal((await createEvidence(storage)).get().tests.length, 2);
    await rm(path.join(root, 'sample.test.cjs')); await tracker.scan();
    assert.equal((await tracker.run('root')).passed, false, 'zero tests must not count as verification');
  } finally {
    assert.equal(path.dirname(base), path.resolve(tmpdir())); assert.ok(path.basename(base).startsWith('dev-tracker-evidence-'));
    await rm(base, { recursive: true, force: true });
  }
});
