// -----------------------------------------------------------------------------
// The readings in time: at the interval (one clock read per decision), never
// sooner (restart, reconnection, saved configuration, Check button, Scan,
// device created), on the test clock that moves at every read, and on the
// real clock sped up 20 times (the period measured). Nothing stale published
// again as new.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POLL_INTERVAL } from '../src/constants.js';
import { MemoryStore, emptyData } from '../src/store.js';
import { measurePeriod, realClock, spyOn, testClock } from './kit/clock.mjs';
import { fakeProjector } from './fixtures/fakeProjector.js';
import { PID, createDevice, setup, waitFor } from './helpers/setup.js';

const INTERVAL = POLL_INTERVAL.default * 1000;
const powerReads = (projector) => projector.lines.filter((l) => l === '%1POWR ?').length;

async function created(t, options = {}) {
  const ctx = await setup(t, options);
  const read = spyOn(ctx.app, 'read', ctx.clock);
  await createDevice(ctx.gladys);
  await waitFor(() => read.calls.length === 1, 'the first reading');
  return { ...ctx, read };
}

test('a reading at once, then every interval, never sooner', async (t) => {
  const { clock, read, projector, app } = await created(t);
  await waitFor(() => !app.inFlight.has(PID), 'the end of the first reading');
  await clock.advance(INTERVAL - 1);
  assert.equal(read.calls.length, 1);
  await clock.advance(1);
  await waitFor(() => read.calls.length === 2, 'the second reading');
  await waitFor(() => powerReads(projector) === 2 && !app.inFlight.has(PID), 'its end');
  await clock.advance(INTERVAL);
  await waitFor(() => read.calls.length === 3, 'the third reading');
  const gaps = read.calls.slice(1).map((c, i) => c.at - read.calls[i].at);
  assert.ok(
    gaps.every((g) => g >= INTERVAL - 1 && g < INTERVAL + 5),
    gaps.join(),
  );
});

test('reconnection, saved configuration, Check, Scan, device updated: never read sooner', async (t) => {
  const { gladys, clock, read, projector } = await created(t);
  await clock.advance(INTERVAL / 2);
  const states = gladys.fake.states.length;
  await gladys.disconnect();
  await gladys.connect();
  await gladys.fake.configUpdated({ addresses: projector.address });
  await gladys.fake.action('check_projectors', {});
  await gladys.fake.scanRequest();
  await gladys.fake.deviceUpdated(gladys.fake.discoveredDevices[0]);
  assert.equal(read.calls.length, 1);
  assert.equal(powerReads(projector), 1);
  // Nothing published again as new by the reconnection.
  assert.equal(gladys.fake.states.length, states);
});

test('after a restart: the time of the last reading in /data paces the first one', async (t) => {
  const clock = testClock();
  const fake = await fakeProjector();
  t.after(() => fake.close());
  for (const [lastPollAt, firstAfter] of [
    [clock.now() - 10_000, INTERVAL - 10_000],
    // A date in the future counts as now: a whole interval.
    [clock.now() + 3_600_000, INTERVAL],
  ]) {
    const data = emptyData();
    data.projectors[PID] = {
      id: PID,
      host: '127.0.0.1',
      port: fake.port,
      name: 'P',
      cls: 2,
      serial: 'SN0001',
      maker: 'EPSON',
      model: 'EB-W49',
      inputs: [],
      lastPollAt,
    };
    const { app, gladys } = await setup(t, {
      projector: false,
      clock,
      store: new MemoryStore(data),
      connect: false,
      config: { addresses: fake.address },
    });
    gladys.fake.devices.push({ external_id: `ext:pjlink:pjlink:${PID}`, features: [] });
    const read = spyOn(app, 'read', clock);
    await gladys.connect();
    await clock.advance(firstAfter - 5);
    assert.equal(read.calls.length, 0, `not before ${firstAfter} ms`);
    await clock.advance(10);
    await waitFor(() => read.calls.length === 1, 'the first reading');
    await app.stop();
  }
});

test('the time of a reading is written to /data before it starts', async (t) => {
  const store = new MemoryStore();
  const { clock, app } = await created(t, { store });
  await clock.advance(10);
  assert.ok(store.data.projectors[PID].lastPollAt <= clock.now());
  assert.ok(app.data.projectors[PID].lastPollAt > 0);
});

test('real clock x20: readings at the interval, measured', async (t) => {
  const clock = realClock({ speed: 20 });
  t.after(() => clock.close());
  const { app, gladys } = await setup(t, { clock });
  const read = spyOn(app, 'read', clock);
  await createDevice(gladys);
  await measurePeriod(read, { count: 3, period: INTERVAL });
  await app.stop();
});

test('at most 280 states a minute, all projectors together', async (t) => {
  const { app, clock } = await setup(t, { projector: false });
  assert.equal(app.allowStates(270), true);
  assert.equal(app.allowStates(20), false);
  await clock.advance(60_001);
  assert.equal(app.allowStates(20), true);
});

test('the timer falling during a background reading: the readings go on at the interval', async (t) => {
  const { clock, read, projector, app } = await created(t);
  await waitFor(() => !app.inFlight.has(PID), 'the end of the first reading');
  // A background reading (follow-up, Check button) in progress when the timer falls.
  projector.latencyMs = 150;
  app.lastAttempt.clear();
  const background = app.readState(app.data.projectors[PID]);
  assert.ok(app.inFlight.has(PID));
  await clock.advance(INTERVAL);
  await background;
  projector.latencyMs = 0;
  assert.ok(app.pollTimer !== undefined, 'a timer is set again');
  const before = read.calls.length;
  for (let i = 0; i < 2; i += 1) {
    await clock.advance(INTERVAL);
    await waitFor(() => read.calls.length === before + i + 1, `the reading ${i + 1} after`);
    await waitFor(() => !app.inFlight.has(PID), 'its end');
  }
});
