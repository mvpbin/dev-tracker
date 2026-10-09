import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoff } from '../handoff.js';
import { compactHandoff } from '../compact-handoff.js';

test('AI handoff stays bounded as requirement history grows while full export preserves history and real progress counts', t => {
  const requirements = Array.from({ length: 1000 }, (_, i) => ({ text: `${i} ${'需求'.repeat(995)}`, time: String(i), source: 'manual' }));
  requirements[0].text = 'OLD REQUIREMENT MUST SURVIVE EXPORT';
  const nodes = [{ id: 'root', parent: null, title: 'Root', status: 'idle', tasks: requirements, notes: [] },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, parent: 'root', title: '标题'.repeat(1000), status: i === 39 ? 'active' : 'pending',
      owner: i === 39 ? { sessionId: 'active-owner', label: 'Chat' } : undefined,
      releaseIncluded: true, criteria: '条件'.repeat(1000), tasks: requirements.slice(-5), notes: requirements.slice(-5) }))];
  const evidence = { root: 'C:/test/project', fingerprint: 'version', scannedAt: 'now', changes: [], gitChanges: [], tests: [] };
  const full = buildHandoff({ nodes, events: [], release: { goal: 'Release' } }, evidence);
  const compact = compactHandoff(full);
  t.diagnostic(`Full fixture: ${Buffer.byteLength(JSON.stringify(full))} bytes; compact: ${Buffer.byteLength(JSON.stringify(compact))} bytes`);
  assert.ok(Buffer.byteLength(JSON.stringify(full)) > 4000000, 'fixture reproduces the original context growth');
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 65536, 'default AI context must not carry the entire project history');
  assert.equal(compact.snapshot.nodes.find(node => node.id === 'root').requirementsOmitted, 997);
  assert.equal(compact.snapshot.nodesOmitted, 33);
  assert.equal(compact.snapshot.nodes.find(node => node.id === 'n39').owner.sessionId, 'active-owner', 'active work remains available for safe continuation');
  assert.equal(compact.snapshot.overview.total, 40, 'summary truncation cannot alter the progress denominator');
  assert.equal(compact.snapshot.outstandingOmitted.pending, 31);
  assert.match(full.markdown, /OLD REQUIREMENT MUST SURVIVE EXPORT/);
  assert.doesNotMatch(compact.markdown, /OLD REQUIREMENT MUST SURVIVE EXPORT/);
  assert.equal(full.snapshot.nodes[0].requirements.length, 1000, 'creating a summary cannot mutate or delete historical records');
});
