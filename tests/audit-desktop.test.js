import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import electron from 'electron';

test('failed folder selection releases the switch and a real project can open afterwards', { timeout: 90000 }, async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'dev-tracker-switch-recovery-'));
  const prior = path.join(storage, 'prior'), target = process.env.DEV_TRACKER_SWITCH_ROOT || path.join(storage, 'target-project');
  let desktop;
  try {
    await mkdir(prior);
    if (!process.env.DEV_TRACKER_SWITCH_ROOT) await mkdir(target);
    desktop = await _electron.launch({ executablePath: process.env.DEV_TRACKER_EXE || electron,
      args: process.env.DEV_TRACKER_EXE ? [] : ['.'], env: { ...process.env, DEV_TRACKER_TEST_DATA: storage } });
    const page = await desktop.firstWindow();
    await page.locator('#details-toggle').click();
    await page.locator('#switch-project').waitFor();
    const select = async directory => {
      await desktop.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, directory);
      await page.locator('#switch-project').click();
      await page.waitForFunction(() => !document.getElementById('switch-project').disabled);
    };
    await select(prior);
    await page.locator('#current-project-path').getByText(prior, { exact: true }).waitFor();
    await select(path.join(storage, 'missing'));
    await page.locator('#project-switch-status').getByText('打开失败', { exact: false }).waitFor();
    assert.equal(await page.locator('#current-project-path').textContent(), prior, 'an unsuccessful selection must preserve the prior folder');
    const started = Date.now();
    await select(target);
    await page.locator('#current-project-path').getByText(target, { exact: true }).waitFor();
    assert.ok(Date.now() - started < 15000, 'opening source after a failure must complete without a scan backlog');
    assert.equal(await page.locator('#project-switch-status').textContent(), '');
    await page.screenshot({ path: 'test-results/project-switch-recovery.png' });
    console.log(JSON.stringify({ target, elapsedMs: Date.now() - started }));
  } finally {
    await desktop?.close();
    assert.equal(path.dirname(storage), path.resolve(tmpdir()));
    assert.ok(path.basename(storage).startsWith('dev-tracker-switch-recovery-'));
    await rm(storage, { recursive: true, force: true });
  }
});

test('visible project switch keeps new work separate and restores the chosen project after reopen', { timeout: 90000 }, async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'dev-tracker-project-entry-'));
  const a = path.join(storage, '旧项目'), b = path.join(storage, '新项目');
  let desktop, page;
  const launch = async () => {
    desktop = await _electron.launch({ executablePath: process.env.DEV_TRACKER_EXE || electron,
      args: process.env.DEV_TRACKER_EXE ? [] : ['.'], env: { ...process.env, DEV_TRACKER_TEST_DATA: storage } });
    page = await desktop.firstWindow();
    await page.locator('#details-toggle').click();
    await page.locator('#switch-project').waitFor();
  };
  const select = async root => {
    await desktop.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: !directory, filePaths: directory ? [directory] : [] }); }, root);
    await page.locator('#switch-project').click();
    await page.waitForFunction(() => !document.getElementById('switch-project').disabled);
    if (root) await page.locator('#current-project-path').getByText(root, { exact: true }).waitFor();
  };
  try {
    await mkdir(a); await mkdir(b);
    await launch();
    assert.equal(await page.locator('#current-project').textContent(), '尚未选择项目');
    await select(a);
    await page.locator('#requirement').fill('只属于旧项目的要求'); await page.locator('#request button').click();
    await page.waitForFunction(() => document.getElementById('requirement').value === '');
    await select(null);
    assert.equal(await page.locator('#current-project-path').textContent(), a, 'canceling the folder picker must keep the current project');
    await select(b);
    assert.equal(await page.locator('#current-project').textContent(), '当前项目：新项目', 'the actual folder identity must be visible even when root title is 我的项目');
    assert.equal((await page.evaluate(async () => (await (await fetch('api/state')).json()).nodes[0].tasks.length)), 0, 'new project must not inherit prior requirements');
    await page.locator('#requirement').fill('只属于新项目的要求'); await page.locator('#request button').click();
    await page.waitForFunction(() => document.getElementById('requirement').value === '');
    await page.screenshot({ path: 'test-results/project-entry.png' });
    await desktop.close(); desktop = undefined;
    await launch();
    assert.equal(await page.locator('#current-project-path').textContent(), b, 'reopen must identify the last project');
    await select(a);
    const tasks = await page.evaluate(async () => (await (await fetch('api/state')).json()).nodes[0].tasks.map(t => t.text));
    assert.deepEqual(tasks, ['只属于旧项目的要求'], 'returning to the old folder restores its original requirements without new-project data');
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 660));
    assert.ok(await page.locator('#switch-project').isVisible());
    const layout = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
    assert.ok(layout.scroll <= layout.width, 'project controls must remain usable without horizontal overflow');
    await page.screenshot({ path: 'test-results/project-entry-narrow.png' });
  } finally {
    await desktop?.close();
    assert.equal(path.dirname(storage), path.resolve(tmpdir()));
    assert.ok(path.basename(storage).startsWith('dev-tracker-project-entry-'));
    await rm(storage, { recursive: true, force: true });
  }
});

