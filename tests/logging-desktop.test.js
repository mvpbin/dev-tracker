import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron } from 'playwright';
import electron from 'electron';

test('desktop errors survive a disconnected console and retain private diagnostics', { timeout: 60000 }, async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'dev-tracker-logging-desktop-'));
  const project = path.join(storage, 'private-project'), moved = path.join(storage, 'moved-project');
  const payload = 'logging-private-payload';
  let desktop, primaryError, stage = 'launch';
  const stop = async () => {
    if (!desktop) return;
    const child = desktop.process();
    let timer;
    try {
      await Promise.race([desktop.close(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Logging desktop close timed out (test PID ${child.pid})`)), 10000);
      })]);
    } catch (error) {
      if (child.exitCode === null) await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      throw error;
    } finally { clearTimeout(timer); desktop = undefined; }
  };
  try {
    await mkdir(project);
    await writeFile(path.join(project, 'source.js'), 'export const value = 1;\n');
    desktop = await _electron.launch({ timeout: 15000, executablePath: process.env.DEV_TRACKER_EXE || electron,
      args: process.env.DEV_TRACKER_EXE ? [] : ['.'], env: { ...process.env, DEV_TRACKER_TEST_DATA: storage } });
    const page = await desktop.firstWindow();
    await page.locator('#overview-summary').waitFor();
    stage = 'select';
    await desktop.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, project);
    await page.locator('#choose').click();
    await page.locator('#project-path').getByText(project, { exact: true }).waitFor();
    await desktop.evaluate(() => {
      globalThis.loggingUncaught = [];
      globalThis.loggingConsoleCalls = 0;
      process.on('uncaughtException', error => globalThis.loggingUncaught.push(error.code || error.name));
      console.error = () => {
        globalThis.loggingConsoleCalls++;
        const error = new Error('Disconnected test console'); error.code = 'EPIPE'; throw error;
      };
    });
    stage = 'scan';
    await rename(project, moved);
    await page.waitForTimeout(6000);
    const evidence = await page.evaluate(async () => (await fetch('api/evidence')).json());
    assert.match(evidence.error, /ENOENT/, 'a failed background scan remains visible instead of terminating the desktop');
    assert.deepEqual(await desktop.evaluate(() => globalThis.loggingUncaught), [], 'background error reporting must not create an uncaught EPIPE');
    stage = 'error-response';
    const response = await page.evaluate(async secret => {
      const result = await fetch('api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"private":"${secret}",` });
      return { status: result.status, body: await result.json() };
    }, payload);
    assert.equal(response.status, 500, 'malformed JSON still reaches the error response when console writes fail');
    assert.equal(typeof response.body.error, 'string');
    assert.equal((await page.evaluate(async () => (await fetch('api/state')).json())).nodes.length > 0, true, 'requests remain usable after timer and middleware errors');
    await page.locator('#map-tab').click();
    await page.locator('.node').first().waitFor();
    assert.deepEqual(await desktop.evaluate(() => globalThis.loggingUncaught), []);
    assert.equal(await desktop.evaluate(() => globalThis.loggingConsoleCalls), 0, 'desktop diagnostics must avoid the unavailable console entirely');
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/logging-desktop.png' });
    stage = 'close';
    await stop();
    stage = 'persisted-diagnostics';
    const text = await readFile(path.join(storage, 'diagnostics.jsonl'), 'utf8');
    const entries = text.trim().split('\n').map(JSON.parse);
    assert.ok(entries.some(entry => entry.event === 'error' && entry.stage === 'server' && entry.code === 'ENOENT'), 'normal shutdown persists the real background scan failure');
    assert.ok(entries.some(entry => entry.event === 'error' && entry.stage === 'server' && entry.name === 'SyntaxError'), 'middleware failures are retained in the same diagnostics');
    assert.ok(entries.some(entry => entry.event === 'close' && entry.stage === 'desktop'), 'the application closes normally after both errors');
    for (const secret of [payload, storage, project, moved, 'private-project', 'moved-project']) {
      assert.equal(text.includes(secret), false, 'diagnostics must omit request payloads and fixture paths');
    }
  } catch (error) {
    primaryError = error;
    console.error(`Logging desktop failure at ${stage}:`, error.stack || error);
    throw error;
  } finally {
    try { await stop(); }
    catch (error) {
      console.error(`Logging desktop shutdown failure after ${stage}:`, error.stack || error);
      if (!primaryError) { primaryError = error; throw error; }
    }
    finally {
      try {
        assert.equal(path.dirname(storage), path.resolve(tmpdir()));
        assert.ok(path.basename(storage).startsWith('dev-tracker-logging-desktop-'));
        await rm(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (error) {
        console.error(`Logging desktop fixture cleanup failure after ${stage}:`, error.stack || error);
        if (!primaryError) throw error;
      }
    }
  }
});
