import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import electron from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('AI branch highlights follow reported work, not selection or manual status', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'dev-tracker-branches-'));
  const client = new Client({ name: 'branches-test', version: '1' });
  let desktop;
  try {
    desktop = await _electron.launch({
      timeout: 15000,
      executablePath: process.env.DEV_TRACKER_EXE || electron,
      args: process.env.DEV_TRACKER_EXE ? [] : ['.'],
      env: { ...process.env, DEV_TRACKER_TEST_DATA: storage }
    });
    const page = await desktop.firstWindow();
    await page.locator('#developer-details > summary').click();
    await page.getByRole('tab', { name: '开发地图', exact: true }).click();
    await page.locator('.node').waitFor();
    await page.waitForFunction(() => !document.getElementById('canvas').hidden);
    await client.connect(new StreamableHTTPClientTransport(new URL('mcp', page.url())));
    const update = async args => {
      const result = await client.callTool({ name: 'update_node', arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
    };
    const add = async (parent, title) => {
      await update({ id: parent, action: 'add', text: title });
      const nodes = JSON.parse((await client.callTool({ name: 'get_map', arguments: {} })).content[0].text);
      return nodes.find(node => node.title === title).id;
    };
    const parent = await add('root', '父分支');
    const leaf = await add(parent, 'AI 子任务');
    const sibling = await add('root', '另一分支');
    const edges = async expected => {
      await page.waitForFunction(expected => {
        const actual = [...document.querySelectorAll('#links path.ai-active')].map(edge => [edge.dataset.from, edge.dataset.to]);
        return JSON.stringify(actual.sort()) === JSON.stringify([...expected].sort());
      }, expected);
      assert.equal(await page.locator('#links path').count(), 3, 'all tree links remain present');
    };
    const startLeaf = async () => {
      await update({ id: leaf, action: 'start' });
      await edges([['root', parent], [parent, leaf]]);
    };
    await startLeaf();
    const appearance = await page.locator('#links path').evaluateAll(paths => paths.map(edge => ({
      active: edge.classList.contains('ai-active'),
      stroke: getComputedStyle(edge).stroke,
      width: getComputedStyle(edge).strokeWidth
    })));
    const activeStyle = appearance.find(edge => edge.active);
    const normalStyle = appearance.find(edge => !edge.active);
    assert.notEqual(activeStyle.stroke, normalStyle.stroke, 'reported work has a visually distinct path');
    assert.ok(parseFloat(activeStyle.width) > parseFloat(normalStyle.width), 'active path is stronger than idle links');
    await page.locator(`.node[data-id="${sibling}"]`).click();
    await edges([['root', parent], [parent, leaf]]);
    await mkdir('test-results', { recursive: true });
    await page.getByRole('button', { name: '适应画布', exact: true }).click();
    await page.screenshot({ path: 'test-results/branches-desktop.png' });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: '适应画布', exact: true }).click();
    await edges([['root', parent], [parent, leaf]]);
    await page.screenshot({ path: 'test-results/branches-mobile.png' });
    await update({ id: sibling, action: 'start' });
    await edges([['root', sibling]]);
    await update({ id: sibling, action: 'pause' });
    await edges([]);
    await startLeaf();
    await update({ id: leaf, action: 'submit' });
    await edges([]);
    const response = await page.evaluate(async id => {
      const state = await fetch('api/state').then(r => r.json());
      const response = await fetch('api/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'start', sessionId: state.context.sessionId })
      });
      return { ok: response.ok, state: await response.json() };
    }, sibling);
    assert.equal(response.ok, true);
    assert.equal(response.state.nodes.find(node => node.id === sibling).statusSource, 'manual');
    await page.waitForFunction(id => document.querySelector(`.node[data-id="${id}"]`).textContent.includes('人工标记'), sibling);
    await edges([]);
  } finally {
    try { await client.close(); }
    finally {
      if (desktop) await desktop.close();
      assert.equal(path.dirname(storage), path.resolve(tmpdir()));
      assert.ok(path.basename(storage).startsWith('dev-tracker-branches-'));
      await rm(storage, { recursive: true, force: true });
    }
  }
});
