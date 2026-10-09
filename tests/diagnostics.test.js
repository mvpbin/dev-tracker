import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDiagnostics } from '../diagnostics.js';

test('diagnostics cannot export project paths, payloads, sessions or raw errors', () => {
  const log = createDiagnostics();
  log.record('error', { stage: 'mcp', error: { name: 'private-user', code: 'private-token', message: 'C:/secret' }, body: 'secret', url: '/sessions/secret' });
  log.record('mcp_http', { method: 'POST', status: 500, durationMs: 12.2, projectRoot: 'C:/secret', sessionId: 'secret' });
  const entries = log.exportJSONL().trim().split('\n').map(JSON.parse);
  assert.deepEqual(Object.keys(entries[0]), ['time', 'event', 'stage', 'name', 'code']);
  assert.equal(entries[0].name, 'OTHER'); assert.equal(entries[0].code, 'OTHER');
  assert.equal(log.exportJSONL().includes('secret'), false);
  assert.equal(entries[1].durationMs, 12);
});

test('bounded diagnostics preserve recent failure context and explicitly save the export', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'dev-tracker-diagnostics-'));
  try {
    const log = createDiagnostics();
    for (let i = 0; i < 205; i++) log.record('mcp_http', { status: 200, durationMs: i });
    log.record('error', { stage: 'server', error: { name: 'Error', code: 'EADDRINUSE', message: 'secret' } });
    const file = path.join(folder, 'diagnostics.jsonl'); log.save(file);
    const entries = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(entries.length, 200); assert.equal(entries[0].durationMs, 6);
    assert.equal(entries.at(-1).code, 'EADDRINUSE');
    assert.equal(await readFile(file, 'utf8'), log.exportJSONL());
  } finally { await rm(folder, { recursive: true, force: true }); }
});
