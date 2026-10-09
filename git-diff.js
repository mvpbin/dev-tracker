import { lstat, realpath, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const textLimit = 128 * 1024;

export async function readGitDiff(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') || relativePath.includes('\0') ||
      path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) ||
      relativePath.split('/').some(part => !part || part === '.' || part === '..') || relativePath.includes(':')) {
    throw new Error('只能查看项目内规范的相对文件路径');
  }
  const resolvedRoot = await realpath(root), absolute = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, absolute);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('文件路径超出项目目录');
  let target = resolvedRoot, info;
  for (const part of relativePath.split('/')) {
    target = path.join(target, part);
    try { info = await lstat(target); }
    catch (error) { if (error.code === 'ENOENT') { info = null; break; } throw error; }
    if (info.isSymbolicLink()) throw new Error('不查看符号链接文件或目录中的差异');
  }
  let currentHash = null;
  if (info?.isFile()) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(absolute)) hash.update(chunk);
    currentHash = hash.digest('hex');
  }
  const result = { available: true, path: relativePath, currentHash, staged: '', unstaged: '', untracked: null, message: '' };
  const git = args => exec('git', ['--literal-pathspecs', '-C', resolvedRoot, ...args], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  try {
    if ((await git(['rev-parse', '--is-inside-work-tree'])).stdout.trim() !== 'true') {
      return { ...result, available: false, message: '此目录不是 Git 工作区，无法取得代码差异' };
    }
  } catch (error) {
    if (error.code === 'ENOENT' || (error.code === 128 && /not a git repository/i.test(error.stderr || ''))) {
      return { ...result, available: false, message: error.code === 'ENOENT' ? '未找到 Git，无法取得代码差异' : '此目录不是 Git 工作区，无法取得代码差异' };
    }
    throw new Error('无法读取 Git 工作区：' + (error.stderr?.trim() || error.message));
  }
  try {
    result.staged = (await git(['diff', '--no-ext-diff', '--no-textconv', '--cached', '--', relativePath])).stdout;
    result.unstaged = (await git(['diff', '--no-ext-diff', '--no-textconv', '--', relativePath])).stdout;
    let tracked = true;
    try { await git(['ls-files', '--error-unmatch', '--', relativePath]); }
    catch (error) { if (error.code === 1) tracked = false; else throw error; }
    if (!tracked) {
      if (!info?.isFile()) result.message = '文件当前不存在或不是普通文件';
      else if (info.size > textLimit) result.message = '未跟踪文件超过 128 KB，未显示内容';
      else {
        const bytes = await readFile(absolute);
        if (bytes.length > textLimit) result.message = '未跟踪文件超过 128 KB，未显示内容';
        else {
          try {
            if (bytes.includes(0)) throw new Error('binary');
            result.untracked = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            result.message = '未跟踪文件：显示当前内容，没有 Git 历史可供对比';
          } catch { result.message = '未跟踪文件为二进制或非 UTF-8 文本，未显示内容'; }
        }
      }
    } else if (!result.staged && !result.unstaged) result.message = '此文件当前没有未提交的 Git 差异';
    return result;
  } catch (error) { throw new Error('读取代码差异失败：' + (error.stderr?.trim() || error.message)); }
}