test('switching projects discards old drafts and delayed responses without losing canceled drafts', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'dev-tracker-audit-ui-'));
  let desktop;
  try {
    const a = path.join(storage, 'A'), b = path.join(storage, 'B');
    await mkdir(a); await mkdir(b);
    desktop = await _electron.launch({ executablePath: process.env.DEV_TRACKER_EXE || electron,
      args: process.env.DEV_TRACKER_EXE ? [] : ['.'], env: { ...process.env, DEV_TRACKER_TEST_DATA: storage } });
    const page = await desktop.firstWindow();
    await page.locator('#details-toggle').click();
    await page.waitForFunction(() => document.getElementById('window-context').textContent.length > 0);
    const select = async root => {
      await desktop.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: !folder, filePaths: folder ? [folder] : [] }); }, root);
      await page.locator('#switch-project').click();
      await page.locator('#project-path').getByText(root || a, { exact: true }).waitFor();
      await page.waitForFunction(() => !document.getElementById('switch-project').disabled);
    };
    await select(a); await page.locator('#map-tab').click();
    await page.locator('#developer-details > summary').click();
    await page.locator('#requirement').fill('Only for project A');
    await select(null);
    assert.equal(await page.locator('#requirement').inputValue(), 'Only for project A', 'canceling the picker must preserve the unsaved draft');
    await select(b);
    assert.equal(await page.locator('#requirement').inputValue(), '', 'the shared root node must not carry a draft into a different project');
    await page.locator('#requirement').fill('Project B request');
    await page.locator('#request button').click();
    await page.locator('#requirements').getByText('Project B request').waitFor();
    await select(a);
    await page.locator('#rename').click(); await page.locator('#name').fill('Project A title');
    await page.locator('#dialog button[value=save]').click();
    await page.locator('h1').getByText('Project A title', { exact: true }).waitFor();
    await page.evaluate(() => {
      const originalFetch = window.fetch;
      const held = new Set();
      window.auditPending = []; window.auditReleased = [];
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (['api/state', 'api/evidence'].includes(args[0]) && !held.has(args[0])) {
          held.add(args[0]);
          await new Promise(resolve => window.auditPending.push(resolve));
          window.auditReleased.push(args[0]);
        }
        return response;
      };
    });
    await page.waitForFunction(() => window.auditPending.length === 2);
    await select(b);
    await page.locator('h1').getByText('我的项目', { exact: true }).waitFor();
    await page.evaluate(() => window.auditPending.forEach(resolve => resolve()));
    await page.waitForFunction(() => window.auditReleased.length === 2);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.match(await page.locator('#window-context').textContent(), / · B$/, 'a delayed A state must not relabel the B window');
    assert.equal(await page.locator('h1').textContent(), '我的项目');
    assert.equal(await page.locator('#project-path').textContent(), b, 'delayed evidence must not restore the previous project path');
    assert.equal(await page.locator('#current-project-path').textContent(), b, 'delayed A responses must not relabel the visible project identity');
    await page.locator('#requirement').fill('After delayed A response');
    await page.locator('#request button').click();
    await page.locator('#requirements').getByText('After delayed A response').waitFor();
    await select(a);
    const tasks = await page.evaluate(async () => (await (await fetch('api/state')).json()).nodes.find(node => node.id === 'root').tasks);
    assert.equal(tasks.length, 0, 'new project requests must never be written to the old project');
  } finally {
    await desktop?.close();
    await rm(storage, { recursive: true, force: true });
  }
});
