import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import electron from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('map broadcast and persistent AI journal support a fresh client without overwhelming the user', { timeout: 120000 }, async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'dev-tracker-journal-desktop-'));
  const projectA = path.join(storage, 'project-a'), projectB = path.join(storage, 'project-b');
  let desktop, page, client, originalError;
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
    return JSON.parse(result.content[0].text);
  };
  const launch = async () => {
    desktop = await _electron.launch({ timeout: 15000, executablePath: process.env.DEV_TRACKER_EXE || electron,
      args: process.env.DEV_TRACKER_EXE ? [] : ['.'], env: { ...process.env, DEV_TRACKER_TEST_DATA: storage } });
    page = await desktop.firstWindow();
    await page.locator('#overview-summary').waitFor();
    client = new Client({ name: 'journal-independent-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL('mcp', page.url())));
  };
  const stop = async () => {
    try { if (client) await client.close(); }
    finally {
      client = undefined;
      if (desktop) {
        const process = desktop.process();
        let timer;
        try {
          await Promise.race([desktop.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Electron close did not complete in 10 seconds (test PID ${process.pid})`)), 10000); })]);
          if (process.exitCode === null) await Promise.race([new Promise(resolve => process.once('exit', resolve)), new Promise((_, reject) => { clearTimeout(timer); timer = setTimeout(() => reject(new Error(`Electron process survived close (test PID ${process.pid})`)), 10000); })]);
        } catch (error) {
          console.error('Journal desktop shutdown failure:', error);
          if (process.exitCode === null) await promisify(execFile)('taskkill', ['/PID', String(process.pid), '/T', '/F']);
          throw error;
        } finally { clearTimeout(timer); desktop = undefined; }
      }
    }
  };
  const choose = async directory => {
    await desktop.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, directory);
    await page.getByRole('button', { name: '选择项目文件夹', exact: true }).click();
    await page.locator('#project-path').getByText(directory, { exact: true }).waitFor();
  };
  const details = async () => {
    if (!await page.locator('#developer-details').evaluate(element => element.open)) {
      await page.locator('#developer-details > summary').click();
    }
  };
  const broadcast = async text => page.locator('#task-broadcast').getByText(text, { exact: false }).waitFor();
  const frame = async () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  try {
    await mkdir(projectA); await mkdir(projectB);
    await writeFile(path.join(projectA, 'proof.test.cjs'), "require('node:test')('journal proof', () => require('node:assert/strict').equal(1, 1));\n");
    await writeFile(path.join(projectB, 'b.txt'), 'separate project\n');
    await launch();
    assert.equal(await page.locator('#developer-details').evaluate(element => element.open), false, 'developer details start collapsed for ordinary requests');
    assert.equal(await page.getByLabel('修改要求').isVisible(), true, 'request remains accessible without developer details');
    await details(); await choose(projectA);
    await page.getByRole('tab', { name: '开发地图', exact: true }).click();
    await broadcast('当前没有进行中的任务');
    assert.equal(await page.getByRole('button', { name: '定位当前任务', exact: true }).isEnabled(), false);
    await call('update_node', { id: 'root', action: 'add', text: '记录保存' });
    const parent = (await call('get_map')).find(node => node.title === '记录保存').id;
    await call('update_node', { id: parent, action: 'add', text: '重启恢复记录' });
    const leaf = (await call('get_map')).find(node => node.title === '重启恢复记录').id;
    await call('update_node', { id: leaf, action: 'criteria', text: '重启后仍能读到原项目记录' });
    await page.locator(`.node[data-id="${leaf}"]`).click();
    await page.getByLabel('修改要求').fill('保留当前项目的开发日志');
    await page.getByRole('button', { name: '保存任务', exact: true }).click();
    await page.locator('#requirements').getByText('保留当前项目的开发日志').waitFor();
    await page.locator('#developer-details > summary').click();
    await page.locator('#acceptance-criteria').getByText('重启后仍能读到原项目记录', { exact: false }).waitFor();
    await call('update_node', { id: leaf, action: 'start' });
    await broadcast('重启恢复记录');
    await call('update_node', { id: leaf, action: 'record', text: '已核对项目路径，正在验证重启恢复。' });
    await broadcast('已核对项目路径，正在验证重启恢复。');
    const entry = await call('append_journal', { projectRoot: projectA, nodeId: leaf,
      summary: '保存日志并核对重启恢复', approach: '按项目目录保存独立记录。'.repeat(40), reason: '避免新会话丢失开发依据',
      verification: '运行临时项目测试；仍需用户试用', pitfalls: '不能把 AI 自报当成测试结果', next: '重新打开项目并读取日志' });
    assert.equal(entry.source, 'ai');
    await call('append_journal', { projectRoot: projectA, nodeId: leaf, summary: '分页记录', reason: 'PAGINATION keyword' });
    const first = await call('get_journal', { nodeId: leaf, limit: 1 });
    assert.equal(first.total, 2); assert.equal(first.nextOffset, 1);
    const second = await call('get_journal', { nodeId: leaf, limit: 1, offset: first.nextOffset });
    assert.equal(second.entries[0].id, entry.id); assert.equal(second.nextOffset, null);
    assert.equal((await call('get_journal', { query: 'pagination' })).entries.length, 1, 'keyword search finds structured reason text case insensitively');
    const state = await page.evaluate(async () => (await fetch('api/state')).json());
    assert.equal(Object.hasOwn(state, 'journal'), false, 'polling state omits the full journal');
    await page.getByRole('button', { name: '定位当前任务', exact: true }).click();
    await frame();
    assert.equal(await page.locator('.node.selected').getAttribute('data-id'), leaf);
    const geometry = await page.locator(`.node[data-id="${leaf}"]`).evaluate(node => {
      const box = node.getBoundingClientRect(), canvas = document.getElementById('canvas').getBoundingClientRect();
      return { dx: box.x + box.width / 2 - canvas.x - canvas.width / 2, dy: box.y + box.height / 2 - canvas.y - canvas.height / 2 };
    });
    assert.ok(Math.abs(geometry.dx) < 2 && Math.abs(geometry.dy) < 2, 'locate centers the current branch task');
    await mkdir('test-results', { recursive: true });
    await frame();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: 'test-results/journal-desktop.png' });
    await page.setViewportSize({ width: 375, height: 812 }); await frame();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: 'test-results/journal-mobile.png' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await call('update_node', { id: leaf, action: 'pause' });
    await page.waitForFunction(() => !document.querySelector('#broadcast-locate') || document.querySelector('#broadcast-locate').disabled || document.querySelector('#broadcast-locate').hidden);
    assert.equal(await page.locator('#links path.ai-active').count(), 0, 'pause clears the active branch');
    await call('update_node', { id: leaf, action: 'start' }); await broadcast('重启恢复记录');
    await call('update_node', { id: leaf, action: 'submit' });
    await page.waitForFunction(() => !document.querySelector('#links path.ai-active'));
    const literal = '<b id="journal-literal">普通文本</b>';
    await call('update_node', { id: leaf, action: 'start' });
    await call('update_node', { id: leaf, action: 'record', text: literal });
    await broadcast(literal);
    assert.equal(await page.locator('#journal-literal').count(), 0, 'HTML-looking notes remain literal text');
    await details();
    await page.getByLabel('人工记录', { exact: true }).fill('人工检查：项目与记录一致');
    await page.getByRole('button', { name: '添加记录', exact: true }).click();
    await broadcast('人工检查：项目与记录一致');
    assert.match(await page.locator('#broadcast-update').textContent(), /人工记录/, 'a newer manual note supersedes the old AI note with its own source');
    await page.getByRole('button', { name: '暂停处理', exact: true }).click();
    await page.getByRole('button', { name: '添加子功能', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('详情新增功能');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    assert.equal((await call('run_tests', { id: leaf })).passed, true, 'developer test workflow still executes real tests');
    await choose(projectB);
    assert.equal((await call('get_journal')).total, 0, 'a different project cannot read project A journal');
    await choose(projectA); await stop(); await launch();
    assert.equal(await page.locator('#developer-details').evaluate(element => element.open), false);
    const restored = await call('get_journal', { nodeId: leaf });
    assert.equal(restored.projectRoot, projectA); assert.equal(restored.total, 2);
    assert.deepEqual(restored.entries.find(record => record.id === entry.id), entry, 'a fresh SDK client reads the original structured journal after restart');
    const handoff = await call('get_handoff');
    assert.equal(handoff.snapshot.project.root, projectA);
    assert.ok(handoff.snapshot.journal.entries.length <= 3);
    assert.ok(handoff.snapshot.journal.entries.every(record => record.source === 'ai' && record.approach.length <= 300), 'handoff journal summaries are bounded and retain AI provenance');
    assert.equal(JSON.stringify(handoff).includes(entry.approach), false, 'compact handoff omits full journal detail');
    await details(); await choose(projectB);
    assert.equal((await call('get_journal')).total, 0, 'project isolation also survives restart');
  } catch (error) {
    originalError = error;
    console.error('Journal desktop test failure before cleanup:', error);
    throw error;
  } finally {
    try { await stop(); }
    catch (error) { if (originalError) throw new AggregateError([originalError, error], 'Journal assertion and shutdown both failed'); throw error; }
    finally {
      assert.equal(path.dirname(storage), path.resolve(tmpdir()));
      assert.ok(path.basename(storage).startsWith('dev-tracker-journal-desktop-'));
      try { await rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch (error) { if (originalError) throw new AggregateError([originalError, error], 'Journal assertion and temporary directory cleanup both failed'); throw error; }
    }
  }
});
