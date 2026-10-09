import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { _electron } from 'playwright';
import electron from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const exec = promisify(execFile);

test('linked code differences remain readable after reopening and reselecting the same project', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'dev-tracker-diff-desktop-'));
  const root = path.join(storage, 'fixture');
  const hostile = '<script id="diff-injected">globalThis.diffInjected = true</script>';
  let desktop, page, client;
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return JSON.parse(result.content[0].text);
  };
  const launch = async () => {
    desktop = await _electron.launch({
      timeout: 15000,
      executablePath: process.env.DEV_TRACKER_EXE || electron,
      args: process.env.DEV_TRACKER_EXE ? [] : ['.'],
      env: { ...process.env, DEV_TRACKER_TEST_DATA: storage }
    });
    page = await desktop.firstWindow();
    await page.locator('#developer-details > summary').click();
    await page.getByRole('tab', { name: '开发地图', exact: true }).click();
    await page.locator('.node').first().waitFor();
    await page.waitForFunction(() => !document.getElementById('canvas').hidden);
    client = new Client({ name: 'diff-desktop-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL('mcp', page.url())));
    await desktop.evaluate(async ({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, root);
  };
  const stop = async () => {
    try { if (client) await client.close(); }
    finally { client = undefined; if (desktop) await desktop.close(); desktop = undefined; }
  };
  const choose = async () => {
    await page.getByRole('button', { name: '选择项目文件夹', exact: true }).click();
    await page.locator('#project-path').getByText(root, { exact: true }).waitFor();
  };
  const openDiff = async () => {
    await page.locator('#linked-changes').getByRole('button', { name: '查看代码差异', exact: true }).click();
    const dialog = page.locator('#diff-dialog');
    await dialog.waitFor({ state: 'visible' });
    await dialog.getByText('当前 Git 差异（不是历史改动快照）', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#diff-dialog').textContent.includes('+const value = 2;'));
    const text = await dialog.textContent();
    assert.ok(text.includes('-const value = 1;'), 'the committed original appears as a removed line');
    assert.ok(text.includes('+const value = 2;'), 'the actual working file appears as an added line');
    assert.ok(text.includes(hostile), 'HTML-looking source remains readable literally');
    assert.equal(await dialog.locator('script').count(), 0, 'source must never become executable markup');
    assert.equal(await page.evaluate(() => globalThis.diffInjected), undefined);
  };
  const contained = async () => {
    const geometry = await page.locator('#diff-dialog').evaluate(dialog => {
      const box = dialog.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.width, 'diff dialog fits the viewport horizontally');
    assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.height, 'diff dialog fits the viewport vertically');
    assert.equal(geometry.overflow, false, 'code stays inside the scrollable viewer instead of widening the page');
  };
  try {
    await mkdir(root);
    await writeFile(path.join(root, 'code.js'), 'const value = 1;\n');
    await writeFile(path.join(root, 'sample.test.cjs'), "require('node:test')('fixture test', () => require('node:assert/strict').equal(1, 1));\n");
    await exec('git', ['init', root]);
    await exec('git', ['-C', root, 'add', '.']);
    await exec('git', ['-C', root, '-c', 'user.name=Diff Test', '-c', 'user.email=diff-test@example.invalid', 'commit', '-m', 'Baseline fixture']);
    await launch();
    await page.getByRole('button', { name: '添加子功能', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('差异验收功能');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.node').filter({ hasText: '差异验收功能' }).click();
    const node = (await call('get_map')).find(node => node.title === '差异验收功能');
    await choose();
    await page.locator('.node').filter({ hasText: '差异验收功能' }).click();
    assert.equal((await call('run_tests', { id: node.id })).passed, true);
    await writeFile(path.join(root, 'code.js'), `const value = 2;\n// ${hostile}\n`);
    const evidence = await call('get_evidence');
    const change = evidence.changes.find(change => change.path === 'code.js');
    assert.ok(change, 'a real filesystem edit produces the record that the node will link');
    await call('link_evidence', { kind: 'file', changeId: change.id, id: node.id });
    await page.locator('#linked-changes').getByText('修改：code.js').waitFor();
    await openDiff();
    await mkdir('test-results', { recursive: true });
    await contained();
    await page.screenshot({ path: 'test-results/diff-desktop.png' });
    await page.setViewportSize({ width: 375, height: 812 });
    await contained();
    await page.screenshot({ path: 'test-results/diff-mobile.png' });
    await page.getByRole('button', { name: '关闭差异', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await stop();
    await launch();
    await page.locator('#project-path').getByText(root, { exact: true }).waitFor();
    await page.locator('.node').filter({ hasText: '差异验收功能' }).click();
    await page.locator('#linked-changes').getByText('修改：code.js').waitFor();
    await openDiff();
    await page.getByRole('button', { name: '关闭差异', exact: true }).click();
    const restored = await call('get_evidence');
    assert.equal(restored.root, root, 'the selected actual project survives restart');
    assert.equal(restored.changes.find(record => record.id === change.id).node, node.id, 'the same association survives restart');
    assert.equal(restored.tests.length, 1, 'executed tests survive restart');
    await choose();
    const reselected = await call('get_evidence');
    assert.deepEqual(reselected.changes, restored.changes, 'choosing the same project again must not erase observed edits or links');
    assert.deepEqual(reselected.tests, restored.tests, 'choosing the same project again must not erase executed tests');
    await openDiff();
    await page.getByRole('button', { name: '关闭差异', exact: true }).click();
  } finally {
    try { await stop(); }
    finally {
      assert.equal(path.dirname(storage), path.resolve(tmpdir()));
      assert.ok(path.basename(storage).startsWith('dev-tracker-diff-desktop-'));
      await rm(storage, { recursive: true, force: true });
    }
  }
});
