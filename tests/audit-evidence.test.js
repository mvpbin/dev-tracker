import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createEvidence } from '../evidence.js';
import { buildHandoff } from '../handoff.js';

const pass = "require('node:test')('real test', () => {});";
const fail = "require('node:test')('real failure', () => require('node:assert/strict').fail('changed test'));";
async function fixture(work) {
  const base = await mkdtemp(path.join(tmpdir(), 'dev-tracker-audit-evidence-'));
  const root = path.join(base, 'project');
  await mkdir(root);
  try { await work({ base, root, tracker: await createEvidence(path.join(base, 'store')) }); }
  finally {
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    assert.ok(path.basename(base).startsWith('dev-tracker-audit-evidence-'));
    await rm(base, { recursive: true, force: true });
  }
}

test('excluded output tests cannot be used as current-version verification when their contents are not scanned', () => fixture(async ({ root, tracker }) => {
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'dist', 'smoke.test.cjs'), pass);
  await tracker.select(root);
  const result = await tracker.run('a');
  assert.equal(result.passed, false, 'an unscanned test must never create passing evidence');
  assert.equal(result.exitCode, null, 'automatic Node discovery must not run as an empty-list fallback');
  assert.deepEqual(result.testFiles, []);
  assert.match(result.stderr, /没有.*测试文件/);
}));

test('upgrading scan scope invalidates v1 passes without deleting their history', () => fixture(async ({ base, root, tracker }) => {
  await writeFile(path.join(root, 'sample.test.cjs'), pass);
  await tracker.select(root);
  const file = path.join(base, 'store', 'evidence.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  const legacy = createHash('sha256').update('scanned-node-tests-v1\0' + JSON.stringify(Object.entries(stored.files).sort()) + JSON.stringify(stored.git)).digest('hex');
  stored.fingerprint = legacy;
  stored.tests = [{ node: 'a', fingerprint: legacy, after: legacy, passed: true, unchanged: true }];
  await writeFile(file, JSON.stringify(stored));
  const reopened = await createEvidence(path.join(base, 'store'));
  await reopened.scan();
  assert.equal(reopened.get().tests.length, 1, 'executed history remains available after migration');
  assert.equal(reopened.get().tests[0].current, false, 'v1 scope cannot verify the new exclusion policy');
}));

test('explicit scanned JS discovery supports Node filename conventions and invalidates evidence when an executed test changes', () => fixture(async ({ root, tracker }) => {
  for (const directory of ['nested/test', 'dist', '.data', '.demo', 'test-results']) await mkdir(path.join(root, directory), { recursive: true });
  const included = ['nested/test/feature.js', 'nested/widget_test.cjs', 'test.mjs'];
  for (const name of included) await writeFile(path.join(root, name), name.endsWith('.mjs') ? "import test from 'node:test'; test('real test', () => {});" : pass);
  for (const name of ['dist/smoke.test.cjs', '.data/smoke.test.cjs', '.demo/smoke.test.cjs', 'test-results/smoke.test.cjs', 'unrelated.cjs']) await writeFile(path.join(root, name), fail);
  await tracker.select(root);
  const result = await tracker.run('a');
  assert.equal(result.passed, true, result.stderr);
  assert.equal(result.counts.pass, 3, 'only discovered files inside the scanned project scope execute');
  assert.deepEqual(result.testFiles, included);
  assert.deepEqual(result.args, ['--test', '--test-reporter=tap', ...included.map(name => './' + name)]);
  await writeFile(path.join(root, '.demo/smoke.test.cjs'), pass);
  await tracker.scan();
  assert.equal(tracker.get().tests[0].current, true, 'demo app data must not invalidate evidence or join the test list');
  await writeFile(path.join(root, included[1]), fail);
  await tracker.scan();
  assert.equal(tracker.get().tests[0].current, false, 'the changed test must invalidate its earlier passing evidence');
  assert.equal((await tracker.run('a')).passed, false);
}));

test('matching before and after scans must not claim there were no temporary edits during execution', () => fixture(async ({ base, root, tracker }) => {
  const marker = path.join(base, 'running');
  await writeFile(path.join(root, 'code.js'), 'original');
  await writeFile(path.join(root, 'test.cjs'), `const {test}=require('node:test'); const fs=require('node:fs'); test('running',async()=>{fs.writeFileSync(${JSON.stringify(marker)},'ready'); await new Promise(r=>setTimeout(r,750));});`);
  await tracker.select(root);
  const running = tracker.run('a');
  await assert.rejects(tracker.waitForIdle(), /测试运行期间不能维护记录/, 'maintenance must refuse an active test instead of waiting for execution');
  const deadline = Date.now() + 5000;
  while (true) {
    try { await readFile(marker); break; }
    catch (error) { if (error.code !== 'ENOENT' || Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  await writeFile(path.join(root, 'code.js'), 'temporary change');
  await writeFile(path.join(root, 'code.js'), 'original');
  const result = await running;
  await tracker.waitForIdle();
  assert.equal(result.passed, true);
  assert.equal(result.unchanged, true, 'the evidence compares only the two snapshots');
  const { markdown } = buildHandoff({ nodes: [{ id: 'a', parent: 'root', status: 'review', title: 'a', tasks: [], notes: [] }], events: [] }, tracker.get());
  assert.match(markdown, /执行前后项目扫描一致/);
  assert.match(markdown, /不能证明中途没有变化/);
  assert.doesNotMatch(markdown, /执行期间.*未变化/);
}));
