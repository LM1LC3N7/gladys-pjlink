// -----------------------------------------------------------------------------
// The app end to end: devices, readings and the commands other than Standby
// (test/standby.test.js), on fake projectors over the loopback interface.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressId } from '../src/app.js';
import { MemoryStore } from '../src/store.js';
import { fakeProjector } from './fixtures/fakeProjector.js';
import {
  FAST,
  PID,
  createDevice,
  discovered,
  dropConnection,
  id,
  press,
  setup,
  sleep,
  state,
  waitFor,
} from './helpers/setup.js';

test('a typed address becomes a Gladys device, keyed by its serial number', async (t) => {
  const { gladys } = await setup(t);
  await waitFor(() => discovered(gladys), 'the device');
  const device = discovered(gladys);
  assert.equal(device.name, 'Living room');
  assert.deepEqual(device.params, [{ name: 'IP_ADDRESS', value: '127.0.0.1' }]);
  const byKey = Object.fromEntries(device.features.map((f) => [f.external_id.split(':').pop(), f]));
  assert.deepEqual(Object.keys(byKey), [
    'power',
    'power_on',
    'standby',
    'status',
    'input',
    'av_mute',
    'lamp_hours',
    'errors',
  ]);
  assert.deepEqual(
    [byKey.power.category, byKey.power.type, byKey.power.read_only],
    ['unknown', 'binary', true],
  );
  for (const key of ['power_on', 'standby']) {
    assert.deepEqual([byKey[key].category, byKey[key].type], ['button', 'push']);
  }
  // Never a switch: an "everything off" must not reach a projector.
  assert.ok(
    device.features.every((f) => (f.category !== 'switch' && f.type !== 'binary') || f.read_only),
  );
  assert.deepEqual(byKey.input.supported_options, [
    { value: '11', label: 'Computer' },
    { value: '31', label: 'HDMI 1' },
    { value: '32', label: 'HDMI 2' },
  ]);
  // Labels are strings (the core's Joi schema refuses an object).
  assert.ok(byKey.input.supported_options.every((o) => typeof o.label === 'string'));
  assert.deepEqual(
    [byKey.lamp_hours.category, byKey.lamp_hours.type, byKey.lamp_hours.unit],
    ['duration', 'integer', 'hours'],
  );
  assert.deepEqual([byKey.av_mute.category, byKey.av_mute.type], ['television', 'volume-mute']);
});

test('a class 1 projector is keyed by its address, its inputs named by type', async (t) => {
  const { gladys, projector } = await setup(t, { projector: { cls: 1, serial: undefined } });
  const pid = addressId({ host: '127.0.0.1', port: projector.port });
  assert.equal(pid, `ip-127-0-0-1-${projector.port}`);
  await waitFor(() => discovered(gladys, pid), 'the device');
  const input = discovered(gladys, pid).features.find((f) => f.external_id.endsWith(':input'));
  assert.deepEqual(
    input.supported_options.map((o) => o.label),
    ['RGB 1', 'Digital 1', 'Digital 2'],
  );
  assert.ok(
    projector.lines.every((l) => l.startsWith('%1')),
    'class 1 commands only',
  );
});

test('a created projector publishes its states', async (t) => {
  const { gladys } = await setup(t, { projector: { power: '1', errors: '010020' } });
  await createDevice(gladys);
  await waitFor(() => state(gladys, 'status') !== undefined, 'the states');
  assert.equal(state(gladys, 'status'), 'On');
  assert.equal(state(gladys, 'power'), 1);
  assert.equal(state(gladys, 'input'), '31');
  assert.equal(state(gladys, 'av_mute'), 0);
  assert.equal(state(gladys, 'lamp_hours'), 1234);
  assert.equal(state(gladys, 'errors'), 'Lamp: warning, Filter: error');
});

