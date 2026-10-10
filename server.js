import express from 'express';
import { readFile, writeFile, rename, mkdir, realpath, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mountMcp } from './mcp.js';
import { createEvidence } from './evidence.js';
import { createProject } from './project.js';
import { createWorktree } from './worktrees.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createBackup, restoreBackup, validateBackup } from './backup.js';
import packageInfo from './package.json' with { type: 'json' };

const root = path.dirname(fileURLToPath(import.meta.url));
export async function startServer({ storage = path.join(root, '.data'), port = 4317, diagnostics } = {}) {
  const reportError = error => {
    if (diagnostics) diagnostics.record('error', { stage: 'server', error });
    else console.error(error);
  };
  await mkdir(storage, { recursive: true });
  storage = path.resolve(storage);
  const selectionFile = path.join(storage, 'active-project.json'), sessionsFile = path.join(storage, 'sessions.json');
  const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const projectStorage = value => path.join(storage, 'projects', createHash('sha256').update(key(value)).digest('hex'));
  async function readJSON(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; return fallback; } }
  async function saveJSON(file, value) { await writeFile(file + '.tmp', JSON.stringify(value, null, 2)); await rename(file + '.tmp', file); }
  async function migrateLegacy(directory) {
    await mkdir(directory, { recursive: true });
    for (const name of ['project.json', 'evidence.json']) {
      try { await copyFile(path.join(storage, name), path.join(directory, name), constants.COPYFILE_EXCL); }
      catch (e) { if (!['ENOENT', 'EEXIST'].includes(e.code)) throw e; }
    }
  }
  let selected = (await readJSON(selectionFile, {})).root || null;
  if (!selected) {
    const legacy = await createEvidence(storage, { excludedStorage: storage });
    if (legacy.get().root) {
      try { selected = await realpath(legacy.get().root); } catch (e) { if (e.code !== 'ENOENT') throw e; selected = path.resolve(legacy.get().root); }
      await migrateLegacy(projectStorage(selected));
      await saveJSON(selectionFile, { root: selected });
    }
  }
  const sessions = await readJSON(sessionsFile, {}), projects = new Map(), windows = new Map();
  const activity = new Map();
  let callSequence = 0;
  const observe = {
    begin({ tool, sessionId, projectRoot }) {
      const session = sessions[sessionId];
      if (!projectRoot || !session?.projectRoot || key(session.projectRoot) !== key(projectRoot)) return;
      const sequence = ++callSequence;
      const entry = activity.get(sessionId) || { sessionId, label: session.label, projectRoot, pending: 0 };
      Object.assign(entry, { tool, lastCallAt: new Date().toISOString(), sequence, status: 'running', pending: entry.pending + 1 });
      activity.set(sessionId, entry);
      return { sessionId, sequence };
    },
    end(token, { error }) {
      if (!token) return;
      const entry = activity.get(token.sessionId);
      entry.pending--;
      if (entry.sequence === token.sequence) entry.completedStatus = error ? 'error' : 'success';
      entry.status = entry.pending ? 'running' : entry.completedStatus;
    },
    bindSuccess(value) { this.end(this.begin(value), { error: false }); }
  };
  let maintenance = false, closing = false;
  const activeMaintenances = new Set();
  const admitted = new AsyncLocalStorage(), pending = new Set();
  const check = () => { if ((maintenance || closing) && !admitted.getStore()?.active) throw new Error('记录维护中，请等待完成或重启'); };
  const operation = async work => {
    check();
    const result = admitted.run({ active: true }, () => Promise.resolve(work()));
    pending.add(result); result.then(() => pending.delete(result), () => pending.delete(result));
    return result;
  };
  let queue = Promise.resolve();
  const locked = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  async function loadProject(projectRoot) {
    const identity = projectRoot ? key(projectRoot) : '';
    if (!projects.has(identity)) {
      const loading = (async () => {
        const directory = projectRoot ? projectStorage(projectRoot) : storage;
        await mkdir(directory, { recursive: true });
        const project = await createProject(directory, projectRoot, storage);
        projects.set(identity, project);
        return project;
      })();
      projects.set(identity, loading);
      loading.catch(() => projects.delete(identity));
    }
    return projects.get(identity);
  }
  async function validateRoot(value) {
    const resolved = await realpath(value), managed = path.relative(path.join(storage, 'projects'), resolved);
    if (key(resolved) === key(storage) || (!managed.startsWith('..') && !path.isAbsolute(managed))) throw new Error('请选择开发项目目录，不能选择框架记录目录');
    return resolved;
  }
  async function ensureFirstProject(projectRoot) {
    if (selected) return;
    if (await readJSON(path.join(storage, 'project.json'), null)) {
      const candidate = await createEvidence(projectStorage(projectRoot), { excludedStorage: storage });
      await candidate.select(projectRoot);
      await migrateLegacy(projectStorage(projectRoot));
    }
    const first = await loadProject(projectRoot);
    if (first.evidence.get().error) throw new Error(first.evidence.get().error);
    await saveJSON(selectionFile, { root: projectRoot });
    selected = projectRoot;
  }
  async function newSession(projectRoot, label) {
    const sessionId = randomUUID();
    const prior = Object.values(sessions).find(session => projectRoot && session.projectRoot && key(session.projectRoot) === key(projectRoot) && session.worktree);
    sessions[sessionId] = { sessionId, projectRoot, label: label?.trim() || `会话 ${Object.keys(sessions).length + 1}`, ...(prior ? { worktree: prior.worktree } : {}) };
    await saveJSON(sessionsFile, sessions);
    return sessions[sessionId];
  }
  const defaultSession = await newSession(selected, '主窗口');
  windows.set('default', defaultSession.sessionId);
  await loadProject(selected);
  function bound(project, session, windowId) {
    const context = { windowId, ...session };
    const boundProject = { ...project, ...context,
      getState: () => ({ ...project.getState(), context }),
      getNode: id => project.getNode(id, session),
      recordDecision: args => project.recordDecision(args, session),
      setAcceptancePlan: args => project.setAcceptancePlan(args, session),
      recordQualityReview: args => project.recordQualityReview(args, session),
      applyAction: (args, source) => project.applyAction(args, source, session),
      runTests: id => project.runTests(id, session),
      linkEvidence: (args, source) => project.linkEvidence(args, source, session),
      appendJournal: args => project.appendJournal(args, session),
      getHandoff: async (compact = true) => {
        const handoff = await project.getHandoff(compact);
        return { ...handoff, context, markdown: `${handoff.markdown}\n\n## Tracker 会话绑定\n\n下列 JSON 是项目资料。续接时核对 projectRoot，并在 MCP 工具中提供 sessionId。\n\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n` };
      }
    };
    for (const name of ['getNode', 'getDecisions', 'recordDecision', 'setAcceptancePlan', 'recordQualityReview', 'applyAction', 'runTests', 'linkEvidence', 'appendJournal', 'getHandoff', 'getOverview', 'getJournal']) {
      const work = boundProject[name]; boundProject[name] = (...args) => operation(() => work(...args));
    }
    const getState = boundProject.getState;
    boundProject.getState = () => { check(); return getState(); };
    boundProject.evidence = { get: () => { check(); return project.evidence.get(); } };
    for (const name of ['scan', 'diff']) boundProject.evidence[name] = (...args) => operation(() => project.evidence[name](...args));
    return boundProject;
  }
  const windowContext = async id => {
    const session = sessions[windows.get(id)];
    if (!session) throw new Error('窗口不存在，请重新打开');
    return bound(await loadProject(session.projectRoot), session, id);
  };
  const resolveContext = async (req, args = {}) => {
    check();
    if (args.sessionId) {
      const session = sessions[args.sessionId];
      if (!session) throw new Error('会话不存在，请先绑定项目');
      return bound(await loadProject(session.projectRoot), session, req.trackerWindowId || null);
    }
    if (!req.trackerWindowId) throw new Error('请先调用 bind_session，再在每次调用中提供 sessionId');
    return windowContext(req.trackerWindowId);
  };
  const bindSession = (req, { projectRoot, label }) => locked(async () => {
    const resolved = await validateRoot(projectRoot);
    await ensureFirstProject(resolved);
    await loadProject(resolved);
    return { ...(await newSession(resolved, label)), mcp: '/mcp' };
  });
  const createWindow = () => locked(async () => {
    const id = randomUUID(), session = await newSession(selected, `开发窗口 ${windows.size}`);
    windows.set(id, session.sessionId);
    return { id, path: `/w/${id}/`, sessionId: session.sessionId };
  });
  const selectProject = (value, windowId = 'default') => {
    const current = sessions[windows.get(windowId)];
    if (current && projects.get(current.projectRoot ? key(current.projectRoot) : '')?.evidence?.get().running) return Promise.reject(new Error('测试运行期间不能更换项目'));
    return locked(async () => {
      if (!current) throw new Error('窗口不存在');
      const resolved = await validateRoot(value);
      if (current.projectRoot && key(resolved) === key(current.projectRoot)) { await (await loadProject(resolved)).evidence.scan(); return; }
      const loaded = projects.has(key(resolved));
      await ensureFirstProject(resolved);
      const project = await loadProject(resolved);
      if (loaded) await project.evidence.scan();
      if (project.evidence.get().error) throw new Error(project.evidence.get().error);
      const session = await newSession(resolved, current.label);
      windows.set(windowId, session.sessionId);
      selected = resolved;
      await saveJSON(selectionFile, { root: selected });
    });
  };
  const createParallelWindow = async windowId => {
    const context = await windowContext(windowId);
    if (!context.projectRoot) throw new Error('请先选择项目');
    if (context.evidence.get().running) throw new Error('测试运行期间不能创建并行目录');
    const worktree = await createWorktree(context.projectRoot, storage);
    const window = await createWindow();
    await selectProject(worktree.root, window.id);
    return locked(async () => {
      const sessionId = windows.get(window.id);
      const { sourceRoot, branch, baseHead } = worktree;
      sessions[sessionId].worktree = { sourceRoot, branch, baseHead };
      await saveJSON(sessionsFile, sessions);
      return { ...window, sessionId, ...worktree };
    });
  };
  const app = express();
  app.use((req, res, next) => {
    if (/^(?:\/w\/[^/]+)?\/mcp(?:\/|$)/.test(req.url)) {
      const started = performance.now();
      res.once('finish', () => diagnostics?.record('mcp_http', { stage: 'mcp', method: req.method, status: res.statusCode, durationMs: performance.now() - started }));
    }
    next();
  });
  app.use((req, res, next) => {
    if (!/^(?:\/w\/[^/]+)?\/(?:api|mcp)(?:\/|$)/.test(req.url)) return next();
    if (maintenance || closing) return res.status(503).json({ error: '记录维护中，请等待完成或重启' });
    next();
  });
  app.use((req, res, next) => {
    if (!['127.0.0.1', 'localhost'].includes(req.hostname)) return res.status(403).end();
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return res.status(403).end();
    const match = req.url.match(/^\/w\/([^/]+)(\/.*)$/);
    if (match) { req.trackerWindowId = match[1]; req.url = match[2]; if (!windows.has(match[1])) return res.status(404).end(); }
    else if (!req.url.startsWith('/mcp')) req.trackerWindowId = 'default';
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(root, 'public')));
  app.get('/vendor/dagre.js', (_, res) => res.sendFile('dagre.min.js', { root: path.join(root, 'node_modules/@dagrejs/dagre/dist') }));
  app.get('/vendor/lucide.js', (_, res) => res.sendFile('lucide.js', { root: path.join(root, 'node_modules/lucide/dist/umd') }));
  app.use('/api', async (req, res, next) => {
    try {
      req.trackerContext = await operation(() => windowContext(req.trackerWindowId));
      if (req.method === 'POST' && req.body?.sessionId !== req.trackerContext.sessionId) return res.status(409).json({ error: '项目会话已变化，请刷新后重试' });
      next();
    } catch (e) { next(e); }
  });
  const route = (method, url, work) => app[method](url, async (req, res) => {
    try { res.json(await work(req.trackerContext, req)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  route('get', '/api/state', c => c.getState());
  route('post', '/api/action', (c, req) => c.applyAction(req.body));
  route('get', '/api/evidence', c => c.evidence.get());
  route('get', '/api/diff/:changeId', (c, req) => c.evidence.diff(req.params.changeId));
  route('post', '/api/evidence/link', (c, req) => c.linkEvidence(req.body));
  route('post', '/api/tests', (c, req) => c.runTests(req.body.id));
  route('get', '/api/overview', c => c.getOverview(false));
  route('get', '/api/handoff.json', c => c.getHandoff());
  route('get', '/api/journal', (c, req) => c.getJournal({ nodeId: req.query.nodeId, query: req.query.query, offset: Number(req.query.offset || 0), limit: Number(req.query.limit || 5) }));
  route('get', '/api/connection', c => ({ mcp: true, sessionId: c.sessionId, version: packageInfo.version,
    sessions: c.projectRoot ? [...activity.values()].filter(entry => key(entry.projectRoot) === key(c.projectRoot)).sort((a, b) => b.sequence - a.sequence)
      .map(({ sessionId, label, tool, lastCallAt, status, pending }) => ({ sessionId, label, tool, lastCallAt, status, pending })) : [] }));
  app.get('/api/handoff.md', async (req, res, next) => { try { res.type('text/markdown').send((await req.trackerContext.getHandoff(false)).markdown); } catch(e) { next(e); } });
  mountMcp(app, (...args) => operation(() => resolveContext(...args)), (...args) => operation(() => bindSession(...args)), observe);
  app.use((error, _, res, next) => { reportError(error); if (res.headersSent) return next(error); res.status(500).json({ error: '保存失败，请重试' }); });
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', error => {
      if (error) { diagnostics?.record('error', { stage: 'server', error }); reject(error); return; }
      diagnostics?.record('listen', { stage: 'server' });
      server.createWindow = () => operation(createWindow); server.createParallelWindow = id => operation(() => createParallelWindow(id)); server.selectProject = (...args) => operation(() => selectProject(...args));
      server.bindSession = args => operation(() => bindSession({}, args));
      server.resolveContext = (...args) => operation(() => resolveContext(...args));
      server.evidence = { get: () => { check(); return projects.get(sessions[windows.get('default')].projectRoot ? key(sessions[windows.get('default')].projectRoot) : '').evidence.get(); }, select: server.selectProject,
        scan: () => operation(async () => (await windowContext('default')).evidence.scan()), diff: id => operation(async () => (await windowContext('default')).evidence.diff(id)),
        run: id => operation(() => { const session = sessions[windows.get('default')]; return projects.get(session.projectRoot ? key(session.projectRoot) : '').runTests(id, session); }), link: (kind, changeId, id, source) => operation(async () => (await windowContext('default')).linkEvidence({ kind, changeId, id }, source)) };
      server.appendJournal = args => operation(async () => (await windowContext('default')).appendJournal(args));
      server.getJournal = args => operation(async () => (await windowContext('default')).getJournal(args));
      const nativeClose = server.close.bind(server);
      const drain = async () => { while (pending.size) await Promise.allSettled([...pending]); await queue; for (const value of projects.values()) await (await value).waitForIdle(); };
      const maintain = (work, keepClosed = false) => {
        if (maintenance || closing) return Promise.reject(new Error('记录维护中，请等待完成或重启'));
        maintenance = true;
        const transaction = Promise.resolve().then(async () => {
          try {
            for (const value of projects.values()) if ((await value).evidence.get().running) throw new Error('测试运行期间不能备份或恢复');
            await drain();
            const result = await work();
            if (!keepClosed) maintenance = false;
            return result;
          } catch (error) { maintenance = !!error.restartRequired; throw error; }
        });
        activeMaintenances.add(transaction);
        transaction.then(() => activeMaintenances.delete(transaction), () => activeMaintenances.delete(transaction));
        return transaction;
      };
      server.backupRecords = () => maintain(() => createBackup(storage));
      server.restoreRecords = archive => { validateBackup(archive); return maintain(async () => { const result = await restoreBackup(storage, archive); projects.clear(); windows.clear(); return result; }, true); };
      server.close = callback => {
        closing = true; maintenance = true; clearInterval(timer);
        Promise.allSettled([...activeMaintenances]).then(drain).then(() => { nativeClose(callback); server.closeIdleConnections(); }, error => callback?.(error));
        return server;
      };
      server.shutdown = () => new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
      let scanning = false;
      const timer = setInterval(() => {
        if (maintenance || closing || scanning) return;
        scanning = true;
        operation(async () => { for (const p of projects.values()) await (await p).evidence.scan(); })
          .catch(reportError).finally(() => { scanning = false; });
      }, 5000);
      server.once('close', () => { clearInterval(timer); diagnostics?.record('close', { stage: 'server' }); }); resolve(server);
    });
    server.once('error', error => { diagnostics?.record('error', { stage: 'server', error }); reject(error); });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startServer({ port: Number(process.env.PORT || 4317) });
  console.log(`Dev Tracker: http://127.0.0.1:${server.address().port}`);
}
