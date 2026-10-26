// -----------------------------------------------------------------------------
// Standby, the protective command: never refused for a reading, a command,
// a queue, a password block, Gladys or the configuration; cuts a frozen
// reading; nothing queued before it leaves after it; kept in /data and sent
// again (3 times at most) until a reading shows it applied; sent at boot
// from /data before anything else.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PjlinkApp } from '../src/app.js';
import { MemoryStore, emptyData } from '../src/store.js';
import { testClock } from './kit/clock.mjs';
import { fakeProjector } from './fixtures/fakeProjector.js';
import {
  FAST,
  PID,
  SELECTOR,
  createDevice,
  dropConnection,
  id,
  memoryLogger,
  press,
  setup,
  sleep,
  state,
  waitFor,
} from './helpers/setup.js';

const powr = (projector) => projector.lines.filter((l) => /^%1POWR [01]$/.test(l));

test('Standby: POWR 0 at once, no reading before, confirmed by the power read back', async (t) => {
  const { gladys, projector } = await setup(t, { projector: { power: '1', coolDown: true } });
  const device = await createDevice(gladys);
  const before = projector.lines.length;
  assert.deepEqual(await press(gladys, device, 'standby'), { success: true });
  assert.deepEqual(projector.lines.slice(before), ['%1POWR 0', '%1POWR ?']);
  assert.equal(state(gladys, 'status'), 'Cooling down');
  assert.equal(state(gladys, 'power'), 0);
});

test('Standby cuts a reading frozen for 1 s, on a new connection after the old one closed', async (t) => {
  const { gladys, projector, app } = await setup(t, {
    projector: { power: '1' },
    timings: { readBudget: 10_000, requestTimeout: 8_000 },
  });
  const device = await createDevice(gladys);
  await dropConnection(app, projector);
  projector.state.silent.add('ERST');
  app.lastAttempt.clear();
  const reading = app.readState(app.data.projectors[PID]);
  await waitFor(() => projector.lines.at(-1) === '%1ERST ?', 'the frozen question');
  const started = Date.now();
  assert.deepEqual(await press(gladys, device, 'standby'), { success: true });
  const took = Date.now() - started;
  assert.ok(took < FAST.frozenCut + 600, `${took} ms`);
  assert.equal(projector.state.power, '0');
  assert.equal(projector.peak, 1, 'never two connections at once');
  assert.equal(projector.refused, 0);
  // The reading cut is no failure: nothing said unreachable.
  assert.equal(await reading, undefined);
  assert.notEqual(state(gladys, 'status'), 'Unreachable');
});

test('Standby cuts a connection frozen before its greeting', async (t) => {
  const { gladys, projector, app } = await setup(t, {
    projector: { power: '1' },
    timings: { connectTimeout: 8_000, readBudget: 10_000 },
  });
  const device = await createDevice(gladys);
  await dropConnection(app, projector);
  projector.state.greeting = '';
  app.lastAttempt.clear();
  const reading = app.readState(app.data.projectors[PID]);
  await waitFor(() => projector.open === 1, 'the frozen connection');
  setTimeout(() => {
    projector.state.greeting = undefined;
  }, 500);
  const started = Date.now();
  assert.deepEqual(await press(gladys, device, 'standby'), { success: true });
  assert.ok(Date.now() - started < FAST.frozenCut + 600);
  assert.equal(await reading, undefined);
});

test('nothing queued before a Standby leaves after it', async (t) => {
  const { gladys, projector } = await setup(t, { projector: { power: '0', latencyMs: 80 } });
  const device = await createDevice(gladys);
  const presses = [press(gladys, device, 'power_on'), press(gladys, device, 'power_on')];
  await sleep(20);
  const standby = press(gladys, device, 'standby');
  const acks = await Promise.all([...presses, standby]);
  const sent = powr(projector);
  const stop = sent.lastIndexOf('%1POWR 0');
  assert.ok(stop !== -1, sent.join());
  assert.ok(!sent.slice(stop + 1).includes('%1POWR 1'), `after the standby: ${sent}`);
  assert.equal(projector.state.power, '0');
  assert.deepEqual(acks[2], { success: true });
  for (const ack of acks.slice(0, 2).filter((a) => !a.success)) {
    assert.match(ack.error, /standby asked meanwhile, nothing sent|^Sent/);
  }
});