test('a model refusing a question (ERR1) still gives the others', async (t) => {
  const { gladys } = await setup(t, { projector: { refuse: { LAMP: 'ERR1', ERST: 'ERR1' } } });
  await createDevice(gladys);
  await waitFor(() => state(gladys, 'status') === 'Standby', 'the status');
  assert.equal(state(gladys, 'lamp_hours'), undefined);
  assert.equal(state(gladys, 'errors'), undefined);
});

test('Power on: decided on the power read just before, confirmed by a read back', async (t) => {
  const { gladys, projector } = await setup(t, { projector: { warmUp: true } });
  const device = await createDevice(gladys);
  assert.deepEqual(await press(gladys, device, 'power_on'), { success: true });
  assert.deepEqual(projector.commands(), ['%1POWR 1']);
  assert.equal(state(gladys, 'status'), 'Warming up');
  // Already on (or warming up): nothing sent.
  assert.deepEqual(await press(gladys, device, 'power_on'), { success: true });
  assert.deepEqual(projector.commands(), ['%1POWR 1']);
});

test('Power on while cooling down: nothing sent', async (t) => {
  const { gladys, projector } = await setup(t, { projector: { power: '2' } });
  const device = await createDevice(gladys);
  const ack = await press(gladys, device, 'power_on');
  assert.equal(ack.success, false);
  assert.match(ack.error, /cooling down, nothing sent/);
  assert.deepEqual(projector.commands(), []);
});

test('a command answered OK but not applied is "not applied yet", read again later', async (t) => {
  const { gladys, projector, clock } = await setup(t, { projector: { ignore: true } });
  const device = await createDevice(gladys);
  const ack = await press(gladys, device, 'power_on');
  assert.equal(ack.success, false);
  assert.match(ack.error, /^Sent; Living room shows "Standby": not applied yet$/);
  // The read back equal to the state before is never a success.
  projector.state.ignore = false;
  projector.state.power = '1';
  const before = projector.lines.length;
  await clock.advance(FAST.followUps[0]);
  await waitFor(() => state(gladys, 'status') === 'On', 'the follow-up reading');
  assert.ok(projector.lines.length > before);
});

test('input: listed codes only, decided on the input read before, confirmed', async (t) => {
  const { gladys, projector } = await setup(t, { projector: { power: '1' } });
  const device = await createDevice(gladys);
  assert.deepEqual(await press(gladys, device, 'input', '32'), { success: true });
  assert.deepEqual(projector.commands(), ['%1INPT 32']);
  assert.equal(state(gladys, 'input'), '32');
  // Already there: nothing sent.
  assert.deepEqual(await press(gladys, device, 'input', '32'), { success: true });
  for (const bad of ['99', '3\r1', '31 ', 'HDMI', 31]) {
    const ack = await press(gladys, device, 'input', bad);
    assert.equal(ack.success, false, String(bad));
    assert.match(ack.error, /nothing sent/);
  }
  assert.deepEqual(projector.commands(), ['%1INPT 32']);
});

test('input or A/V mute while in standby: nothing sent', async (t) => {
  const { gladys, projector } = await setup(t);
  const device = await createDevice(gladys);
  for (const [key, value] of [
    ['input', '32'],
    ['av_mute', 1],
  ]) {
    const ack = await press(gladys, device, key, value);
    assert.match(ack.error, /not on \(standby\), nothing sent/);
  }
  assert.deepEqual(projector.commands(), []);
});

test('A/V mute is a press: the explicit opposite of the state read before', async (t) => {
  const { gladys, projector } = await setup(t, { projector: { power: '1', mute: '30' } });
  const device = await createDevice(gladys);
  await press(gladys, device, 'av_mute', 1);
  assert.equal(state(gladys, 'av_mute'), 1);
  // Video only muted (11) counts as muted: unmuted entirely.
  projector.state.mute = '11';
  await press(gladys, device, 'av_mute', 1);
  assert.deepEqual(projector.commands(), ['%1AVMT 31', '%1AVMT 30']);
  assert.equal(state(gladys, 'av_mute'), 0);
});

