import { readFile, writeFile, rename, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createEvidence } from './evidence.js';
import { buildHandoff } from './handoff.js';
import { compactHandoff } from './compact-handoff.js';
import { buildOverview, acceptanceState, reviewPlanKey, reviewCurrent } from './overview.js';
import { validateJournal, selectJournal } from './journal.js';

export async function createProject(storage, activeRoot, excludedStorage) {
  const file = path.join(storage, 'project.json');
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { nodes: [{ id: 'root', parent: null, title: '我的项目', status: 'idle', tasks: [], notes: [] }], events: [] }; }
  const tracker = await createEvidence(storage, { excludedStorage });
  if (activeRoot && !tracker.get().root) await tracker.select(activeRoot);
  try { await tracker.scan(); } catch { /* keep persisted scan error visible */ }
  let queue = Promise.resolve(), testing = false;
  const locked = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  const canonicalKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const evidence = { get: () => ({ ...tracker.get(), running: testing }), scan: () => locked(() => tracker.scan()), diff: id => locked(() => tracker.diff(id)) };
  const getState = () => {
    const { journal, decisions, ...snapshot } = state;
    return { ...snapshot, decisionSummary: decisionSummary(), nodes: state.nodes.map(node => ({ ...node, ...(node.status === 'accepted' ? acceptanceState(node, evidence.get()) : {}), reviewCurrent: reviewCurrent(node, evidence.get()) })) };
  };
  const setAcceptancePlan = ({ id, steps }, session = {}) => locked(async () => {
    const node = state.nodes.find(n => n.id === id);
    if (!node || !session.sessionId || !Array.isArray(steps) || steps.length < 1 || steps.length > 10 || steps.some(step => !step || ['action', 'expected'].some(key => typeof step[key] !== 'string' || !step[key].trim() || step[key].length > 600))) throw new Error('Invalid acceptance steps');
    if (node.status === 'active' && node.owner && node.owner.sessionId !== session.sessionId) throw new Error('另一会话正在处理');
    const copy = structuredClone(state), current = copy.nodes.find(n => n.id === id);
    current.acceptancePlan = steps.map(({ action, expected }) => ({ action: action.trim(), expected: expected.trim() }));
    if (current.status === 'accepted') { current.status = 'review'; current.statusSource = 'ai'; }
    copy.events.unshift({ id: crypto.randomUUID(), node: id, title: node.title, message: 'AI 自报：更新验收步骤', time: new Date().toISOString(), source: 'ai', sessionId: session.sessionId });
    await writeFile(file + '.tmp', JSON.stringify(copy, null, 2)); await rename(file + '.tmp', file); state = copy;
    return structuredClone(current);
  });
  const recordQualityReview = ({ id, scope, summary, findings, limitations }, session = {}) => locked(async () => {
    const node = state.nodes.find(n => n.id === id);
    if (!node || !session.sessionId || [scope, summary, findings, limitations].some(value => typeof value !== 'string' || value.length > 2000) || !scope.trim() || !summary.trim() || !limitations.trim()) throw new Error('Invalid quality review; scope, summary and limitations are required');
    if (node.status === 'active' && node.owner && node.owner.sessionId !== session.sessionId) throw new Error('另一会话正在处理');
    await tracker.scan();
    if (!tracker.get().root || tracker.get().error || !tracker.get().fingerprint) throw new Error('Review requires a successful project scan');
    const copy = structuredClone(state), current = copy.nodes.find(n => n.id === id);
    current.qualityReview = { scope: scope.trim(), summary: summary.trim(), findings: findings.trim(), limitations: limitations.trim(), source: 'ai', sessionId: session.sessionId, time: new Date().toISOString(), fingerprint: tracker.get().fingerprint, planKey: reviewPlanKey(node) };
    const content = validateJournal({ projectRoot: activeRoot, nodeId: id, summary: summary.slice(0, 300), approach: scope, verification: summary, pitfalls: findings, next: limitations }, state, tracker.get());
    copy.journal = [...(copy.journal || []), { id: crypto.randomUUID(), ...content, source: 'ai', time: current.qualityReview.time, fingerprint: tracker.get().fingerprint, projectRoot: activeRoot, sessionId: session.sessionId }];
    await writeFile(file + '.tmp', JSON.stringify(copy, null, 2)); await rename(file + '.tmp', file); state = copy;
    return { ...structuredClone(current.qualityReview), current: true };
  });
  const decisionSummary = () => {
    const current = (state.decisions || []).filter(item => !item.replacedBy);
    return { total: current.length, omitted: Math.max(0, current.length - 8), entries: current.slice(-8).map(item => ({ ...item, text: item.text.slice(0, 160), reason: item.reason.slice(0, 160) })), details: 'AI 记录的当前决定与未决问题。get_decisions 按页读取完整文字和替代历史，不是正确性证明。' };
  };
  const getDecisions = ({ status = 'current', offset = 0, limit = 5 } = {}) => locked(() => {
    if (!['current', 'history', 'all'].includes(status) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('Invalid decision page');
    const entries = (state.decisions || []).filter(item => status === 'all' || (status === 'current' ? !item.replacedBy : !!item.replacedBy)).slice().reverse();
    return { projectRoot: activeRoot, entries: structuredClone(entries.slice(offset, offset + limit)), total: entries.length, nextOffset: offset + limit < entries.length ? offset + limit : null };
  });
  const recordDecision = ({ nodeId, kind = 'decision', text, reason = '', replaces }, session = {}) => locked(async () => {
    if (!state.nodes.some(n => n.id === nodeId) || !['decision', 'question'].includes(kind) || typeof text !== 'string' || !text.trim() || text.length > 2000 || typeof reason !== 'string' || reason.length > 2000 || !session.sessionId) throw new Error('Invalid decision');
    const node = state.nodes.find(n => n.id === nodeId);
    if (node.status === 'active' && node.owner && node.owner.sessionId !== session.sessionId) throw new Error('另一会话正在处理');
    if ((state.decisions || []).length >= 1000) throw new Error('Decision limit reached');
    const copy = structuredClone(state); copy.decisions ||= [];
    const prior = replaces && copy.decisions.find(item => item.id === replaces);
    if (replaces && (!prior || prior.replacedBy || prior.nodeId !== nodeId)) throw new Error('Replacement must reference a current decision in this node');
    const entry = { id: crypto.randomUUID(), nodeId, kind, text: text.trim(), reason: reason.trim(), source: 'ai', sessionId: session.sessionId, time: new Date().toISOString(), ...(replaces ? { replaces } : {}) };
    if (prior) prior.replacedBy = entry.id;
    copy.decisions.push(entry);
    for (const node of copy.nodes) if (node.qualityReview && (nodeId === 'root' || node.id === nodeId)) node.qualityReview.decisionsChanged = true;
    await writeFile(file + '.tmp', JSON.stringify(copy, null, 2)); await rename(file + '.tmp', file); state = copy;
    return structuredClone(entry);
  });
  const getNode = (id, session = {}) => {
    if (!state.nodes.some(n => n.id === id)) return Promise.reject(new Error('Node not found'));
    return locked(async () => {
    const copy = structuredClone(state), node = copy.nodes.find(n => n.id === id);
    if (!node) throw new Error('Node not found');
    if (!session.sessionId) throw new Error('Session required');
    node.requirementReceipt = { count: node.tasks.length, time: new Date().toISOString(), sessionId: session.sessionId, label: session.label };
    await writeFile(file + '.tmp', JSON.stringify(copy, null, 2));
    await rename(file + '.tmp', file);
    state = copy;
    return { ...structuredClone(node), reviewCurrent: reviewCurrent(node, evidence.get()) };
    });
  };
  function applyAction({ action, id, text }, source = 'manual', session = {}) {
    return locked(async () => {
      const node = state.nodes.find(n => n.id === id);
      if (!node || !['add', 'rename', 'request', 'start', 'pause', 'record', 'submit', 'accept', 'reopen', 'goal', 'scope', 'criteria'].includes(action)) throw new Error('任务或节点不存在');
      if (node.status === 'active' && node.owner && node.owner.sessionId !== session.sessionId && action !== 'add' && !(source === 'manual' && ['pause', 'request', 'record'].includes(action))) throw new Error('这个任务正在由另一会话处理，请先由原会话暂停，或由用户暂停');
      if (action === 'accept' && (source !== 'manual' || node.status !== 'review')) throw new Error('只有待验收的功能可以由用户确认');
      if (action === 'submit' && !['active', 'pending'].includes(node.status)) throw new Error('请先建立任务或开始处理');
      if (action === 'reopen' && !['review', 'accepted'].includes(node.status)) throw new Error('只有待验收或已确认的功能可以重新打开');
      if (['add', 'rename', 'request', 'record'].includes(action) && (typeof text !== 'string' || !text.trim() || text.length > 2000)) throw new Error('请填写内容，最多 2000 字');
      if (['goal', 'criteria'].includes(action) && (typeof text !== 'string' || text.length > 2000)) throw new Error('请填写文字，最多 2000 字');
      if (action === 'goal' && id !== 'root') throw new Error('目标属于整个项目');
      if (action === 'scope' && (id === 'root' || !['true', 'false'].includes(text))) throw new Error('请选择具体功能的交付范围');
      if (action === 'accept') {
        await tracker.scan();
        if (!tracker.get().root || !tracker.get().fingerprint || tracker.get().error) throw new Error('请先选择并核对项目版本，再确认验收');
      }
      const copy = structuredClone(state), current = copy.nodes.find(n => n.id === id);
      const value = text?.trim();
      const time = new Date().toISOString();
      let message;
      if (action === 'add') { copy.nodes.push({ id: crypto.randomUUID(), parent: id, title: value, status: 'idle', tasks: [], notes: [] }); message = `新增功能：${value}`; }
      if (action === 'rename') { current.title = value; message = `重命名：${value}`; }
      if (action === 'request') { current.tasks.push({ text: value, time, source }); current.status = 'pending'; message = `提出修改：${value}`; }
      if (action === 'start') { copy.nodes.forEach(n => { if (n.status === 'active' && (!n.owner || n.owner.sessionId === session.sessionId)) { n.status = 'pending'; delete n.owner; } }); current.status = 'active'; current.owner = { sessionId: session.sessionId, label: session.label }; message = '人工标记：开始处理'; }
      if (action === 'pause') { current.status = 'pending'; message = '人工标记：暂停处理'; }
      if (action === 'record') { current.notes.push({ text: value, time, source }); message = `记录：${value}`; }
      if (action === 'submit') { current.status = 'review'; message = '开发完成，提交用户验收'; }
      if (action === 'accept') { current.status = 'accepted'; current.acceptance = { fingerprint: tracker.get().fingerprint, time }; message = '用户确认当前版本验收'; }
      if (action === 'reopen') { current.status = 'pending'; message = '重新打开任务'; }
      if (action === 'goal') { copy.release = { ...copy.release, goal: value }; copy.nodes.forEach(n => { if (n.qualityReview) n.qualityReview.decisionsChanged = true; }); message = `本版目标：${value}`; }
      if (action === 'scope') { current.releaseIncluded = text === 'true'; message = current.releaseIncluded ? '纳入本版交付清单' : '移出本版交付清单'; }
      if (action === 'criteria') { current.criteria = value; if (current.status === 'accepted') { current.status = 'review'; current.statusSource = source; } message = `试用通过条件：${value}`; }
      if (['start', 'pause', 'request', 'submit', 'accept', 'reopen'].includes(action)) current.statusSource = source;
      if (current.status !== 'active') delete current.owner;
      const origin = source === 'ai' ? 'AI 自报' : '人工记录';
      if (action === 'start') message = '开始处理';
      if (action === 'pause') message = '暂停处理';
      copy.events.unshift({ id: crypto.randomUUID(), node: id, title: current.title, message: `${origin}：${message}`, time, source, sessionId: session.sessionId });
      await writeFile(file + '.tmp', JSON.stringify(copy, null, 2));
      await rename(file + '.tmp', file);
      state = copy;
      return getState();
    });
  }
  const runTests = (id, session = {}) => {
    if (testing) return Promise.reject(new Error('已有测试正在执行'));
    testing = true;
    return locked(() => {
      if (!state.nodes.some(n => n.id === id)) throw new Error('节点不存在');
    }).then(() => tracker.run(id, session.sessionId)).finally(() => { testing = false; });
  };
  const linkEvidence = ({ kind, changeId, id }, source = 'manual', session = {}) => locked(async () => {
    if (id !== null && !state.nodes.some(n => n.id === id)) throw new Error('节点不存在');
    return tracker.link(kind, changeId, id, source, session.sessionId);
  });
  const getHandoff = (compact = true) => locked(async () => {
    // A failed scan is preserved in the evidence so an export cannot imply freshness.
    try { await tracker.scan(); } catch { /* evidence.scan persists the error */ }
    const handoff = buildHandoff(structuredClone(state), structuredClone(tracker.get()));
    return compact ? compactHandoff(handoff) : handoff;
  });
  const getOverview = (scan = true) => locked(async () => {
    if (scan) try { await tracker.scan(); } catch { /* scanner records the error */ }
    return buildOverview(state, evidence.get());
  });
  const appendJournal = (args, session = {}) => locked(async () => {
    if (typeof args.projectRoot !== 'string' || !activeRoot) throw new Error('Journal requires the selected projectRoot');
    const resolved = await realpath(args.projectRoot);
    if (canonicalKey(resolved) !== canonicalKey(activeRoot)) throw new Error('Journal projectRoot does not match the selected project');
    const content = validateJournal({ ...args, projectRoot: resolved }, state, tracker.get());
    try { await tracker.scan(); } catch (error) { throw new Error(`Journal scan failed: ${error.message}`); }
    const observed = tracker.get();
    if (observed.error || !observed.fingerprint) throw new Error('Journal requires a successful project scan');
    const entry = { id: crypto.randomUUID(), ...content, source: 'ai', time: new Date().toISOString(), fingerprint: observed.fingerprint, projectRoot: activeRoot, sessionId: session.sessionId };
    const copy = { ...state, journal: [...(state.journal || []), entry] };
    await writeFile(file + '.tmp', JSON.stringify(copy, null, 2));
    await rename(file + '.tmp', file);
    state = copy;
    return structuredClone(entry);
  });
  const getJournal = filters => locked(() => selectJournal(state, tracker.get(), filters));

  const waitForIdle = async () => { await queue; await tracker.waitForIdle(); };
  return { getState, getNode, getDecisions, recordDecision, setAcceptancePlan, recordQualityReview, applyAction, evidence, runTests, linkEvidence, getHandoff, getOverview, appendJournal, getJournal, waitForIdle };
}
