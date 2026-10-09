import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import electron from 'electron';

test('switching projects discards old drafts and delayed responses without losing canceled drafts', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'dev-tracker-audit-ui-'));
  let desktop;
  try {
    const a = path.join(storage, 'A'), b = path.join(storage, 'B');
    await mkdir(a); await mkdir(b);
    desktop = await _electron.launch({ executablePath: process.env.DEV_TRACKER_EXE || electron,
      args: process.env.DEV_TRACKER_EXE ? [] : ['.'], env: { ...process.env, DEV_TRACKER_TEST_DATA: storage } });
    const page = await desktop.firstWindow();
    await page.waitForFunction(() => document.getElementById('window-context').textContent.length > 0);
    const select = async root => {
      await desktop.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: !folder, filePaths: folder ? [folder] : [] }); }, root);
      await page.locator('#choose').click();
      await page.locator('#project-path').getByText(root || a, { exact: true }).waitFor();
      await page.waitForFunction(() => !document.getElementById('choose').disabled);
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