test('a password refused: Standby never sends it again, but goes if the password was removed', async (t) => {
  const { gladys, projector, app } = await setup(t, {
    projector: { power: '1', password: 'good' },
    config: undefined,
  });
  await gladys.fake.configUpdated({ addresses: projector.address, password: 'good' });
  const device = await createDevice(gladys);
  await gladys.fake.configUpdated({ addresses: projector.address, password: 'wrong' });
  await dropConnection(app, projector);
  // A reading meets the refusal: the address is blocked.
  app.lastAttempt.clear();
  await app.readState(app.data.projectors[PID]);
  assert.ok(app.isAuthBlocked(app.data.projectors[PID]));
  const digests = projector.digests.length;
  await dropConnection(app, projector);
  const ack = await press(gladys, device, 'standby');
  assert.match(ack.error, /password missing or refused, nothing sent \(kept\)/);
  assert.equal(projector.digests.length, digests, 'the refused password is not sent again');
  assert.equal(projector.state.power, '1');
  // The projector no longer asks for a password: the standby goes.
  projector.state.password = '';
  await dropConnection(app, projector);
  assert.deepEqual(await press(gladys, device, 'standby'), { success: true });
  assert.equal(projector.state.power, '0');
});

test('Standby while unreachable: kept in /data, sent by the next reading, cleared once applied', async (t) => {
  const { gladys, projector, app, clock, store } = await setup(t, { projector: { power: '1' } });
  const device = await createDevice(gladys);
  const port = projector.port;
  await projector.close();
  await sleep(30);
  const ack = await press(gladys, device, 'standby');
  assert.match(
    ack.error,
    /does not answer, nothing sent \(kept, sent again at the next readings\)/,
  );
  await clock.advance(10);
  assert.ok(store.data.projectors[PID].standby, 'kept in /data');
  assert.match(gladys.fake.connectionStatus.message.en, /Standby not confirmed yet/);
  // Back: the next reading sends it (decided on a power read after the click).
  const back = await fakeProjector({ power: '1', port });
  t.after(() => back.close());
  await clock.advance(FAST.followUps[0]);
  await waitFor(() => back.state.power === '0', 'the standby sent again');
  await waitFor(() => !app.data.projectors[PID].standby, 'cleared');
  assert.deepEqual(powr(back), ['%1POWR 0']);
});

test('a standby not applied is sent again 3 times at most', async (t) => {
  const { gladys, projector, app, clock } = await setup(t, {
    projector: { power: '1', ignore: true },
  });
  const device = await createDevice(gladys);
  const ack = await press(gladys, device, 'standby');
  assert.match(ack.error, /^Sent; Living room shows "On": not applied yet/);
  for (let i = 0; i < 6; i += 1) {
    app.lastAttempt.clear();
    await app.readState(app.data.projectors[PID]);
  }
  assert.equal(powr(projector).length, 1 + 3);
  assert.equal(app.data.projectors[PID].standby, undefined);
  await clock.advance(30_000);
});

test('a power on started after the standby (warming up) is never stopped by a resend', async (t) => {
  const { gladys, projector, app } = await setup(t, { projector: { power: '1', ignore: true } });
  const device = await createDevice(gladys);
  await press(gladys, device, 'standby');
  projector.state.power = '3';
  app.lastAttempt.clear();
  await app.readState(app.data.projectors[PID]);
  assert.deepEqual(powr(projector), ['%1POWR 0']);
  assert.equal(app.data.projectors[PID].standby, undefined);
});

test('a newer Power on that left and was accepted cancels the resend; one refused does not', async (t) => {
  const { gladys, projector, app } = await setup(t, { projector: { power: '1', ignore: true } });
  const device = await createDevice(gladys);
  await press(gladys, device, 'standby');
  // Other commands wait for the standby.
  const input = await press(gladys, device, 'input', '32');
  assert.match(input.error, /standby in progress \(not confirmed yet\), nothing sent/);
  projector.state.power = '0';
  projector.state.refuseSet.POWR = 'ERR4';
  const refused = await press(gladys, device, 'power_on');
  assert.equal(refused.success, false);
  assert.ok(app.data.projectors[PID].standby, 'kept: the power on was refused');
  projector.state.refuseSet = {};
  projector.state.ignore = false;
  assert.deepEqual(await press(gladys, device, 'power_on'), { success: true });
  assert.equal(app.data.projectors[PID].standby, undefined);
});

test('Standby while warming up (ERR3): kept, sent again once on', async (t) => {
  const { gladys, projector, app } = await setup(t, { projector: { power: '3' } });
  const device = await createDevice(gladys);
  const ack = await press(gladys, device, 'standby');
  assert.match(
    ack.error,
    /Refused by Living room \(ERR3, warming up\): sent again at the next readings/,
  );
  projector.state.power = '1';
  app.lastAttempt.clear();
  await app.readState(app.data.projectors[PID]);
  assert.equal(projector.state.power, '0');
  assert.equal(app.data.projectors[PID].standby, undefined);
});

