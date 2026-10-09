import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverview, acceptanceState } from '../overview.js';

test('100 percent user confirmation cannot hide missing test evidence or undefined acceptance criteria', () => {
  const accepted = { id: 'a', parent: 'root', title: '保存', status: 'accepted', releaseIncluded: true, acceptance: { fingerprint: 'v' } };
  const state = { release: { goal: '可用的保存功能' }, nodes: [accepted] };
  const evidence = { root: 'project', scannedAt: 'now', fingerprint: 'v', tests: [] };
  const incomplete = buildOverview(state, evidence);
  assert.equal(incomplete.percent, 100);
  assert.equal(incomplete.complete, false);
  assert.match(incomplete.delivery, /条件/);
  accepted.criteria = '输入一条记录，重开后仍存在';
  assert.match(buildOverview(state, evidence).delivery, /验证/);
  evidence.tests.push({ node: 'a', fingerprint: 'v', passed: true, unchanged: true });
  assert.equal(buildOverview(state, evidence).complete, true);
});

const node = (id, status = 'pending', extra = {}) => ({ id, parent: 'root', title: id, status, releaseIncluded: true, ...extra });
const evidence = extra => ({ root: 'C:/project', scannedAt: 'scan', fingerprint: 'version', tests: [], ...extra });
const run = extra => ({ node: 'a', fingerprint: 'version', passed: true, unchanged: true, ...extra });
const overview = (nodes, actual = evidence()) => buildOverview({ nodes, release: { goal: '发布目标' } }, actual);

test('fixed checklist excludes root and unselected work so incidental tasks cannot change release progress', () => {
  const actual = overview([node('root', 'accepted', { parent: null }), node('excluded', 'active', { releaseIncluded: false }),
    node('legacy', 'pending', { releaseIncluded: undefined }), node('a', 'accepted', { acceptance: { fingerprint: 'version' }, criteria: '用户可保存记录' })]);
  assert.equal(actual.total, 1);
  assert.equal(actual.completed, 1);
  assert.equal(actual.percent, 100);
  assert.equal(actual.complete, false, 'manual completion remains separate from missing test evidence');
  assert.equal(actual.counts.verifiedCurrent, 0);
  assert.equal(actual.items[0].criteria, '用户可保存记录');
  assert.equal(actual.goal, '发布目标');
  assert.match(actual.warnings.join(''), /人工验收完成也不保证整体质量/);
});

test('empty scope remains undefined rather than claiming zero or complete release progress', () => {
  const actual = overview([node('a', 'accepted', { releaseIncluded: false })]);
  assert.equal(actual.percent, null);
  assert.equal(actual.complete, false);
  assert.equal(actual.next, null);
});

test('legacy or changed-version acceptance must be rechecked before it contributes completion', () => {
  const actual = overview([node('a', 'accepted'), node('b', 'accepted', { acceptance: { fingerprint: 'old' } }), node('c', 'active')]);
  assert.equal(actual.completed, 0);
  assert.deepEqual(actual.items.map(item => item.lane), ['verify', 'verify', 'active']);
  assert.match(actual.items[0].acceptanceWarning, /未绑定/);
  assert.match(actual.items[1].acceptanceWarning, /版本已变化/);
  assert.equal(actual.next.id, 'c');
  assert.equal(overview(actual.items.map(item => node(item.id, item.status))).next.id, 'c');
});

test('latest matching version result controls review readiness so an earlier pass cannot conceal a failure', () => {
  const actual = overview([node('a', 'review'), node('b', 'review'), node('c', 'review')], evidence({ tests: [
    run({ fingerprint: 'old' }), run({ passed: false }), run(), run({ node: 'b' }), run({ node: 'c', unchanged: false })
  ] }));
  assert.deepEqual(actual.items.map(item => item.verified), [false, true, false]);
  assert.deepEqual(actual.items.map(item => item.lane), ['verify', 'review', 'verify']);
  assert.equal(actual.counts.verifiedCurrent, 1);
  assert.equal(actual.next.id, 'a');
});

test('missing project or failed scan invalidates matching historical evidence while running results stay explicit', () => {
  const a = node('a', 'accepted', { acceptance: { fingerprint: 'version' } });
  for (const extra of [{ root: null }, { scannedAt: null }, { error: 'scan failed' }]) {
    const actual = overview([a], evidence({ tests: [run()], ...extra }));
    assert.equal(actual.completed, 0);
    assert.equal(actual.items[0].verified, false);
    assert.equal(acceptanceState(a, evidence(extra)).acceptanceCurrent, false);
    assert.ok(actual.warnings.length);
  }
  assert.match(overview([a], evidence({ running: true })).warnings.join(''), /测试正在运行/);
});

test('stale acceptance takes priority over verification and review work but valid tests do not accept for the user', () => {
  const actual = overview([node('verify', 'review'), node('review', 'review'), node('stale', 'accepted'), node('idle', 'idle')],
    evidence({ tests: [run({ node: 'review' })] }));
  assert.equal(actual.next.id, 'stale');
  assert.equal(actual.completed, 0);
  assert.equal(actual.items[1].lane, 'review');
  assert.equal(actual.items[3].lane, 'pending');
});
