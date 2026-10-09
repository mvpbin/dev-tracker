import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const exec = promisify(execFile);
export async function createWorktree(projectRoot, storage) {
  const sourceRoot = await realpath(projectRoot);
  const git = async args => (await exec('git', ['-C', sourceRoot, ...args], { windowsHide: true, timeout: 30000 })).stdout.trim();
  let top, baseHead;
  try { top = await realpath(await git(['rev-parse', '--show-toplevel'])); baseHead = await git(['rev-parse', '--verify', 'HEAD']); }
  catch { throw new Error('并行副本需要已有 Git 提交的项目，请先让 AI 整理项目版本'); }
  const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (key(top) !== key(sourceRoot)) throw new Error('请选择 Git 项目的最外层文件夹再建立并行副本');
  if (await git(['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('原项目有未保存到 Git 的改动，请先让 AI 整理后再建立副本');
  const id = randomUUID(), branch = `dev-tracker/${id}`;
  const directory = path.resolve(storage, 'worktrees');
  await mkdir(directory, { recursive: true });
  const root = path.join(directory, id);
  await git(['worktree', 'add', '-b', branch, root, baseHead]);
  return { root: await realpath(root), branch, sourceRoot, baseHead };
}
