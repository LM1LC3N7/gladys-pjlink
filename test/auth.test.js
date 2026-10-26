// -----------------------------------------------------------------------------
// Passwords: a missing or refused password blocks its address, persisted,
// never tried again by itself; a new password (compared as typed in a run,
// by its 6-bit mark after a restart) or a successful "Check" lifts it. The
// password never reaches the logs, /data nor the status.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARK_BITS, markOf, newSalt } from '../src/authmark.js';
import { MemoryStore } from '../src/store.js';
import { PID, createDevice, discovered, press, setup, state, waitFor } from './helpers/setup.js';

const SECRET = 'Zq7-unlikely-pw';

test('the right password: digest before the first command only, nothing kept of it', async (t) => {
  const store = new MemoryStore();
  const { gladys, projector, logs, clock } = await setup(t, {
    store,
    projector: { power: '1', password: SECRET },
    config: { addresses: '', password: SECRET },
  });
  await gladys.fake.configUpdated({ addresses: projector.address, password: SECRET });
  const device = await createDevice(gladys);
  assert.deepEqual(await press(gladys, device, 'input', '32'), { success: true });
  assert.equal(projector.authFailures, 0);
  assert.equal(projector.digests.length, projector.connections);
  await clock.advance(10);
  const everything = JSON.stringify([
    logs,
    store.data,
    gladys.fake.connectionStatuses,
    gladys.fake.states,
  ]);
  assert.ok(!everything.includes(SECRET), 'the password never leaves');
  assert.deepEqual(store.data.authBlocks, {});
});

test('a refused password: blocked, persisted, never tried again by itself', async (t) => {
  const store = new MemoryStore();
  const { gladys, projector, app, logs, clock } = await setup(t, {
    store,
    projector: { password: 'right' },
    config: { addresses: '', password: SECRET },
  });
  await gladys.fake.configUpdated({ addresses: '127.0.0.1:1', password: SECRET });
  await gladys.fake.configUpdated({ addresses: projector.address, password: SECRET });
  assert.equal(projector.authFailures, 1);
  await clock.advance(10);
  const block = store.data.authBlocks[`127.0.0.1:${projector.port}`];
  assert.equal(block.kind, 'auth_refused');
  assert.ok(Number.isInteger(block.mark) && block.mark < 2 ** MARK_BITS);
  assert.match(gladys.fake.connectionStatus.message.en, /Password refused by: 127\.0\.0\.1/);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  // Hours later: nothing tried again, by the timers nor by a reconnection.
  await clock.advance(3 * 3600_000);
  await gladys.fake.configUpdated({ addresses: projector.address, password: SECRET });
  await gladys.disconnect();
  await gladys.connect();
  assert.equal(projector.authFailures, 1);
  assert.equal(projector.connections, 1);
  assert.ok(!JSON.stringify([logs, store.data, gladys.fake.connectionStatuses]).includes(SECRET));
  assert.equal(app.isAuthBlocked({ host: '127.0.0.1', port: projector.port }), true);
});

test('a new password lifts the block at once', async (t) => {
  const { gladys, projector } = await setup(t, {
    projector: { password: 'right' },
    config: { addresses: '', password: 'wrong' },
  });
  await gladys.fake.configUpdated({ addresses: projector.address, password: 'wrong' });
  assert.equal(projector.authFailures, 1);
  await gladys.fake.configUpdated({ addresses: projector.address, password: 'right' });
  await waitFor(() => discovered(gladys), 'the projector identified');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('after a restart: the same password stays blocked, another one is tried (by its mark)', async (t) => {
  const store = new MemoryStore();
  const first = await setup(t, {
    store,
    projector: { password: 'right' },
    config: { addresses: '', password: 'wrong' },
  });
  await first.gladys.fake.configUpdated({ addresses: first.projector.address, password: 'wrong' });
  await first.app.stop();
  assert.equal(first.projector.authFailures, 1);
  const address = first.projector.address;
  const same = await setup(t, {
    store,
    projector: false,
    config: { addresses: address, password: 'wrong' },
  });
  assert.equal(first.projector.authFailures, 1, 'not sent again after a restart');
  await same.app.stop();
  // Another password (its mark differs from the kept one: pick one that does).
  const block = Object.values(store.data.authBlocks)[0];
  let other = 'right';
  if (markOf(block.salt, other) === block.mark) {
    first.projector.state.password = other = 'right-2';
    assert.notEqual(markOf(block.salt, other), block.mark);
  }
  const next = await setup(t, {
    store,
    projector: false,
    config: { addresses: address, password: other },
  });
  await waitFor(() => discovered(next.gladys), 'identified with the new password');
  assert.deepEqual(Object.keys(next.app.data.authBlocks), []);
});

test('a successful "Check the projectors" lifts the block; a failing one keeps it', async (t) => {
  const { gladys, projector, app } = await setup(t, {
    projector: { password: 'right' },
    config: { addresses: '', password: 'right' },
  });
  projector.state.password = 'other';
  await gladys.fake.configUpdated({ addresses: projector.address, password: 'right' });
  assert.equal(projector.authFailures, 1);
  let ack = await gladys.fake.action('check_projectors', {});
  assert.match(ack.data.message.en, /password missing or refused/);
  assert.equal(projector.authFailures, 2, 'one try per press');
  projector.state.password = 'right';
  ack = await gladys.fake.action('check_projectors', {});
  assert.match(ack.data.message.en, /found, in the Discovery tab/);
  assert.equal(app.isAuthBlocked({ host: '127.0.0.1', port: projector.port }), false);
});

test('a password required but none typed: blocked, nothing sent; typing one lifts it', async (t) => {
  const { gladys, projector } = await setup(t, { projector: { power: '1', password: 'pw' } });
  assert.deepEqual(projector.lines, []);
  assert.match(gladys.fake.connectionStatus.message.en, /A PJLink password is set on/);
  await gladys.fake.configUpdated({ addresses: projector.address, password: 'pw' });
  const device = await createDevice(gladys);
  await waitFor(() => state(gladys, 'status') === 'On', 'the states');
  assert.deepEqual(await press(gladys, device, 'input', '32'), { success: true });
});

test('commands to a blocked address: nothing sent', async (t) => {
  const { gladys, projector, app } = await setup(t, {
    projector: { power: '1', password: 'pw' },
    config: { addresses: '', password: 'pw' },
  });
  await gladys.fake.configUpdated({ addresses: projector.address, password: 'pw' });
  const device = await createDevice(gladys);
  app.setAuthBlock(app.data.projectors[PID], 'auth_refused');
  const connections = projector.connections;
  const ack = await press(gladys, device, 'input', '32');
  assert.match(ack.error, /password missing or refused \(see the configuration\), nothing sent/);
  assert.equal(projector.connections, connections);
});

test('the mark identifies nothing: about 1 in 64 of the four-digit codes share it', () => {
  const salt = newSalt();
  const mark = markOf(salt, '4821');
  let matches = 0;
  for (let i = 0; i < 10_000; i += 1) {
    if (markOf(salt, String(i).padStart(4, '0')) === mark) {
      matches += 1;
    }
  }
  assert.ok(matches >= 80 && matches <= 260, `${matches} codes share the mark`);
  assert.notEqual(markOf(newSalt(), 'x'), undefined);
});
