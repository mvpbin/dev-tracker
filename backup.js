import { readdir, lstat, readFile, writeFile, mkdir, rename, rm, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const allowed = /^(?:active-project\.json|sessions\.json|project\.json|evidence\.json|projects\/[a-f0-9]{64}\/(?:project|evidence)\.json)$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const rootKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const projectHash = value => createHash('sha256').update(rootKey(value)).digest('hex');
const records = values => Array.isArray(values) && values.every(object);
function validateRecord(name, content) {
  const value = JSON.parse(content);
  if (!object(value)) throw new Error(`Invalid record: ${name}`);
  if (name.endsWith('project.json') && name !== 'active-project.json') {
    if (!records(value.nodes) || !records(value.events) || !value.nodes.some(n => n.id === 'root') || value.nodes.some(n => typeof n.id !== 'string' || typeof n.title !== 'string' || !records(n.tasks) || !records(n.notes) || n.tasks.some(t => typeof t.text !== 'string') || n.notes.some(t => typeof t.text !== 'string') || (n.criteria !== undefined && typeof n.criteria !== 'string')) || value.events.some(e => typeof e.message !== 'string') || (value.journal !== undefined && !records(value.journal)) || (value.release !== undefined && (!object(value.release) || typeof value.release.goal !== 'string'))) throw new Error(`Invalid map: ${name}`);
    if (new Set(value.nodes.map(n => n.id)).size !== value.nodes.length) throw new Error(`Duplicate node: ${name}`);
  } else if (name.endsWith('evidence.json')) {
    if (!(value.root === null || typeof value.root === 'string') || !object(value.files) || !records(value.changes) || !records(value.tests) || value.tests.some(t => typeof t.fingerprint !== 'string') || (value.gitChanges !== undefined && !records(value.gitChanges))) throw new Error(`Invalid evidence: ${name}`);
    if (name.startsWith('projects/') && (!value.root || projectHash(value.root) !== name.split('/')[1])) throw new Error(`Project identity mismatch: ${name}`);
  } else if (name === 'sessions.json') {
    if (Object.entries(value).some(([id, s]) => !object(s) || s.sessionId !== id || !(s.projectRoot === null || typeof s.projectRoot === 'string') || (s.label !== undefined && typeof s.label !== 'string'))) throw new Error('Invalid sessions');
  } else if (!(value.root === null || typeof value.root === 'string')) throw new Error('Invalid selected project');
  return value;
}
export function validateBackup(archive) {
  if (!object(archive) || archive.format !== 'dev-tracker-records' || archive.version !== 1 || !Array.isArray(archive.entries) || archive.entries.length > 20000) throw new Error('Invalid backup format');
  const seen = new Set();
  for (const entry of archive.entries) {
    if (!object(entry) || typeof entry.path !== 'string' || allowed.exec(entry.path)?.[0] !== entry.path || seen.has(entry.path) || typeof entry.content !== 'string') throw new Error('Invalid or duplicate backup path');
    seen.add(entry.path); validateRecord(entry.path, entry.content);
  }
  if (!seen.has('sessions.json')) throw new Error('Backup is missing sessions');
  const selected = archive.entries.find(e => e.path === 'active-project.json');
  if (selected && JSON.parse(selected.content).root && !seen.has(`projects/${projectHash(JSON.parse(selected.content).root)}/evidence.json`)) throw new Error('Backup is missing selected project evidence');
  return archive;
}
async function safe(storage, relative) {
  let target = storage;
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Record symlinks are not supported'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
async function recordPaths(storage) {
  const names = ['active-project.json', 'sessions.json', 'project.json', 'evidence.json'];
  const directory = await safe(storage, 'projects');
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error('Record symlinks are not supported');
      if (entry.isDirectory()) names.push(`projects/${entry.name}/project.json`, `projects/${entry.name}/evidence.json`);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return names;
}
export async function createBackup(storage) {
  const entries = await readRawRecords(storage);
  return validateBackup({ format: 'dev-tracker-records', version: 1, createdAt: new Date().toISOString(), entries });
}
async function readRawRecords(storage) {
  const entries = [];
  for (const name of await recordPaths(storage)) {
    try { entries.push({ path: name, content: await readFile(await safe(storage, name), 'utf8') }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return entries;
}
export async function restoreBackup(storage, archive) {
  validateBackup(archive);
  const selected = archive.entries.find(e => e.path === 'active-project.json');
  if (selected && JSON.parse(selected.content).root) {
    const root = await realpath(JSON.parse(selected.content).root), managed = path.relative(path.join(storage, 'projects'), root);
    if (rootKey(root) === rootKey(path.resolve(storage)) || (!managed.startsWith('..') && !path.isAbsolute(managed))) throw new Error('Selected project cannot be Tracker record storage');
  }
  const old = { entries: await readRawRecords(storage) };
  for (const entry of [...old.entries, ...archive.entries]) await safe(storage, entry.path);
  const stage = await mkdtemp(path.join(storage, '.restore-'));
  const moved = [], installed = [];
  try {
    for (const [index, entry] of archive.entries.entries()) await writeFile(path.join(stage, `new-${index}`), entry.content);
    for (const [index, entry] of old.entries.entries()) {
      const source = await safe(storage, entry.path), saved = path.join(stage, `old-${index}`);
      await rename(source, saved); moved.push({ source, saved });
    }
    for (const [index, entry] of archive.entries.entries()) {
      const target = await safe(storage, entry.path);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(path.join(stage, `new-${index}`), target); installed.push(target);
    }
  } catch (error) {
    try {
      for (const target of installed) await rm(target);
      for (const { source, saved } of moved) await rename(saved, source);
    } catch (rollback) {
      const failure = new Error(`Restore failed; rollback failed. Original records retained at ${stage}: ${rollback.message}`, { cause: error });
      failure.restartRequired = true; throw failure;
    }
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  try { await rm(stage, { recursive: true, force: true }); }
  catch (error) { return { restartRequired: true, cleanupWarning: `Original record staging retained at ${stage}: ${error.message}` }; }
  return { restartRequired: true };
}
