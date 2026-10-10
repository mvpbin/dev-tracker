import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import electron from 'electron';
import { createHash } from 'node:crypto';
import { createProject } from '../project.js';

test('workspace stays primary while details and floating map controls remain usable', { timeout: 90000 }, async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'dev-tracker-layout-'));
  const project = path.join(storage, '示例项目'); await mkdir(project);
  const recordDirectory = path.join(storage, 'projects', createHash('sha256').update(process.platform === 'win32' ? project.toLowerCase() : project).digest('hex'));
  const fixture = await createProject(recordDirectory, project, storage);
  for (const text of ['记录清单', '搜索记录', '导出文件']) {
    await fixture.applyAction({ id: 'root', action: 'add', text });
    const id = fixture.getState().nodes.find(node => node.title === text).id;
    await fixture.applyAction({ id, action: 'scope', text: 'true' });
  }
  let desktop;
  try {
    desktop = await _electron.launch({ executablePath: process.env.DEV_TRACKER_EXE || electron, args: process.env.DEV_TRACKER_EXE ? [] : ['.'], env: { ...process.env, DEV_TRACKER_TEST_DATA: storage } });
    const page = await desktop.firstWindow();
    await page.setViewportSize({ width: 1280, height: 790 });
    await page.locator('#switch-project').waitFor();
    await desktop.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, project);
    await page.locator('#switch-project').click();
    await page.locator('#current-project-path').getByText(project, { exact: true }).waitFor();
    const initial = await page.evaluate(() => ({ hidden: document.getElementById('details-panel').hidden, main: document.querySelector('main').clientWidth, workspace: document.querySelector('.workspace').clientWidth, overview: document.getElementById('overview').clientHeight }));
    assert.equal(initial.hidden, true, 'secondary details must not consume workspace until requested');
    assert.ok(initial.workspace >= initial.main - 2, 'overview receives the full available width');
    assert.ok(initial.overview > 400, 'task board gets more than half of this desktop viewport');
    await page.locator('#details-toggle').click();
    await page.locator('#requirement').fill('收起面板后仍保留我的修改要求');
    await page.locator('#details-close').click();
    assert.equal(await page.locator('#details-panel').evaluate(element => element.hidden), true);
    assert.equal(await page.locator('#details-toggle').evaluate(element => element === document.activeElement), true, 'closing returns keyboard focus to the opener');
    await page.locator('#details-toggle').click();
    assert.equal(await page.locator('#requirement').inputValue(), '收起面板后仍保留我的修改要求');
    await page.locator('#request button').click();
    await page.waitForFunction(() => document.getElementById('requirement').value === '');
    await page.locator('#board [data-node]').first().waitFor();
    await page.locator('#details-close').click();
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/layout-overview.png' });
    await page.locator('#board [data-node]').first().click();
    assert.equal(await page.locator('#details-panel').evaluate(element => element.hidden), false, 'selecting a task opens its details');
    await page.locator('#details-close').click();
    const canvas = await page.locator('#canvas').boundingBox();
    assert.ok(canvas.width > 1200 && canvas.height > 390, 'map gets a large central working area');
    await page.locator('#in').click();
    const enlarged = await page.locator('#scale').textContent();
    await page.locator('#out').click();
    assert.notEqual(await page.locator('#scale').textContent(), enlarged, 'floating zoom buttons must not trigger canvas dragging');
    await page.locator('#fit').click();
    await page.locator('.node').first().click();
    assert.equal(await page.locator('#details-panel').evaluate(element => element.hidden), false, 'map selection exposes the request and evidence controls');
    await page.locator('#details-close').click();
    await page.screenshot({ path: 'test-results/layout-map.png' });
    for (const width of [760, 375]) {
      await page.setViewportSize({ width, height: 790 });
      await page.locator('#details-toggle').click();
      const bounds = await page.locator('#details-panel').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'narrow window uses an accessible panel without horizontal overflow');
      await page.locator('#details-close').click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('#fit').click();
      const controls = await page.locator('#map-tools').boundingBox();
      const nodes = await page.locator('.node').evaluateAll(items => items.map(item => { const box = item.getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; }));
      assert.ok(nodes.every(node => node.bottom <= controls.y), 'fit reserves space so floating tools do not cover the lowest node');
      await page.screenshot({ path: `test-results/layout-map-${width}.png` });
      await page.locator('#overview-tab').click();
      assert.ok((await page.locator('#overview').boundingBox()).height > 250);
      await page.locator('#map-tab').click();
    }
  } finally {
    await desktop?.close();
    await rm(storage, { recursive: true, force: true });
  }
});
