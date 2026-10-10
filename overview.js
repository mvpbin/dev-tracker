import { createHash } from 'node:crypto';

export const reviewPlanKey = node => createHash('sha256').update(JSON.stringify({ criteria: node.criteria || '', steps: node.acceptancePlan || [], requirements: node.tasks || [] })).digest('hex');
export const reviewCurrent = (node, evidence) => !!node.qualityReview && !node.qualityReview.decisionsChanged && currentProject(evidence) && node.qualityReview.fingerprint === evidence.fingerprint && node.qualityReview.planKey === reviewPlanKey(node);

function currentProject(evidence) {
  return !!evidence.root && !!evidence.scannedAt && !!evidence.fingerprint && !evidence.error;
}

export function acceptanceState(node, evidence) {
  const acceptanceCurrent = node.status === 'accepted' && currentProject(evidence) && node.acceptance?.fingerprint === evidence.fingerprint;
  let acceptanceWarning = '';
  if (node.status === 'accepted' && !acceptanceCurrent) {
    acceptanceWarning = !node.acceptance?.fingerprint ? '此前验收未绑定项目版本，需要重新核对。' :
      !currentProject(evidence) ? '当前项目版本无法确认，需要重新核对验收。' : '项目版本已变化，需要重新核对验收。';
  }
  return { acceptanceCurrent, acceptanceWarning };
}

export function buildOverview(state, evidence) {
  const current = currentProject(evidence);
  const items = state.nodes.filter(node => node.parent !== null && node.id !== 'root' && node.releaseIncluded === true).map(node => {
    const test = current ? (evidence.tests || []).find(item => item.node === node.id && item.fingerprint === evidence.fingerprint) : null;
    const verified = !!test?.passed && !!test?.unchanged;
    const acceptance = acceptanceState(node, evidence);
    let lane = 'pending', reason = '尚待开始处理。';
    if (node.status === 'active') { lane = 'active'; reason = '继续处理正在开发的功能。'; }
    if (node.status === 'review') {
      lane = verified ? 'review' : 'verify';
      reason = verified ? '当前版本有通过的测试记录，等待用户按验收条件确认。' : '已提交验收，但缺少当前版本通过且执行前后扫描一致的测试记录。';
    }
    if (node.status === 'accepted') {
      lane = acceptance.acceptanceCurrent ? 'done' : 'verify';
      reason = acceptance.acceptanceCurrent ? '用户已确认当前项目版本。' : acceptance.acceptanceWarning;
    }
    const received = node.tasks?.length > 0 && node.requirementReceipt?.count === node.tasks.length;
    const actor = lane === 'done' ? '无待办' : lane === 'review' ? '用户试用' : 'AI';
    return { id: node.id, title: node.title, status: node.status, owner: node.owner ?? null, lane, actor, received, verified, ...acceptance, criteria: node.criteria || '', reason };
  });
  const counts = { pending: 0, active: 0, verify: 0, review: 0, done: 0, verifiedCurrent: 0 };
  for (const item of items) { counts[item.lane]++; if (item.verified) counts.verifiedCurrent++; }
  const total = items.length, completed = counts.done;
  const candidate = items.find(item => item.lane === 'active') ||
    items.find(item => item.status === 'accepted' && !item.acceptanceCurrent) ||
    items.find(item => item.lane === 'verify') || items.find(item => item.lane === 'review') || items.find(item => item.lane === 'pending');
  const missingCriteria = items.find(item => !item.criteria.trim() && !state.nodes.find(node => node.id === item.id)?.acceptancePlan?.length);
  const missingTest = items.find(item => !item.verified);
  const nextItem = candidate || missingCriteria || missingTest;
  const next = nextItem ? { id: nextItem.id, title: nextItem.title, lane: nextItem.lane, actor: candidate ? candidate.actor : 'AI',
    reason: candidate ? candidate.reason : missingCriteria ? '先补齐具体试用通过条件，再判断是否交付。' : '用户已确认，但当前版本仍缺少有效测试记录。' } : null;
  const warnings = [];
  if (!evidence.root) warnings.push('尚未选择实际项目，无法确认测试和验收适用于当前版本。');
  if (evidence.root && !evidence.scannedAt) warnings.push('尚无成功扫描时间，当前项目版本待核对。');
  if (evidence.error) warnings.push('项目扫描失败，当前测试与验收依据无法确认。');
  if (evidence.running) warnings.push('测试正在运行，尚未完成的结果不计入总览。');
  if (total && counts.verifiedCurrent < total) warnings.push('部分清单功能缺少当前版本有效的测试记录。');
  if (missingCriteria) warnings.push('部分清单功能尚未填写试用通过条件。');
  if (total) warnings.push('测试关联不代表覆盖验收条件；人工验收完成也不保证整体质量。');
  const complete = total > 0 && completed === total && counts.verifiedCurrent === total && !missingCriteria && !!state.release?.goal?.trim();
  const delivery = !total || !state.release?.goal?.trim() ? '待确定交付目标与清单' : complete ? '本版清单验收与测试记录齐全' :
    counts.active || counts.pending ? '继续开发' : missingCriteria ? '待补齐试用通过条件' : counts.verify || missingTest ? '待补齐当前版本验证' : '待用户试用验收';
  return { goal: state.release?.goal || '', items, total, completed, percent: total ? Math.round(completed / total * 100) : null,
    counts, next, warnings, complete, delivery };
}