test('a command refused (ERR) says so: sent, refused', async (t) => {
  const { gladys, projector } = await setup(t, {
    projector: { power: '1', refuseSet: { INPT: 'ERR3' } },
  });
  const device = await createDevice(gladys);
  const ack = await press(gladys, device, 'input', '32');
  assert.equal(ack.error, 'Refused by Living room (ERR3): not available now or on this model');
  assert.deepEqual(projector.commands(), ['%1INPT 32']);
});

test('an unreachable projector: "nothing sent", the status says unreachable', async (t) => {
  const { gladys, projector, app } = await setup(t, { projector: { power: '1' } });
  const device = await createDevice(gladys);
  await waitFor(() => state(gladys, 'power') === 1, 'the power');
  await projector.close();
  await sleep(50);
  const ack = await press(gladys, device, 'power_on');
  assert.match(ack.error, /does not answer .*nothing sent/);
  app.lastAttempt.delete(PID);
  await app.readState(app.data.projectors[PID]);
  assert.equal(state(gladys, 'status'), 'Unreachable');
  // Unreachable is not a measure: the power is not set to 0 by it.
  assert.equal(state(gladys, 'power'), 1);
  await app.updateStatus();
  assert.match(gladys.fake.connectionStatus.message.en, /Unreachable .*Living room/);
});

test('a silent projector: the command is "sent, without confirmation", never a success', async (t) => {
  const { gladys, projector } = await setup(t);
  const device = await createDevice(gladys);
  projector.state.silent.add('POWR');
  const ack = await press(gladys, device, 'power_on');
  // POWR ? not answered before the send: nothing sent.
  assert.match(ack.error, /Power state not read in time, nothing sent/);
  assert.deepEqual(projector.commands(), []);
});

test('the ack is given within the budget whatever the projector does', async (t) => {
  const { gladys, projector } = await setup(t, { projector: { power: '1' } });
  const device = await createDevice(gladys);
  projector.latencyMs = 250;
  const started = Date.now();
  const acks = await Promise.all([
    press(gladys, device, 'input', '32'),
    press(gladys, device, 'input', '11'),
    press(gladys, device, 'av_mute'),
  ]);
  assert.ok(Date.now() - started < FAST.commandBudget + 400, `${Date.now() - started} ms`);
  for (const ack of acks.filter((a) => !a.success)) {
    assert.match(ack.error, /nothing sent|^Sent/);
  }
});

test('another serial number at the address: nothing published, nothing commanded', async (t) => {
  const { gladys, projector, app } = await setup(t, { projector: { power: '1' } });
  const device = await createDevice(gladys);
  projector.state.serial = 'OTHER99';
  await dropConnection(app, projector);
  const ack = await press(gladys, device, 'input', '32');
  assert.match(ack.error, /another projector answers at its address, nothing sent/);
  assert.deepEqual(projector.commands(), []);
  assert.equal(app.data.projectors[PID].host, '');
  assert.equal(state(gladys, 'status'), 'Another projector at this address');
});

test('a serial number unreadable is not another projector: refused, address kept', async (t) => {
  const { gladys, projector, app } = await setup(t, { projector: { power: '1' } });
  const device = await createDevice(gladys);
  projector.state.refuse.SNUM = 'ERR4';
  await dropConnection(app, projector);
  const ack = await press(gladys, device, 'input', '32');
  assert.match(ack.error, /identity not confirmed .*nothing sent/);
  assert.deepEqual(projector.commands(), []);
  assert.equal(app.data.projectors[PID].host, '127.0.0.1');
  assert.equal(state(gladys, 'status'), 'Identity not confirmed');
});

test('an address-keyed projector answering another model: never written over', async (t) => {
  const { gladys, projector, app } = await setup(t, { projector: { cls: 1, serial: undefined } });
  const pid = addressId({ host: '127.0.0.1', port: projector.port });
  const device = await createDevice(gladys, pid);
  projector.state.model = 'OTHER';
  await dropConnection(app, projector);
  const ack = await press(gladys, device, 'power_on');
  assert.match(ack.error, /another projector answers at its address, nothing sent/);
  await app.scan();
  assert.equal(app.data.projectors[pid].model, 'EB-W49');
});

