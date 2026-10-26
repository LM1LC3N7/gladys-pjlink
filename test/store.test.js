// -----------------------------------------------------------------------------
// /data: one write at a time, never written over when unreadable, moved
// aside when not JSON, sanitized (no prototype pollution, bounded values).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, sanitize } from '../src/store.js';

async function dir(t) {
  const path = await mkdtemp(join(tmpdir(), 'pjlink-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('missing: empty; saved: read back, mode 0600, writes in order', async (t) => {
  const store = new FileStore({ dir: await dir(t) });
  const data = await store.load();
  assert.deepEqual(Object.keys(data.projectors), []);
  data.projectors['sn-AB12'] = {
    id: 'sn-AB12',
    host: '10.0.0.5',
    port: 4352,
    inputs: [{ code: '31' }],
  };
  await Promise.all([store.save({ ...data, n: 1 }), store.save(data)]);
  const again = await new FileStore({ dir: store.dir }).load();
  assert.equal(again.projectors['sn-AB12'].host, '10.0.0.5');
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
});

test('not JSON: moved aside to .bad, never written over', async (t) => {
  const path = await dir(t);
  await writeFile(join(path, 'pjlink.json'), '{oops');
  const store = new FileStore({ dir: path });
  await store.load();
  assert.equal(store.corrupted, true);
  assert.equal(await readFile(join(path, 'pjlink.json.bad'), 'utf8'), '{oops');
});

test(
  'unreadable: kept as is, nothing written over it',
  { skip: process.getuid?.() === 0 },
  async (t) => {
    const path = await dir(t);
    const file = join(path, 'pjlink.json');
    await writeFile(file, '{"projectors":{}}');
    await chmod(file, 0o000);
    const store = new FileStore({ dir: path });
    await store.load();
    assert.equal(store.unavailable, true);
    await assert.rejects(store.save({ projectors: {} }), /not written over/);
    await chmod(file, 0o600);
    assert.equal(await readFile(file, 'utf8'), '{"projectors":{}}');
  },
);

test('sanitized: no prototype pollution, ids and values checked', () => {
  const data = sanitize(
    JSON.parse(`{
      "__proto__": { "polluted": 1 },
      "authBlocks": { "10.0.0.5:4352": { "kind": "auth_refused", "salt": "${'a'.repeat(32)}", "mark": 9, "password": "x" },
                      "__proto__": { "kind": "auth_refused" } },
      "projectors": {
        "sn-AB12": { "id": "sn-AB12", "host": "10.0.0.5\\r", "port": 99999, "inputs": [{ "code": "31" }, { "code": "9Z" }, { "code": "31" }],
                     "standby": { "at": 5, "sends": 1 }, "name": "a\\u0007b" },
        "../x": { "id": "../x" },
        "constructor": { "id": "constructor" }
      }
    }`),
  );
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(data.projectors), ['sn-AB12']);
  const p = data.projectors['sn-AB12'];
  assert.equal(p.host, '');
  assert.equal(p.port, 4352);
  assert.deepEqual(p.inputs, [{ code: '31' }]);
  assert.deepEqual(p.standby, { at: 5, sends: 1, accepted: false });
  assert.equal(p.name, 'ab');
  assert.deepEqual(Object.keys(data.authBlocks), ['10.0.0.5:4352']);
  assert.equal(data.authBlocks['10.0.0.5:4352'].password, undefined);
});
