import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import electron from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('desktop records survive closing and reopening without changing prototype data', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'dev-tracker-desktop-'));
  const launch = () => _electron.launch({ timeout: 15000, executablePath: process.env.DEV_TRACKER_EXE || electron, args: process.env.DEV_TRACKER_EXE ? [] : ['.'], env: { ...process.env, DEV_TRACKER_TEST_DATA: storage } });
  let desktop;
  try {
    const project = path.join(storage, 'fixture'); await mkdir(project);
    await writeFile(path.join(project, 'real.test.cjs'), "require('node:test')('real test', () => require('node:assert/strict').equal(1, 1));");
    desktop = await launch();
    let page = await desktop.firstWindow();
    await page.locator('#developer-details > summary').click();
    await page.getByRole('tab', { name: '开发地图', exact: true }).click();
    await page.locator('.node').waitFor();
    await page.waitForFunction(() => !document.getElementById('canvas').hidden);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const view = () => page.evaluate(() => {
      const canvas = document.getElementById('canvas').getBoundingClientRect();
      const map = document.getElementById('map').getBoundingClientRect();
      return { x: map.x - canvas.x, y: map.y - canvas.y, width: map.width, height: map.height, cw: canvas.width, ch: canvas.height };
    });
    const centered = async () => {
      const v = await view();
      assert.ok(Math.abs(v.x + v.width / 2 - v.cw / 2) < 1, 'map stays horizontally centered');
      assert.ok(Math.abs(v.y + v.height / 2 - v.ch / 2) < 1, 'map stays vertically centered');
      assert.ok(v.width <= v.cw && v.height <= v.ch, 'fit keeps the complete graph visible');
    };
    await centered();
    const box = await page.locator('#canvas').boundingBox();
    const before = await view();
    await page.mouse.move(box.x + 12, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + 72, box.y + 52);
    await page.mouse.up();
    const moved = await view();
    assert.ok(Math.abs(moved.x - before.x - 60) < 1 && Math.abs(moved.y - before.y - 40) < 1, 'drag moves the whole map in both directions');
    const anchor = { x: 120, y: 100 };
    await page.mouse.move(box.x + anchor.x, box.y + anchor.y);
    await page.mouse.wheel(0, -240);
    await page.waitForFunction(() => document.getElementById('scale').textContent !== '100%');
    const enlarged = await view();
    assert.ok(enlarged.width > moved.width, 'wheel up enlarges the map');
    assert.ok(Math.abs((anchor.x - moved.x) / moved.width - (anchor.x - enlarged.x) / enlarged.width) < .001, 'zoom preserves the point under the cursor');
    assert.ok(Math.abs((anchor.y - moved.y) / moved.height - (anchor.y - enlarged.y) / enlarged.height) < .001);
    await page.mouse.wheel(0, -10000);
    await page.waitForFunction(() => document.getElementById('scale').textContent === '180%');
    await page.mouse.wheel(0, 10000);
    await page.waitForFunction(() => document.getElementById('scale').textContent === '10%');
    await page.getByRole('button', { name: '适应画布', exact: true }).click();
    await centered();
    await page.getByRole('button', { name: '添加子功能', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('桌面验收节点');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.node').filter({ hasText: '桌面验收节点' }).click();
    await page.getByLabel('修改要求').fill('重启后保留这条任务');
    await page.getByRole('button', { name: '保存任务', exact: true }).click();
    await page.locator('#requirements').getByText('重启后保留这条任务').waitFor();
    await desktop.evaluate(async ({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, project);
    await page.getByRole('button', { name: '选择项目文件夹', exact: true }).click();
    await page.locator('#project-path').getByText(project, { exact: true }).waitFor();
    await page.locator('.node').filter({ hasText: '桌面验收节点' }).click();
    await page.locator('#requirements').getByText('重启后保留这条任务').waitFor();
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    const client = new Client({ name: 'desktop-test', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('mcp', page.url())));
      const map = JSON.parse((await client.callTool({ name: 'get_map', arguments: {} })).content[0].text);
      await page.getByRole('button', { name: '缩小', exact: true }).click();
      const preserved = await view();
      await client.callTool({ name: 'update_node', arguments: { id: map[1].id, action: 'start' } });
      await client.callTool({ name: 'update_node', arguments: { id: map[1].id, action: 'record', text: 'AI 说明：等待用户试用后确认' } });
      await page.locator('#status').getByText('处理中 · AI 自报', { exact: true }).waitFor();
      assert.deepEqual(await view(), preserved, 'MCP refresh preserves user zoom and pan');
      await client.callTool({ name: 'update_node', arguments: { id: map[1].id, action: 'submit' } });
      await page.locator('#status').getByText('开发完成 · 待验收 · AI 自报', { exact: true }).waitFor();
      await page.getByRole('button', { name: '确认验收', exact: true }).click();
      await page.locator('#status').getByText('用户已确认', { exact: true }).waitFor();
      await page.screenshot({ path: 'test-results/accepted-desktop.png' });
      await page.locator('.node').first().click();
      assert.deepEqual(await view(), preserved, 'selecting a node preserves the view');
      await page.setViewportSize({ width: 375, height: 812 });
      await page.getByRole('button', { name: '适应画布', exact: true }).click();
      await centered();
      await page.screenshot({ path: 'test-results/map-mobile.png' });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole('button', { name: '适应画布', exact: true }).click();
      await centered();
      await page.screenshot({ path: 'test-results/map-desktop.png' });
    } finally { await client.close(); }
    await desktop.close(); desktop = undefined;
    desktop = await launch();
    page = await desktop.firstWindow();
    await page.locator('#developer-details > summary').click();
    await page.getByRole('tab', { name: '开发地图', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('canvas').hidden);
    await page.getByRole('button', { name: '适应画布', exact: true }).click();
    await page.locator('.node').filter({ hasText: '桌面验收节点' }).click();
    await page.locator('#requirements').getByText('重启后保留这条任务').waitFor();
    const state = await page.evaluate(async () => (await fetch('api/state')).json());
    assert.equal(state.nodes.length, 2);
    assert.equal(state.nodes[1].tasks[0].text, '重启后保留这条任务');
    await page.locator('#status').getByText('用户已确认', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重新打开', exact: true }).click();
    await page.locator('#status').getByText('待处理', { exact: true }).waitFor();
    await page.getByRole('button', { name: '运行 Node 测试', exact: true }).click();
    await page.locator('#evidence-results summary').getByText('测试通过 · 前后扫描一致', { exact: true }).waitFor();
    await writeFile(path.join(project, 'new.js'), 'const value = 1;');
    await page.locator('#evidence-results').getByText('新增：new.js').waitFor();
    await page.locator('#evidence-results summary').getByText('测试通过 · 需重新验证', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关联到当前功能', exact: true }).click();
    await page.locator('#linked-changes').getByText('新增：new.js').waitFor();
    await page.reload();
    await page.locator('#developer-details > summary').click();
    await page.getByRole('tab', { name: '开发地图', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('canvas').hidden);
    await page.locator('.node').filter({ hasText: '桌面验收节点' }).click();
    await page.locator('#linked-changes').getByText('新增：new.js').waitFor();
    await page.locator('.node').first().click();
    await page.locator('#linked-changes').getByText('暂无关联改动', { exact: true }).waitFor();
    await page.locator('.node').filter({ hasText: '桌面验收节点' }).click();
    await page.locator('#linked-changes').getByText('新增：new.js').waitFor();
    await page.route('**/api/handoff.md', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '证据服务暂不可用' }) }));
    await page.getByRole('button', { name: '导出交接记录', exact: true }).click();
    await page.locator('#notice').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#notice').textContent(), '交接记录导出失败：证据服务暂不可用');
    assert.equal(await page.getByRole('button', { name: '导出交接记录', exact: true }).isEnabled(), true, 'failed export remains retryable');
    await page.unroute('**/api/handoff.md');
    const handoffFile = path.join(storage, 'PROJECT_HANDOFF.md');
    await desktop.evaluate(({ session }, file) => {
      globalThis.handoffDownload = null;
      session.defaultSession.once('will-download', (_, item) => {
        item.setSavePath(file);
        item.once('done', (_, state) => { globalThis.handoffDownload = { state, filename: item.getFilename() }; });
      });
    }, handoffFile);
    await page.getByRole('button', { name: '导出交接记录', exact: true }).click();
    const deadline = Date.now() + 10000;
    let download;
    while (!download && Date.now() < deadline) {
      download = await desktop.evaluate(() => globalThis.handoffDownload);
      if (!download) await page.waitForTimeout(100);
    }
    assert.equal(download?.state, 'completed', 'native desktop download saves the actual file');
    assert.equal(download.filename, 'PROJECT_HANDOFF.md');
    const handoff = await readFile(handoffFile, 'utf8');
    for (const text of [state.nodes[1].id, '桌面验收节点', '重启后保留这条任务', 'AI 说明：等待用户试用后确认', 'AI 自报', '人工关联', 'new.js', 'node --test --test-reporter=tap', '需重新验证']) {
      assert.ok(handoff.includes(text), `download retains handoff evidence: ${text}`);
    }
    assert.match(handoff, /"pass":1/, 'handoff retains the executed passing-test count even when that result is stale');
    await page.route('**/api/handoff.json', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '证据服务暂不可用' }) }));
    await page.getByRole('button', { name: '复制续接内容', exact: true }).click();
    await page.getByText('续接复制失败：证据服务暂不可用', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '复制续接内容', exact: true }).isEnabled(), true, 'failed copying remains retryable');
    await page.unroute('**/api/handoff.json');
    await page.getByRole('button', { name: '复制续接内容', exact: true }).click();
    await page.waitForFunction(() => /续接内容已复制|续接复制失败/.test(document.getElementById('notice').textContent) && !document.getElementById('resume-copy').disabled);
    const copied = await desktop.evaluate(async ({ clipboard }) => await clipboard.readText());
    if ((await page.locator('#notice').textContent()) === '续接内容已复制') {
      for (const text of ['dev_tracker', 'get_handoff', state.nodes[1].id, '桌面验收节点', '重启后保留这条任务', 'new.js', '需重新验证']) {
        assert.ok(copied.includes(text), `copied handoff retains evidence: ${text}`);
      }
      assert.match(copied, /"pass":1/, 'copied handoff preserves stale test counts with their warning');
      assert.match(copied, /"association":\{"source":"manual"/, 'compact copied evidence must preserve who associated the change');
      console.log('Verified native clipboard copy and its project, evidence and continuation content.');
    } else {
      assert.match(await page.locator('#notice').textContent(), /系统剪贴板未保存内容/, 'unavailable native clipboard must fail visibly');
      assert.equal(await page.getByRole('button', { name: '复制续接内容', exact: true }).isEnabled(), true);
      console.log('Native clipboard could not retain text; verified visible failure and retry, successful copying remains unverified in this environment.');
    }
    await mkdir('test-results', { recursive: true });
    await page.locator('#evidence-results').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/desktop.png' });
  } finally {
    if (desktop) {
      try {
      } finally { await desktop.close(); }
    }
    assert.equal(path.dirname(storage), path.resolve(tmpdir()));
    assert.ok(path.basename(storage).startsWith('dev-tracker-desktop-'));
    await rm(storage, { recursive: true, force: true });
  }
});
