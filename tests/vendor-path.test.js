import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, copyFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('vendor assets load when the chosen installation directory has a dot-prefixed ancestor', async () => {
  const base = await mkdtemp(path.join(tmpdir(), '.dev-tracker-vendor-'));
  const source = path.resolve('.');
  let server;
  try {
    for (const name of await readdir(source)) {
      if (name === 'package.json' || name.endsWith('.js')) await copyFile(path.join(source, name), path.join(base, name));
    }
    await symlink(path.join(source, 'node_modules'), path.join(base, 'node_modules'), 'junction');
    const { startServer } = await import(pathToFileURL(path.join(base, 'server.js')));
    server = await startServer({ storage: path.join(base, 'records'), port: 0 });
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const asset of ['dagre', 'lucide']) {
      const response = await fetch(`${url}/vendor/${asset}.js`);
      assert.equal(response.status, 200, `${asset} must load or the installed map cannot initialize`);
      assert.ok((await response.text()).length > 1000);
    }
    assert.equal((await fetch(`${url}/vendor/package.json`)).status, 404, 'only the two explicit vendor assets are exposed');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    assert.ok(path.basename(base).startsWith('.dev-tracker-vendor-'));
    await rm(base, { recursive: true, force: true });
  }
});
