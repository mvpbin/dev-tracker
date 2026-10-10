import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProject } from '../project.js';

test('full requirement retrieval persists a session receipt without implying processing, and new requirements invalidate it', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'tracker-improvements-'));
  try {
    const store = path.join(base, 'store'), root = path.join(base, 'project'), other = path.join(base, 'other');
    for (const dir of [store, root, other]) await mkdir(dir);
    let project = await createProject(store, root, store);
    const ai = { sessionId: 'ai-a', label: 'AI A' };
    await project.applyAction({ id: 'root', action: 'add', text: '保存' });
    const id = project.getState().nodes[1].id;
    await project.applyAction({ id, action: 'scope', text: 'true' });
    await project.applyAction({ id, action: 'request', text: '保留全部文字' });
    await project.getHandoff();
    assert.equal(project.getState().nodes[1].requirementReceipt, undefined, 'summaries cannot certify full retrieval');
    assert.equal((await project.getOverview()).next.actor, 'AI');
    const read = await project.getNode(id, ai);
    assert.equal(read.requirementReceipt.sessionId, ai.sessionId);
    assert.equal(read.status, 'pending', 'retrieval does not start work');
    project = await createProject(store, root, store);
    assert.deepEqual(project.getState().nodes[1].requirementReceipt, read.requirementReceipt);
    await project.applyAction({ id, action: 'request', text: '还要保留换行' });
    await project.applyAction({ id, action: 'start' }, 'ai', ai);
    assert.equal((await project.getOverview()).items[0].received, false, 'start cannot claim the new requirement was fetched');
    await project.getNode(id, { sessionId: 'ai-b', label: 'AI B' });
    assert.equal(project.getState().nodes[1].requirementReceipt.sessionId, 'ai-b');
    assert.equal((await createProject(other, root, other)).getState().nodes.length, 1, 'records remain scoped to storage');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('AI review records cannot certify acceptance and become stale after requirement, plan, criteria or code changes', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'tracker-quality-'));
  try {
    const store = path.join(base, 'store'), root = path.join(base, 'project'); await mkdir(store); await mkdir(root);
    let project = await createProject(store, root, store);
    const ai = { sessionId: 'ai-review' };
    const steps = [{ action: '打开', expected: '看到记录' }];
    await project.applyAction({ id: 'root', action: 'request', text: '做保存' });
    for (const invalid of [[], [{ action: '', expected: '结果' }], Array(11).fill(steps[0])]) await assert.rejects(project.setAcceptancePlan({ id: 'root', steps: invalid }, ai), /Invalid/);
    await project.setAcceptancePlan({ id: 'root', steps }, ai);
    const args = { id: 'root', scope: '保存流程', summary: '发现失败', findings: '测试失败 1 项，未执行重启', limitations: '仅源码，未验安装包', source: 'executed' };
    await project.recordQualityReview(args, ai);
    assert.equal(project.getState().nodes[0].qualityReview.source, 'ai');
    assert.equal(project.evidence.get().tests.length, 0, 'review text cannot fabricate test evidence');
    await project.applyAction({ id: 'root', action: 'submit' }, 'ai', ai);
    await project.applyAction({ id: 'root', action: 'accept' });
    await project.setAcceptancePlan({ id: 'root', steps: [{ action: '重启', expected: '仍有记录' }] }, ai);
    assert.equal(project.getState().nodes[0].status, 'review', 'new criteria must undo prior acceptance');
    assert.equal(project.getState().nodes[0].reviewCurrent, false);
    for (const change of ['criteria', 'request']) {
      await project.recordQualityReview(args, ai);
      await project.applyAction({ id: 'root', action: change, text: '不同要求' });
      assert.equal(project.getState().nodes[0].reviewCurrent, false);
    }
    await project.recordQualityReview(args, ai);
    const decision = await project.recordDecision({ nodeId: 'root', text: '保存为 CSV' }, ai);
    assert.equal(project.getState().nodes[0].reviewCurrent, false, 'current constraints affect review applicability');
    await project.recordQualityReview(args, ai);
    await project.recordDecision({ nodeId: 'root', text: '改为 JSON', replaces: decision.id }, ai);
    assert.equal(project.getState().nodes[0].reviewCurrent, false, 'superseding constraints invalidates an earlier review');
    await project.recordQualityReview({ ...args, summary: '复验通过', findings: '本次未发现问题' }, ai);
    assert.ok((await project.getJournal()).entries.some(entry => entry.pitfalls.includes('失败 1 项')), 'later review must preserve earlier failure findings');
    await project.recordQualityReview(args, ai);
    await project.applyAction({ id: 'root', action: 'goal', text: '新目标' });
    assert.equal(project.getState().nodes[0].reviewCurrent, false);
    await project.recordQualityReview(args, ai);
    await writeFile(path.join(root, 'changed.js'), 'export const changed = true;'); await project.evidence.scan();
    assert.equal(project.getState().nodes[0].reviewCurrent, false, 'code change invalidates review even if metadata is unchanged');
    project = await createProject(store, root, store);
    assert.ok(project.getState().nodes[0].qualityReview.findings.includes('失败'));
    assert.ok((await project.getHandoff(false)).markdown.includes('仍有记录'));
    assert.equal((await project.getNode('root', ai)).acceptancePlan[0].action, '重启');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('changed decisions retain history and complete constraints survive a restarted continuation', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'tracker-decisions-'));
  try {
    const store = path.join(base, 'store'), root = path.join(base, 'project'); await mkdir(store); await mkdir(root);
    let project = await createProject(store, root, store);
    const old = await project.recordDecision({ nodeId: 'root', text: '只能 CSV', reason: '第一版' }, { sessionId: 'old' });
    const long = '保留完整决定。'.repeat(120) + '尾部：允许 JSON';
    const latest = await project.recordDecision({ nodeId: 'root', text: long, reason: '需求修改', replaces: old.id }, { sessionId: 'old' });
    await project.recordDecision({ nodeId: 'root', kind: 'question', text: '失败测试的原因待查' }, { sessionId: 'old' });
    await project.applyAction({ id: 'root', action: 'request', text: '工作任务' });
    await project.applyAction({ id: 'root', action: 'start' }, 'ai', { sessionId: 'old' });
    await assert.rejects(project.recordDecision({ nodeId: 'root', text: '夺取决定' }, { sessionId: 'new' }), /另一会话/);
    await project.applyAction({ id: 'root', action: 'pause' }, 'ai', { sessionId: 'old' });
    await assert.rejects(project.recordDecision({ nodeId: 'root', text: '错误替换', replaces: old.id }, { sessionId: 'new' }), /current decision/);
    project = await createProject(store, root, store);
    const first = await project.getDecisions({ limit: 1 });
    const second = await project.getDecisions({ offset: first.nextOffset, limit: 1 });
    assert.equal(first.entries[0].kind, 'question'); assert.equal(second.entries[0].text, long); assert.equal(second.nextOffset, null);
    assert.equal((await project.getDecisions({ status: 'history' })).entries[0].replacedBy, latest.id);
    assert.ok((await project.getHandoff()).snapshot.decisions.details.includes('nextOffset'));
    assert.ok((await project.getHandoff(false)).markdown.includes(long), 'full export must retain authoritative constraints');
    assert.ok(JSON.stringify(project.getState()).length < long.length + 1300, 'routine polling must not include all decision history');
  } finally { await rm(base, { recursive: true, force: true }); }
});