test('one connection at a time per projector, never pipelined', async (t) => {
  const { gladys, projector, app } = await setup(t, { projector: { power: '1', latencyMs: 30 } });
  const device = await createDevice(gladys);
  app.lastAttempt.clear();
  await Promise.all([
    app.readState(app.data.projectors[PID]),
    press(gladys, device, 'av_mute'),
    press(gladys, device, 'input', '32'),
  ]);
  assert.equal(projector.peak, 1);
  assert.equal(projector.refused, 0);
  // Every chunk the projector read holds one command.
  assert.ok(projector.received.every((r) => r.data.toString('latin1').split('\r').length === 2));
});

test('a reading crossing a command is not published over its read back', async (t) => {
  const { gladys, app } = await setup(t, { projector: { power: '0', latencyMs: 20 } });
  const device = await createDevice(gladys);
  app.lastAttempt.clear();
  const reading = app.readState(app.data.projectors[PID]);
  await sleep(5);
  assert.deepEqual(await press(gladys, device, 'power_on'), { success: true });
  assert.equal(await reading, undefined);
  assert.equal(state(gladys, 'status'), 'On');
});

test('an oversized answer is cut before its end arrives', async (t) => {
  const { gladys, projector, app } = await setup(t, { projector: { power: '1' } });
  await createDevice(gladys);
  projector.state.name = 'x'.repeat(5_000);
  await dropConnection(app, projector);
  await assert.rejects(app.identify({ host: '127.0.0.1', port: projector.port }), /too long/);
});

test('a scene on 5 slow projectors sets them all; one failing stops no other', async (t) => {
  const fakes = [];
  for (let i = 0; i < 5; i += 1) {
    const fake = await fakeProjector({
      power: '1',
      serial: `SN000${i}`,
      name: `P${i}`,
      latencyMs: 60,
    });
    fakes.push(fake);
    t.after(() => fake.close());
  }
  const broken = await fakeProjector({ power: '1', serial: 'SN0009', refuse: { INPT: 'ERR4' } });
  t.after(() => broken.close());
  const { gladys } = await setup(t, {
    projector: false,
    config: { addresses: [...fakes, broken].map((f) => f.address).join(',') },
  });
  const devices = [];
  for (const pid of [...fakes.map((_, i) => `sn-SN000${i}`), 'sn-SN0009']) {
    devices.push(await createDevice(gladys, pid));
  }
  const acks = await Promise.all(devices.map((d) => press(gladys, d, 'input', '32')));
  assert.deepEqual(acks.slice(0, 5), Array(5).fill({ success: true }));
  assert.equal(acks[5].success, false);
  for (const fake of fakes) {
    assert.deepEqual(fake.commands(), ['%1INPT 32']);
  }
});

test('a deleted device is forgotten, found again by the next Scan', async (t) => {
  const { gladys, app } = await setup(t);
  const device = await createDevice(gladys);
  await gladys.fake.deviceDeleted(device);
  assert.equal(app.data.projectors[PID], undefined);
  app.probes.clear();
  await gladys.fake.scanRequest();
  assert.ok(discovered(gladys));
});

test('the device created gets the inputs the core kept, after a /data reset', async (t) => {
  const store = new MemoryStore();
  const { gladys, app } = await setup(t, { store, projector: { inputs: ['31'] } });
  gladys.devices.push({
    external_id: id(),
    features: [
      {
        external_id: id('input'),
        supported_options: [
          { value: '3A', label: 'HDMI 3' },
          { value: 'bad\r', label: 'x' },
        ],
      },
    ],
  });
  await app.publishDevices();
  const input = discovered(gladys).features.find((f) => f.external_id === id('input'));
  assert.deepEqual(input.supported_options, [
    { value: '31', label: 'HDMI 1' },
    { value: '3A', label: 'HDMI 3' },
  ]);
});
