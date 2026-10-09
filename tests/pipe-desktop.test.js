import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron } from 'playwright';
import electron from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('desktop exe MCP shares the map and recovers its private discovery after an owned crash', { timeout: 90000 }, async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'dev-tracker-pipe-ui-'));
  const project = path.join(storage, 'fixture'); await mkdir(project);
  const executablePath = process.env.DEV_TRACKER_EXE || electron;
  const args = process.env.DEV_TRACKER_EXE ? [] : ['.'];
  const bridgeScript = process.env.DEV_TRACKER_EXE
    ? path.join(path.dirname(executablePath), 'resources', 'app.asar', 'mcp-stdio.mjs')
    : path.resolve('mcp-stdio.mjs');
  const env = { ...process.env, DEV_TRACKER_TEST_DATA: storage };
  const configPath = path.join(storage, 'mcp-connection', 'discovery.json');
  let desktop, client, transport;
  const launch = async () => {
    desktop = await _electron.launch({ executablePath, args, env, timeout: 15000 });
    const page = await desktop.firstWindow();
    await page.waitForFunction(() => document.getElementById('window-context').textContent.length > 0);
    return page;
  };
  const bridge = async () => {
    client = new Client({ name: 'desktop-pipe-test', version: '1' });
    transport = new StdioClientTransport({ command: executablePath, args: [bridgeScript, '--config', configPath], env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stderr: 'pipe' });
    transport.stderr.on('data', chunk => process.stderr.write(chunk));
    await client.connect(transport, { timeout: 10000 });
  };
  const call = async (name, arguments_) => {
    const result = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 10000 });
    assert.notEqual(result.isError, true, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  try {
    let page = await launch();
    await desktop.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, project);
    await page.locator('#choose').click();
    await page.locator('#project-path').getByText(project, { exact: true }).waitFor();
    const first = JSON.parse(await readFile(configPath, 'utf8'));
    await bridge();
    const session = await call('bind_session', { projectRoot: project, label: 'Desktop pipe' });
    await call('update_node', { sessionId: session.sessionId, id: 'root', action: 'add', text: 'MCP pipe persisted work' });
    const state = await page.evaluate(async () => (await fetch('api/state')).json());
    assert.ok(state.nodes.some(node => node.title === 'MCP pipe persisted work'), 'the visible desktop and pipe MCP must share one state owner');
    assert.equal((await call('get_handoff', { sessionId: session.sessionId })).snapshot.project.root, project);
    await client.close(); client = undefined;
    assert.equal(transport.pid, null, 'the exe bridge must exit while the desktop remains open');
    const diagnostics = await readFile(path.join(storage, 'diagnostics.jsonl'), 'utf8');
    assert.ok(!diagnostics.includes(first.token), 'authentication credentials must not appear in diagnostics');
    const process_ = desktop.process();
    const exited = once(process_, 'exit');
    await promisify(execFile)('taskkill', ['/PID', String(process_.pid), '/T', '/F']); await exited;
    desktop = undefined;
    page = await launch();
    const second = JSON.parse(await readFile(configPath, 'utf8'));
    assert.notEqual(second.runId, first.runId, 'a stale discovery must rotate after a crash');
    assert.notEqual(second.token, first.token);
    await bridge();
    assert.ok((await call('get_map', { sessionId: session.sessionId })).some(node => node.title === 'MCP pipe persisted work'), 'committed work and the existing chat binding must survive a desktop crash');
    await client.close(); client = undefined;
    await desktop.close(); desktop = undefined;
    await assert.rejects(readFile(configPath), { code: 'ENOENT' }, 'normal quit removes its own discovery');
    await launch();
    await writeFile(configPath, '{');
    await desktop.close(); desktop = undefined;
    const closingDiagnostics = (await readFile(path.join(storage, 'diagnostics.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(closingDiagnostics.some(entry => entry.event === 'error' && entry.stage === 'desktop'), 'corrupt discovery cleanup is reported without blocking desktop quit');
  } finally {
    await client?.close(); await desktop?.close();
    assert.equal(path.dirname(storage), path.resolve(tmpdir()));
    assert.ok(path.basename(storage).startsWith('dev-tracker-pipe-ui-'));
    await rm(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
