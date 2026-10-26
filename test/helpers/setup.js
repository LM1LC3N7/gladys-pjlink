// -----------------------------------------------------------------------------
// The app with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a memory store, fake projectors on the loopback
// interface and the test clock of the kit (it moves 1 µs at every read; its
// timers fire only on `clock.advance()`). Network times are real and short.
// -----------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PjlinkApp } from '../../src/app.js';
import { TIMINGS } from '../../src/constants.js';
import { registerHandlers } from '../../src/handlers.js';
import { MemoryStore } from '../../src/store.js';
import { testClock } from '../kit/clock.mjs';
import { fakeProjector } from '../fixtures/fakeProjector.js';

export const SELECTOR = 'pjlink';
export const SERIAL = 'SN0001';
export const PID = `sn-${SERIAL}`;
export const id = (key, projectorId = PID) =>
  `ext:${SELECTOR}:pjlink:${projectorId}${key ? `:${key}` : ''}`;

export const FAST = {
  ...TIMINGS,
  connectTimeout: 300,
  requestTimeout: 300,
  idleClose: 300,
  readBudget: 2_000,
  identifyBudget: 3_000,
  commandBudget: 1_500,
  standbyBudget: 1_500,
  standbyRetry: 50,
  persistDelay: 5,
};

export async function waitFor(predicate, what, timeout = 3_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function memoryLogger() {
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map((a) => a?.message ?? String(a)).join(' ')}`);
  return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

/**
 * `projector`: options of the fake projector (or `false` for none);
 * `config`: the configuration (default: the fake's address).
 */
export async function setup(
  t,
  {
    projector: options = {},
    config,
    store,
    timings = {},
    clock = testClock(),
    connect = true,
    ...rest
  } = {},
) {
  const projector = options === false ? undefined : await fakeProjector(options);
  t.after(() => projector?.close());
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: config ?? { addresses: projector?.address ?? '' },
  });
  const logger = memoryLogger();
  const app = new PjlinkApp({
    gladys,
    logger,
    store: store ?? new MemoryStore(),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    timings: { ...FAST, ...timings },
    ...rest,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  if (connect) {
    await gladys.connect();
  }
  return { projector, gladys, app, logs: logger.lines, store: app.store, clock };
}

export const discovered = (gladys, projectorId = PID) =>
  gladys.fake.discoveredDevices.find((d) => d.external_id === id(undefined, projectorId));

export async function createDevice(gladys, projectorId = PID) {
  await waitFor(() => discovered(gladys, projectorId), 'the device in the Discovery tab');
  const device = discovered(gladys, projectorId);
  await gladys.fake.deviceCreated(device);
  return device;
}

export const press = (gladys, device, key, value = 1) =>
  gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id.endsWith(`:${key}`)),
    value,
  );

export const state = (gladys, key, projectorId = PID) =>
  gladys.fake.lastState(id(key, projectorId));

/** Closes the connection of the app to `projector`, as an idle close would, and waits for it. */
export async function dropConnection(app, projector) {
  app.clients.get(projector.address)?.current?.close();
  await waitFor(() => projector.open === 0, 'the connection closed');
}
