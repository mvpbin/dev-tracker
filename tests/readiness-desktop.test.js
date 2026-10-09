import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import electron from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('desktop release readiness keeps project A and B maps, evidence, and independent MCP handoff consistent', { timeout: 120000 }, async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'dev-tracker-readiness-desktop-'));
  const projectA = path.join(storage, 'project-a'), projectB = path.join(storage, 'project-b');
  let desktop, page, client;
  const launch = () => _electron.launch({ timeout: 15000, executablePath: process.env.DEV_TRACKER_EXE || electron,
    args: process.env.DEV_TRACKER_EXE ? [] : ['.'], env: { ...process.env, DEV_TRACKER_TEST_DATA: storage } });
  const call = async (name, arguments_ = {}) => {
    const result = await client.callTool({ name, arguments: arguments_ });
    assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
    return JSON.parse(result.content[0].text);
  };
  const selectProject = async directory => {
    await desktop.evaluate(async ({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, directory);
    await page.getByRole('button', { name: '选择项目文件夹', exact: true }).click();
    await page.locator('#project-path').getByText(directory, { exact: true }).waitFor();
  };
  const mapTitles = async () => {
    await page.locator('#map-tab').click();
    return page.locator('.node').evaluateAll(nodes => nodes.map(node => node.textContent.trim()));
  };
  const overview = async () => {
    await page.locator('#overview-tab').click();
    await page.locator('#overview-summary').waitFor();
    return page.locator('#overview-summary .progress-metric').first().textContent();
  };
  try {
    await mkdir(projectA, { recursive: true }); await mkdir(projectB, { recursive: true });
    await writeFile(path.join(projectA, 'proof.test.cjs'), "require('node:test')('proof', () => require('node:assert/strict').equal(1, 1));\n");
    await writeFile(path.join(projectA, 'source.js'), 'export const value = 1;\n');
    await writeFile(path.join(projectB, 'b.txt'), 'project B evidence\n');
    desktop = await launch(); page = await desktop.firstWindow();
    await page.locator('#developer-details > summary').click();
    await page.locator('#overview-summary .progress-metric').first().waitFor();
    client = new Client({ name: 'readiness-desktop', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL('mcp', page.url())));

    await selectProject(projectA);
    const rootA = (await call('get_map')).find(node => node.parent === null);
    await call('update_node', { id: rootA.id, action: 'add', text: '可验收功能' });
    await call('update_node', { id: rootA.id, action: 'add', text: '待处理功能' });
    const map = await call('get_map');
    const firstId = map.find(node => node.title === '可验收功能').id, secondId = map.find(node => node.title === '待处理功能').id;
    await call('update_node', { id: rootA.id, action: 'goal', text: '<script id="goal-attack">window.goalAttack=true</script> 发布目标' });
    for (const id of [firstId, secondId]) {
      await call('update_node', { id, action: 'scope', text: 'true' });
      await call('update_node', { id, action: 'criteria', text: '<img src=x onerror=window.criteriaAttack=true> 可保存记录' });
      await call('update_node', { id, action: 'request', text: '完成保存流程' });
    }
    await page.locator('#board .lane[data-lane="pending"] .board-item').filter({ hasText: '可验收功能' }).waitFor();
    await call('update_node', { id: firstId, action: 'start' });
    await page.locator('#board .lane[data-lane="active"] .board-item').filter({ hasText: '可验收功能' }).waitFor();
    await page.locator('#map-tab').click();
    await page.locator('.node').filter({ hasText: '可验收功能' }).click();
    assert.equal(await page.evaluate(() => window.goalAttack), undefined);
    assert.equal(await page.evaluate(() => window.criteriaAttack), undefined);
    assert.equal((await call('run_tests', { id: firstId })).passed, true);
    await call('update_node', { id: firstId, action: 'submit' });
    await page.locator('#overview-tab').click();
    await page.locator('#board .lane[data-lane="review"] .board-item').filter({ hasText: '可验收功能' }).waitFor();
    await page.locator('#board .board-item').filter({ hasText: '可验收功能' }).click();
    await page.getByRole('button', { name: '确认验收', exact: true }).click();
    await page.locator('#overview-tab').click();
    await page.locator('#overview-summary .progress-metric').first().getByText('1 / 2', { exact: false }).waitFor();
    assert.match(await overview(), /1\s*\/\s*2/);
    assert.ok((await page.locator('#board').textContent()).includes('<img src=x onerror=window.criteriaAttack=true> 可保存记录'));
    assert.equal(await page.locator('#board img').count(), 0);
    assert.equal(await page.locator('#goal').inputValue(), '<script id="goal-attack">window.goalAttack=true</script> 发布目标');
    assert.equal(await page.locator('script#goal-attack').count(), 0);
    await mkdir('test-results', { recursive: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: 'test-results/readiness-desktop.png' });
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: 'test-results/readiness-mobile.png' });
    await page.setViewportSize({ width: 1280, height: 900 });

    await writeFile(path.join(projectA, 'source.js'), 'export const value = 2;\n');
    const stale = await call('get_overview');
    assert.equal(stale.completed, 0, 'a changed project fingerprint invalidates manual acceptance');
    assert.ok(stale.items.find(item => item.id === firstId).acceptanceWarning);
    await page.locator('#board .lane[data-lane="verify"] .board-item').filter({ hasText: '可验收功能' }).waitFor();
    await page.reload();
    await page.locator('#developer-details > summary').click();
    await page.locator('#board .lane[data-lane="verify"] .board-item').filter({ hasText: '可验收功能' }).waitFor();
    await page.locator('#map-tab').click();
    assert.equal(await page.locator('.node.selected').getAttribute('data-id'), rootA.id, 'reload resets selection to the root');

    await selectProject(projectB);
    const mapB = await mapTitles();
    assert.ok(mapB.some(text => text.includes('我的项目'))); assert.ok(!mapB.some(text => text.includes('可验收功能')));
    assert.equal(await page.locator('.node.selected').getAttribute('data-id'), 'root');
    await call('update_node', { id: 'root', action: 'add', text: '项目 B 功能' });
    await call('update_node', { id: 'root', action: 'goal', text: '项目 B 目标' });
    await writeFile(path.join(projectB, 'b.txt'), 'updated B evidence\n');
    const evidenceB = await call('get_evidence');
    assert.ok(evidenceB.changes.some(change => change.path === 'b.txt'));
    await selectProject(projectA);
    const mapA = await mapTitles();
    assert.ok(mapA.some(text => text.includes('可验收功能')));
    const evidenceA = await call('get_evidence'); assert.equal(evidenceA.root, projectA);
    assert.equal(evidenceA.tests.length, 1);
    await client.close(); client = undefined; await desktop.close(); desktop = undefined;

    desktop = await launch(); page = await desktop.firstWindow(); await page.locator('#board .board-item').first().waitFor();
    await page.locator('#developer-details > summary').click();
    client = new Client({ name: 'readiness-independent-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL('mcp', page.url())));
    const handoff = await call('get_handoff'); const restored = await call('get_overview');
    assert.equal(handoff.snapshot.project.root, projectA);
    assert.equal(restored.goal, stale.goal); assert.equal(restored.total, 2);
    assert.equal(restored.next.id, firstId);
    assert.equal(handoff.snapshot.overview.total, restored.total);
    assert.equal(handoff.snapshot.overview.completed, restored.completed);
    assert.equal(handoff.snapshot.overview.delivery, restored.delivery);
    assert.deepEqual(handoff.snapshot.overview.counts, restored.counts, 'compact handoff must preserve actual release totals');
    assert.ok(restored.items.some(item => item.id === firstId && item.acceptanceWarning));
    assert.equal((await call('get_evidence')).root, projectA);
    assert.match(JSON.stringify(handoff), /可验收功能/);
    await selectProject(projectB);
    assert.equal((await call('get_overview')).goal, '项目 B 目标');
    assert.equal((await call('get_evidence')).changes[0].id, evidenceB.changes[0].id);
    assert.ok((await mapTitles()).some(text => text.includes('项目 B 功能')));
  } finally {
    try { if (client) await client.close(); } finally { if (desktop) await desktop.close(); }
    assert.equal(path.dirname(storage), path.resolve(tmpdir()));
    assert.ok(path.basename(storage).startsWith('dev-tracker-readiness-desktop-'));
    await rm(storage, { recursive: true, force: true });
  }
});
