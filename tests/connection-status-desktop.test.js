import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron } from 'playwright';
import electron from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const run = promisify(execFile);

test('desktop header reports real MCP pipe sessions, status, copy, and responsive failure state', { timeout: 120000 }, async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'dev-tracker-connection-status-'));
  const project = path.join(storage, 'project');
  await mkdir(project);
  const executablePath = process.env.DEV_TRACKER_EXE || electron;
  const launchArgs = process.env.DEV_TRACKER_EXE ? [] : ['.'];
  const bridgeScript = process.env.DEV_TRACKER_EXE
    ? path.join(path.dirname(executablePath), 'resources', 'app.asar', 'mcp-stdio.mjs')
    : path.resolve('mcp-stdio.mjs');
  const env = { ...process.env, DEV_TRACKER_TEST_DATA: storage };
  const configPath = path.join(storage, 'mcp-connection', 'discovery.json');
  let desktop;
  const clients = [];

  const launch = async () => {
    desktop = await _electron.launch({ executablePath, args: launchArgs, env, timeout: 15000 });
    const page = await desktop.firstWindow();
    await page.waitForFunction(() => document.getElementById('window-context')?.textContent.length > 0);
    return page;
  };
  const connectPipe = async () => {
    const client = new Client({ name: 'connection-status-desktop-test', version: '1' });
    const transport = new StdioClientTransport({
      command: executablePath,
      args: [bridgeScript, '--config', configPath],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stderr: 'pipe'
    });
    clients.push({ client, transport });
    await client.connect(transport, { timeout: 10000 });
    return client;
  };
  const call = async (client, name, arguments_) => {
    const result = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 10000 });
    assert.notEqual(result.isError, true, result.content?.[0]?.text || `${name} failed`);
    return JSON.parse(result.content[0].text);
  };
  const waitFor = async (page, predicate, label, timeout = 18000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await predicate()) return;
      await pause(250);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const closeDesktop = async () => {
    if (!desktop) return;
    const instance = desktop;
    desktop = undefined;
    const closed = await Promise.race([instance.close().then(() => true, () => true), pause(8000).then(() => false)]);
    if (!closed) {
      const pid = instance.process()?.pid;
      if (pid) await run('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => {});
    }
  };

  try {
    const page = await launch();
    const initialConnection = await page.evaluate(async () => (await fetch('api/connection')).json());
    assert.equal(initialConnection.sessions.length, 0, 'the initial header must not invent an AI session from the window session');
    assert.equal(await page.locator('#ai-session').textContent(), '尚无 AI 调用');
    assert.equal(await page.locator('#session-count').textContent(), '0');

    await desktop.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, project);
    await page.locator('#choose').click();
    await page.locator('#project-path').getByText(project, { exact: true }).waitFor();
    const windowSessionId = (await page.evaluate(async () => (await fetch('api/state')).json())).context.sessionId;
    const discovery = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(discovery.version, 1);

    const firstClient = await connectPipe();
    const first = await call(firstClient, 'bind_session', { projectRoot: project, label: 'Header Alpha' });
    assert.match(first.sessionId, /^[0-9a-f-]{36}$/i);
    assert.notEqual(first.sessionId, windowSessionId, 'AI session IDs must be distinct from the desktop window session');
    await call(firstClient, 'get_map', { sessionId: first.sessionId });
    await call(firstClient, 'update_node', { sessionId: first.sessionId, id: 'root', action: 'add', text: 'connection status write' });
    await waitFor(page, async () => Number(await page.locator('#session-count').textContent()) === 1, 'first AI session');
    assert.match(await page.locator('#ai-session').textContent(), /^Header Alpha · [0-9a-f]{8}$/i);
    assert.doesNotMatch(await page.locator('#ai-session').textContent(), new RegExp(windowSessionId, 'i'));
    assert.match(await page.locator('#mcp-status').textContent(), /MCP 最近调用成功/);

    const secondClient = await connectPipe();
    const second = await call(secondClient, 'bind_session', { projectRoot: project, label: 'Header Beta' });
    await call(secondClient, 'get_map', { sessionId: second.sessionId });
    await waitFor(page, async () => Number(await page.locator('#session-count').textContent()) === 2, 'two AI sessions');
    await page.locator('#session-details summary').click();
    await page.locator('#session-list .session-row').nth(1).waitFor();
    const listedIds = await page.locator('#session-list code').allTextContents();
    assert.deepEqual(new Set(listedIds), new Set([first.sessionId, second.sessionId]), 'expanded details expose complete session IDs');
    await page.locator('#session-list button').first().focus();
    await pause(2500);
    assert.equal(await page.locator('#session-list button').first().evaluate(element => document.activeElement === element), true, 'idle polling must preserve keyboard focus inside session details');

    const latestId = await page.evaluate(async () => {
      const value = await fetch('api/connection').then(response => response.json());
      const latest = value.sessions.find(session => session.pending > 0) || value.sessions[0];
      return latest.sessionId;
    });
    await desktop.evaluate(({ ipcMain }) => {
      globalThis.connectionStatusCopied = null;
      ipcMain.removeHandler('copy-text');
      ipcMain.handle('copy-text', (_, value) => { globalThis.connectionStatusCopied = value; return true; });
    });
    await page.locator('#session-copy').click();
    await waitFor(page, async () => !!(await desktop.evaluate(() => globalThis.connectionStatusCopied)), 'copied session ID');
    assert.equal(await desktop.evaluate(() => globalThis.connectionStatusCopied), latestId, 'window.desktop.copyText sends the complete latest AI session ID to the mocked clipboard handler');

    const errorResult = await secondClient.callTool({ name: 'get_node', arguments: { sessionId: second.sessionId, id: 'missing-node-for-status-test' } }, undefined, { timeout: 10000 });
    assert.equal(errorResult.isError, true, 'a missing node produces a protocol error for an otherwise valid observed session');
    await waitFor(page, async () => /MCP 最近调用失败/.test(await page.locator('#mcp-status').textContent()), 'failed-call status');

    const packageVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
    assert.equal(await page.locator('#program-version').textContent(), `v${packageVersion}`);
    await mkdir('test-results', { recursive: true });
    for (const width of [1280, 720, 375]) {
      await page.setViewportSize({ width, height: width === 1280 ? 720 : 812 });
      await page.screenshot({ path: `test-results/connection-status-${width}.png` });
      const layout = await page.evaluate(() => {
        const rect = element => element.getBoundingClientRect().toJSON();
        return { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, header: rect(document.querySelector('header')), brand: rect(document.querySelector('.brand')), status: rect(document.getElementById('header-status')) };
      });
      assert.ok(layout.scroll <= layout.client + 1, `${width}px header must not create horizontal overflow`);
      assert.ok(layout.header.bottom <= (width === 1280 ? 720 : 812) + 1);
      if (layout.status?.width > 0 && layout.brand.width > 0) assert.ok(layout.brand.right <= layout.status.left || layout.status.right <= layout.brand.left || layout.brand.bottom <= layout.status.top || layout.status.bottom <= layout.brand.top, `${width}px header controls must not overlap`);
    }

    await page.route('**/api/connection', route => route.abort());
    await waitFor(page, async () => /状态无法确认/.test(await page.locator('#mcp-status').textContent()), 'connection failure wording', 8000);
    assert.equal(await page.locator('#session-copy').isDisabled(), true, 'copy is disabled while connection status is unavailable');
    await page.unroute('**/api/connection');
  } finally {
    await Promise.allSettled(clients.map(({ client }) => Promise.race([client.close(), pause(8000)])));
    await closeDesktop();
    await rm(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(error => console.error('connection-status fixture cleanup failed:', error.message));
  }
});
