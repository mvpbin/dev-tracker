import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorktree } from '../worktrees.js';
import { startServer } from '../server.js';

const exec = promisify(execFile);
test('parallel checkouts isolate file writes and preserve the committed source version', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dev-tracker-worktrees-'));
  const repo = path.join(base, 'repo'), store = path.join(base, 'store');
  await mkdir(repo);
  const git = args => exec('git', ['-C', repo, ...args], { windowsHide: true });
  try {
    await assert.rejects(createWorktree(repo, store), /Git/);
    await git(['init']);
    await assert.rejects(createWorktree(repo, store), /Git/);
    await writeFile(path.join(repo, 'value.txt'), 'original');
    await git(['add', '.']);
    await git(['-c', 'user.name=Tracker Test', '-c', 'user.email=tracker@example.invalid', 'commit', '-m', 'Initial']);
    const first = await createWorktree(repo, store), second = await createWorktree(repo, store);
    assert.notEqual(first.root, second.root);
    assert.notEqual(first.branch, second.branch);
    assert.equal(first.baseHead, second.baseHead);
    await writeFile(path.join(first.root, 'value.txt'), 'first chat');
    assert.equal(await readFile(path.join(repo, 'value.txt'), 'utf8'), 'original');
    assert.equal(await readFile(path.join(second.root, 'value.txt'), 'utf8'), 'original');
    await writeFile(path.join(repo, 'value.txt'), 'uncommitted');
    await assert.rejects(createWorktree(repo, store), /未保存到 Git/);
    assert.equal(await readFile(path.join(repo, 'value.txt'), 'utf8'), 'uncommitted');
    assert.equal((await git(['rev-parse', 'HEAD'])).stdout.trim(), first.baseHead, 'creating copies never commits or merges the original');
  } finally {
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    assert.ok(path.basename(base).startsWith('dev-tracker-worktrees-'));
    await rm(base, { recursive: true, force: true });
  }
});

test('parallel window origin and branch survive restart and explicit chat binding', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dev-tracker-worktrees-'));
  const repo = path.join(base, 'repo'), storage = path.join(base, 'store');
  let server;
  try {
    await mkdir(repo);
    const git = args => exec('git', ['-C', repo, ...args], { windowsHide: true });
    await git(['init']);
    await writeFile(path.join(repo, 'value.txt'), 'original');
    await git(['add', '.']);
    await git(['-c', 'user.name=Tracker Test', '-c', 'user.email=tracker@example.invalid', 'commit', '-m', 'Initial']);
    server = await startServer({ storage, port: 0 });
    const window = await server.createWindow();
    await server.selectProject(repo, window.id);
    const copy = await server.createParallelWindow(window.id);
    await new Promise(resolve => server.close(resolve));
    server = await startServer({ storage, port: 0 });
    const session = await server.bindSession({ projectRoot: copy.root, label: 'Resumed copy' });
    assert.equal(session.worktree.sourceRoot, repo);
    assert.equal(session.worktree.branch, copy.branch);
    assert.equal(session.worktree.baseHead, copy.baseHead);
    const context = await server.resolveContext({}, session);
    assert.equal(context.projectRoot, copy.root);
    assert.match((await context.getHandoff()).markdown, /sourceRoot/);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    assert.ok(path.basename(base).startsWith('dev-tracker-worktrees-'));
    await rm(base, { recursive: true, force: true });
  }
});
