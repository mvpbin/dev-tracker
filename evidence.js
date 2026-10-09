import { readdir, readFile, writeFile, rename, mkdir, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readGitDiff } from './git-diff.js';

const exec = promisify(execFile);
const excluded = new Set(['.git', 'node_modules', 'dist', '.data', '.demo', 'test-results']);
const hash = text => createHash('sha256').update(text).digest('hex');
export async function createEvidence(storage, { excludedStorage = storage } = {}) {
  excludedStorage = path.resolve(excludedStorage);
  const file = path.join(storage, 'evidence.json');
  let state = { root: null, files: {}, fingerprint: null, changes: [], tests: [], git: null, error: null };
  try { state = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const item of [...state.changes, ...(state.gitChanges || [])]) item.id ||= randomUUID();
  let queue = Promise.resolve(), running = false;
  const locked = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  async function save() { await mkdir(storage, { recursive: true }); await writeFile(file + '.tmp', JSON.stringify(state, null, 2)); await rename(file + '.tmp', file); }
  async function snapshot(root) {
    const files = {};
    async function walk(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (excluded.has(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        if (path.resolve(absolute) === excludedStorage || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) files[path.relative(root, absolute).replaceAll('\\', '/')] = hash(await readFile(absolute));
      }
    }
    await walk(root);
    let git = { available: false, head: null, status: '' };
    try {
      const status = await exec('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--', '.'], { windowsHide: true, timeout: 10000 });
      git.available = true; git.status = status.stdout;
      try { git.head = (await exec('git', ['-C', root, 'rev-parse', 'HEAD'], { windowsHide: true, timeout: 10000 })).stdout.trim(); }
      catch { git.head = null; }
    } catch (error) { git.error = error.stderr?.trim() || error.message; }
    // Old automatically discovered tests may include files outside this scan scope.
    return { files, git, fingerprint: hash('scanned-node-tests-v2\0' + JSON.stringify(Object.entries(files).sort()) + JSON.stringify(git)) };
  }
  async function scan() {
    if (!state.root) return;
    const next = await snapshot(state.root), time = new Date().toISOString();
    if (state.git && JSON.stringify(state.git) !== JSON.stringify(next.git)) {
      state.gitChanges = [{ id: randomUUID(), before: state.git, after: next.git, time, source: 'observed', node: null }, ...(state.gitChanges || [])].slice(0, 50);
    }
    if (state.fingerprint) for (const name of new Set([...Object.keys(state.files), ...Object.keys(next.files)])) {
      if (state.files[name] !== next.files[name]) state.changes.unshift({ id: randomUUID(), path: name, type: !next.files[name] ? 'deleted' : !state.files[name] ? 'added' : 'modified', before: state.files[name] || null, after: next.files[name] || null, time, source: 'observed', node: null });
    }
    state.changes = state.changes.slice(0, 100);
    Object.assign(state, next, { error: null, scannedAt: time });
    await save();
  }
  return {
    waitForIdle: async () => {
      if (running) throw new Error('测试运行期间不能维护记录');
      await queue;
      if (running) throw new Error('测试运行期间不能维护记录');
    },
    diff: id => locked(async () => {
      const change = state.changes.find(c => c.id === id);
      if (!change || !state.root) throw new Error('文件变化记录不存在或已过期');
      const result = await readGitDiff(state.root, change.path);
      return { ...result, changeId: id, before: change.before, after: change.after, currentMatchesRecorded: result.currentHash === change.after, scope: 'current-git' };
    }),
    link: (kind, id, node, source, sessionId) => locked(async () => {
      const item = (kind === 'file' ? state.changes : kind === 'git' ? state.gitChanges || [] : []).find(c => c.id === id);
      if (!item) throw new Error('变化记录不存在或已过期');
      item.node = node; item.association = { source, time: new Date().toISOString(), ...(sessionId ? { sessionId } : {}) };
      await save(); return item;
    }),
    get: () => ({ ...state, files: undefined, running, tests: state.tests.map(t => ({ ...t, current: t.fingerprint === state.fingerprint && !state.error })) }),
    scan: () => locked(async () => { try { await scan(); } catch (e) { state.error = e.message; await save(); throw e; } }),
    select: root => locked(async () => {
      if (running) throw new Error('测试运行期间不能更换项目');
      const resolved = await realpath(root);
      if (resolved === state.root) { await scan(); return; }
      const baseline = await snapshot(resolved);
      state = { root: resolved, ...baseline, changes: [], gitChanges: [], tests: [], error: null, scannedAt: new Date().toISOString() }; await save();
    }),
    run: async (node, sessionId) => {
      if (running) throw new Error('已有测试正在执行');
      running = true;
      try {
        const { before, testFiles } = await locked(async () => {
          await scan();
          if (!state.root) throw new Error('请先选择项目');
          const testFiles = Object.keys(state.files).filter(name => {
            const parts = name.split('/'), filename = parts.pop();
            if (!/\.(?:js|mjs|cjs)$/.test(filename)) return false;
            const stem = filename.replace(/\.(?:js|mjs|cjs)$/, '');
            return parts.includes('test') || /(?:^test$|^test-|[._-]test$)/.test(stem);
          }).sort();
          return { before: state.fingerprint, testFiles };
        });
        const root = state.root, startedAt = new Date().toISOString();
        // Only Node's test runner is exposed; no shell strings or caller-supplied commands.
        let exitCode = null, stdout = '', stderr = '';
        const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
        if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
        else delete env.ELECTRON_RUN_AS_NODE;
        const args = ['--test', '--test-reporter=tap', ...testFiles.map(name => './' + name)];
        if (!testFiles.length) stderr = '项目扫描范围内没有 Node.js 测试文件，未执行测试';
        else {
          try { ({ stdout, stderr } = await exec(process.execPath, args, { cwd: root, env, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 })); exitCode = 0; }
          catch (e) { exitCode = e.code ?? null; stdout = e.stdout || ''; stderr = e.stderr || e.message; }
        }
        return await locked(async () => {
          await scan();
          const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'todo'].map(key => [key, Number(stdout.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)]));
          const result = { node, command: testFiles.length ? 'node --test --test-reporter=tap <testFiles>' : '未执行：无匹配测试文件', testFiles, args, startedAt, time: new Date().toISOString(), fingerprint: before, after: state.fingerprint, exitCode, stdout, stderr, counts, passed: exitCode === 0 && counts.pass > 0 && counts.fail === 0 && counts.skipped === 0 && counts.todo === 0, unchanged: before === state.fingerprint, source: 'executed' };
          if (sessionId) result.sessionId = sessionId;
          state.tests.unshift(result); state.tests = state.tests.slice(0, 20); await save(); return result;
        });
      } finally { running = false; }
    }
  };
}
