import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readGitDiff } from '../git-diff.js';

const exec = promisify(execFile);
test('current Git differences separate staged work from later edits without inventing historical evidence', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dev-tracker-diff-'));
  try {
    const root = path.join(base, 'project'); await mkdir(root);
    const git = args => exec('git', ['-C', root, ...args], { windowsHide: true });
    await git(['init']);
    await writeFile(path.join(root, 'code.js'), 'const value = 1;\n');
    await git(['add', '--', 'code.js']);
    assert.match((await readGitDiff(root, 'code.js')).staged, /\+const value = 1;/, 'staged additions must work before the first commit');
    await git(['-c', 'user.name=Diff Test', '-c', 'user.email=diff@example.invalid', 'commit', '-m', 'baseline']);
    assert.match((await readGitDiff(root, 'code.js')).message, /没有未提交/, 'a historical change must not imply there are still working tree differences');
    await git(['config', 'diff.external', 'dev-tracker-missing-external-command']);
    await git(['config', 'diff.disabled.textconv', 'dev-tracker-missing-textconv-command']);
    await writeFile(path.join(root, '.gitattributes'), 'code.js diff=disabled\n');
    await writeFile(path.join(root, 'code.js'), 'const value = 2;\n'); await git(['add', '--', 'code.js']);
    await writeFile(path.join(root, 'code.js'), 'const value = 3;\n');
    const diff = await readGitDiff(root, 'code.js');
    assert.equal(diff.currentHash, createHash('sha256').update('const value = 3;\n').digest('hex'), 'a diff is labeled with current content so an older change record cannot claim this revision');
    assert.equal(diff.available, true); assert.match(diff.staged, /-const value = 1;/); assert.match(diff.staged, /\+const value = 2;/);
    assert.match(diff.unstaged, /-const value = 2;/); assert.match(diff.unstaged, /\+const value = 3;/);
    assert.equal(diff.untracked, null);
    await rm(path.join(root, 'code.js'));
    assert.equal((await readGitDiff(root, 'code.js')).currentHash, null);
    assert.match((await readGitDiff(root, 'code.js')).unstaged, /deleted file mode/, 'deletion still exposes the Git baseline');
    await writeFile(path.join(root, 'new.js'), 'const added = true;\n');
    const added = await readGitDiff(root, 'new.js');
    assert.equal(added.untracked, 'const added = true;\n'); assert.equal(added.staged, ''); assert.equal(added.unstaged, ''); assert.match(added.message, /没有 Git 历史/);
    await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 255]));
    assert.equal((await readGitDiff(root, 'binary.bin')).untracked, null);
    await writeFile(path.join(root, 'invalid.txt'), Buffer.from([255]));
    assert.match((await readGitDiff(root, 'invalid.txt')).message, /非 UTF-8/);
    await writeFile(path.join(root, 'large.txt'), 'x'.repeat(128 * 1024 + 1));
    assert.match((await readGitDiff(root, 'large.txt')).message, /超过 128 KB/);
    await writeFile(path.join(root, 'literal[1].js'), 'literal only\n');
    assert.equal((await readGitDiff(root, 'literal[1].js')).untracked, 'literal only\n', 'filenames must not be interpreted as Git patterns');
    const outside = path.join(base, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'secret.txt'), 'private');
    assert.equal((await readGitDiff(outside, 'secret.txt')).available, false, 'non-Git files must not be presented as measured Git differences');
    for (const unsafe of ['../outside/secret.txt', '/outside/secret.txt', 'C:/outside/secret.txt', './code.js', 'a/../code.js', 'a\\code.js', ':']) {
      await assert.rejects(readGitDiff(root, unsafe), /相对文件路径|超出项目/);
    }
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readGitDiff(root, 'linked/secret.txt'), /符号链接/, 'a directory link cannot expose a file outside the chosen project');
  } finally {
    assert.equal(path.dirname(base), path.resolve(tmpdir())); assert.ok(path.basename(base).startsWith('dev-tracker-diff-'));
    await rm(base, { recursive: true, force: true });
  }
});
