import { mkdir, lstat, writeFile, rename, readFile, rm, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "''")}'`;

export async function protectDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error('Pipe discovery directory must be absolute');
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Pipe discovery directory cannot be a symbolic link');
  if (process.platform !== 'win32') { await chmod(directory, 0o700); return { platform: process.platform, mode: '0700' }; }
  const sid = (await exec('powershell.exe', ['-NoProfile', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { windowsHide: true })).stdout.trim();
  if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new Error('Could not identify the current Windows account');
  await exec('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true });
  const script = `$ErrorActionPreference='Stop'; $a=[System.IO.Directory]::GetAccessControl(${quote(directory)}); $r=@($a.Access | ForEach-Object { @{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;type=[string]$_.AccessControlType;inherited=$_.IsInherited;rights=[string]$_.FileSystemRights} }); @{protected=$a.AreAccessRulesProtected;rules=$r}|ConvertTo-Json -Depth 4 -Compress`;
  const acl = JSON.parse((await exec('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true })).stdout);
  if (!acl.protected || !acl.rules.length || acl.rules.some(rule => rule.sid !== sid || rule.type !== 'Allow') || !acl.rules.some(rule => rule.rights.includes('FullControl'))) throw new Error(`Pipe discovery ACL is not restricted to the current account: ${JSON.stringify(acl)}`);
  return { platform: 'win32', accountSid: sid, ...acl };
}

export async function writeDiscovery(directory, discovery) {
  const configPath = path.join(directory, 'discovery.json'), temporary = path.join(directory, `discovery-${discovery.runId}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(discovery, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temporary, configPath);
    return configPath;
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

export async function removeDiscovery(configPath, runId) {
  try { if (JSON.parse(await readFile(configPath, 'utf8')).runId === runId) await rm(configPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
