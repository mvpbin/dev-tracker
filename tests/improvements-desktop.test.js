import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron } from 'playwright';
import electron from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('desktop exposes real paths and real full-read receipts through the generated MCP configuration', { timeout: 90000 }, async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'tracker-improvements-ui-'));
  const projectRoot = path.join(base, 'project'); await mkdir(projectRoot);
  let desktop, client;
  const executablePath = process.env.DEV_TRACKER_EXE || electron;
  try {
    desktop = await _electron.launch({ executablePath, args: process.env.DEV_TRACKER_EXE ? [] : ['.'], env: { ...process.env, DEV_TRACKER_TEST_DATA: base }, timeout: 15000 });
    const page = await desktop.firstWindow();
    await page.waitForFunction(() => window.desktop && document.getElementById('title').textContent);
    const config = await page.evaluate(() => window.desktop.mcpConfig());
    const command = JSON.parse(config.match(/^command = (.*)$/m)[1]);
    const args = JSON.parse(config.match(/^args = (.*)$/m)[1]);
    assert.equal(command, executablePath); assert.equal(args[0], process.env.DEV_TRACKER_EXE ? path.join(path.dirname(executablePath), 'resources', 'app.asar', 'mcp-stdio.mjs') : path.resolve('mcp-stdio.mjs'));
    assert.equal(args[2], path.join(base, 'mcp-connection', 'discovery.json'));
    assert.ok(config.includes('ELECTRON_RUN_AS_NODE = "1"')); assert.equal(config.includes('token'), false);
    client = new Client({ name: 'improvement-acceptance', version: '1' });
    await client.connect(new StdioClientTransport({ command, args, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stderr: 'pipe' }));
    const call = async (name, arguments_) => { const r = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 10000 }); assert.notEqual(r.isError, true, r.content[0].text); return JSON.parse(r.content[0].text); };
    const bound = await call('bind_session', { projectRoot, label: '验收 AI' });
    const tool = (name, args = {}) => call(name, { sessionId: bound.sessionId, ...args });
    await desktop.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, projectRoot);
    await page.locator('#choose').click();
    await tool('update_node', { id: 'root', action: 'request', text: '验收新要求' });
    await page.waitForFunction(() => document.getElementById('requirement-receipt').textContent.includes('等待 AI'));
    await tool('get_map'); await tool('get_handoff');
    assert.equal((await tool('get_node', { id: 'root' })).tasks.at(-1).text, '验收新要求');
    await page.waitForFunction(() => document.getElementById('requirement-receipt').textContent.includes('验收 AI'));
    await tool('update_node', { id: 'root', action: 'request', text: '追加要求' });
    await page.waitForFunction(() => document.getElementById('requirement-receipt').textContent.includes('等待 AI'));
    await page.screenshot({ path: 'test-results/improvements-stage1.png' });
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 660));
    assert.equal(await page.locator('#mcp-config-copy').isVisible(), true);
    await page.screenshot({ path: 'test-results/improvements-stage1-narrow.png' });
    const prior = await tool('record_decision', { nodeId: 'root', text: '只能 CSV' });
    const fullText = '完整要求'.repeat(110) + '允许 JSON';
    await tool('record_decision', { nodeId: 'root', text: fullText, replaces: prior.id });
    const nextClient = new Client({ name: 'new-session-continuation', version: '1' });
    try {
      await nextClient.connect(new StdioClientTransport({ command, args, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stderr: 'pipe' }));
      const nextBind = await nextClient.callTool({ name: 'bind_session', arguments: { projectRoot, label: '新会话' } });
      const sessionId = JSON.parse(nextBind.content[0].text).sessionId;
      const resumed = await nextClient.callTool({ name: 'get_decisions', arguments: { sessionId } });
      assert.equal(JSON.parse(resumed.content[0].text).entries[0].text, fullText);
    } finally { await nextClient.close(); }
    await page.waitForFunction(() => document.getElementById('decision-count').textContent === '1');
    await page.screenshot({ path: 'test-results/improvements-stage2.png' });
    await tool('set_acceptance_plan', { id: 'root', steps: [{ action: '<img src=x onerror=window.planAttack=true> 保存一条记录', expected: '重启后仍在' }] });
    await tool('record_quality_review', { id: 'root', scope: '保存与重启', summary: '检查完成', findings: '未发现问题', limitations: '只覆盖此流程，不代表整体质量' });
    await page.waitForFunction(() => document.getElementById('acceptance-plan').textContent.includes('重启后仍在'));
    assert.equal(await page.evaluate(() => window.planAttack), undefined);
    await page.locator('#quality-review summary').click();
    assert.ok((await page.locator('#quality-review').textContent()).includes('匹配当前版本'));
    await tool('update_node', { id: 'root', action: 'request', text: '需要增加修改功能' });
    await page.waitForFunction(() => document.getElementById('quality-review').textContent.includes('已过期'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.screenshot({ path: 'test-results/improvements-stage3-narrow.png' });
  } finally {
    await client?.close(); await desktop?.close();
    await rm(base, { recursive: true, force: true });
  }
});