/** A store holding the projector of `fake` with a standby kept at `at`. */
function keptStandby(fake, at, extra = {}) {
  const data = emptyData();
  data.projectors[PID] = {
    id: PID,
    host: '127.0.0.1',
    port: fake.port,
    name: 'Living room',
    cls: 2,
    serial: 'SN0001',
    maker: 'EPSON',
    model: 'EB-W49',
    inputs: [],
    standby: { at, sends: 0 },
    ...extra,
  };
  return new MemoryStore(data);
}

function bootApp(t, store, clock, gladys = createFakeGladys({ selector: SELECTOR, config: {} })) {
  const app = new PjlinkApp({
    gladys,
    logger: memoryLogger(),
    store,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    timings: FAST,
  });
  t.after(() => app.stop());
  return app;
}

test('at boot, a standby kept in /data leaves at once, without Gladys nor a reading', async (t) => {
  const fake = await fakeProjector({ power: '1' });
  t.after(() => fake.close());
  const clock = testClock();
  const store = keptStandby(fake, clock.now() - 60_000);
  const app = bootApp(t, store, clock);
  await app.boot();
  assert.deepEqual(fake.lines, ['%1POWR 0', '%1POWR ?']);
  assert.equal(fake.state.power, '0');
  await clock.advance(10);
  assert.equal(store.data.projectors[PID].standby, undefined);
});

test('at boot, a standby dated in the future or expired is dropped, never sent', async (t) => {
  for (const offset of [5 * 60_000, -(FAST.standbyKeep + 1_000)]) {
    const fake = await fakeProjector({ power: '1' });
    t.after(() => fake.close());
    const clock = testClock();
    const app = bootApp(t, keptStandby(fake, clock.now() + offset), clock);
    await app.boot();
    assert.deepEqual(fake.lines, [], String(offset));
  }
});

test('at boot, a projector asking for a password gets the standby once the configuration is read', async (t) => {
  const fake = await fakeProjector({ power: '1', password: 'secret-pw' });
  t.after(() => fake.close());
  const clock = testClock();
  const store = keptStandby(fake, clock.now() - 60_000);
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { addresses: fake.address, password: 'secret-pw' },
  });
  const app = bootApp(t, store, clock, gladys);
  await app.boot();
  assert.deepEqual(fake.lines, [], 'nothing sent without the password');
  assert.equal(fake.digests.length, 0);
  // No block from a boot without configuration.
  assert.deepEqual(Object.keys(app.data.authBlocks), []);
  await app.start(await gladys.getConfig(), { connected: true });
  assert.deepEqual(fake.lines.slice(0, 2), ['%1POWR 0', '%1POWR ?']);
  assert.equal(fake.state.power, '0');
});

test('getConfig() failing: said in the status, tried again; Standby still goes from /data', async (t) => {
  const fake = await fakeProjector({ power: '1' });
  t.after(() => fake.close());
  const clock = testClock();
  const store = keptStandby(fake, clock.now(), { standby: undefined });
  const gladys = createFakeGladys({ selector: SELECTOR, config: { addresses: fake.address } });
  let failures = 0;
  let calls = 0;
  const getConfig = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    calls += 1;
    // The first call is the resynchronization of the SDK's connect().
    if (calls > 1 && failures < 2) {
      failures += 1;
      throw new Error('503');
    }
    return getConfig();
  };
  const app = bootApp(t, store, clock, gladys);
  const { registerHandlers } = await import('../src/handlers.js');
  registerHandlers(gladys, app, memoryLogger());
  await gladys.connect();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /configuration could not be read/);
  const device = { external_id: id() };
  const ack = await gladys.fake.setValue(device, { external_id: id('standby') }, 1);
  assert.deepEqual(ack, { success: true });
  assert.equal(fake.state.power, '0');
  await clock.advance(FAST.configRetry);
  await clock.advance(FAST.configRetry * 2);
  await waitFor(() => app.configured, 'the configuration read');
  assert.equal(failures, 2);
});

test('a standby kept is written to /data before anything is sent, even if the save fails', async (t) => {
  const { gladys, projector, app } = await setup(t, {
    projector: { power: '1' },
    store: new MemoryStore(emptyData(), { failSave: true }),
  });
  const device = await createDevice(gladys);
  assert.deepEqual(await press(gladys, device, 'standby'), { success: true });
  assert.equal(projector.state.power, '0');
  await app.updateStatus();
});
