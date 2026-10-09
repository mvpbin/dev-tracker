import { readFile, writeFile, rename, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createEvidence } from './evidence.js';
import { buildHandoff } from './handoff.js';
import { compactHandoff } from './compact-handoff.js';
import { buildOverview, acceptanceState } from './overview.js';
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
    const { journal, ...snapshot } = state;
    return { ...snapshot, nodes: state.nodes.map(node => node.status === 'accepted' ? { ...node, ...acceptanceState(node, evidence.get()) } : node) };
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
      if (action === 'goal') { copy.release = { ...copy.release, goal: value }; message = `本版目标：${value}`; }
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
    return locked(async () => {
      if (!state.nodes.some(n => n.id === id)) throw new Error('节点不存在');
      return tracker.run(id, session.sessionId);
    }).finally(() => { testing = false; });
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
  return { getState, applyAction, evidence, runTests, linkEvidence, getHandoff, getOverview, appendJournal, getJournal, waitForIdle };
}
