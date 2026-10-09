import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { listPackage, extractFile } = require('@electron/asar');
const { minimatch } = require('minimatch');
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const directory = path.resolve(root, pkg.build.directories.output, pkg.version);
const archive = path.resolve(process.argv[2] || path.join(directory, 'win-unpacked/resources/app.asar'));
const installer = path.resolve(process.argv[3] || path.join(directory, `${pkg.build.productName} Setup ${pkg.version}.exe`));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const patterns = pkg.build.files;
assert.ok(patterns.every(pattern => typeof pattern === 'string'), 'release check requires explicit string build.files patterns');
const matches = name => patterns.filter(pattern => !pattern.startsWith('!')).some(pattern => minimatch(name, pattern, { dot: true })) && !patterns.filter(pattern => pattern.startsWith('!')).some(pattern => minimatch(name, pattern.slice(1), { dot: true }));
const sourceFiles = [];
async function walk(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (['.git', 'node_modules', 'dist', '.data', '.demo', 'test-results'].includes(entry.name)) continue;
    if (entry.isDirectory()) await walk(path.join(directory, entry.name), name + '/');
    else if (entry.isFile() && matches(name)) sourceFiles.push(name);
  }
}
await walk(root);
const archiveFiles = listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''));
const privatePaths = archiveFiles.filter(name => name.split('/').some(part => ['.demo', '.data', 'test-results'].includes(part)));
assert.deepEqual(privatePaths, [], 'packaged app must exclude user/demo/test output data');
const packed = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
for (const field of ['version', 'name', 'main']) assert.equal(packed[field], pkg[field], `packaged ${field} must match release source`);
const hashes = [];
for (const name of sourceFiles.sort()) {
  assert.ok(archiveFiles.includes(name), `product file missing from ASAR: ${name}`);
  const sourceHash = digest(await readFile(path.join(root, name)));
  const packagedHash = digest(extractFile(archive, name));
  // Electron Builder normalizes package metadata; its identity is checked above.
  if (name !== 'package.json') assert.equal(packagedHash, sourceHash, `packaged product file differs: ${name}`);
  hashes.push({ file: name, sourceHash, packagedHash, check: name === 'package.json' ? 'identity-fields' : 'exact-bytes' });
}
const extraProductFiles = archiveFiles.filter(name => !name.startsWith('node_modules/') && !sourceFiles.includes(name)).filter(name => {
  try { extractFile(archive, name); return true; } catch { return false; }
});
assert.deepEqual(extraProductFiles, [], 'ASAR must not contain unexpected product files');
assert.ok(path.basename(installer).includes(pkg.version), 'installer filename must identify the source version');
const installerHash = createHash('sha256');
for await (const chunk of createReadStream(installer)) installerHash.update(chunk);
console.log(JSON.stringify({ version: pkg.version, productFiles: hashes.length, privacy: { privatePaths, extraProductFiles }, hashes, installer: { filename: path.basename(installer), bytes: (await stat(installer)).size, sha256: installerHash.digest('hex') } }, null, 2));
