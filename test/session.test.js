// -----------------------------------------------------------------------------
// One PJLink session and the client of an address, on the TCP server of the
// kit: bounded lines, a late answer never settles the next command, an
// answer out of step closes, the standby's turn.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectorClient } from '../src/pjlink/client.js';
import { ERROR_KINDS, Session } from '../src/pjlink/session.js';
import { tcpServer } from './kit/tcp.mjs';
import { fakeProjector } from './fixtures/fakeProjector.js';

const POWR = { cls: 1, body: 'POWR', param: '?' };

test('a line longer than 256 bytes is cut before its end arrives', async (t) => {
  const device = await tcpServer({ onConnect: () => 'PJLINK 0\r', onData: () => undefined });
  t.after(() => device.close());
  const session = await Session.open({ host: '127.0.0.1', port: device.port, timeoutMs: 500 });
  const answer = session.request(POWR, { timeoutMs: 2_000 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  device.push('%1POWR=' + 'x'.repeat(300));
  await assert.rejects(
    answer,
    (err) => err.kind === ERROR_KINDS.PROTOCOL && /too long/.test(err.message),
  );
  assert.equal(session.closed, true);
});

test('a greeting that is not PJLink, or too long, closes', async (t) => {
  for (const greeting of ['SSH-2.0-OpenSSH\r', 'x'.repeat(400)]) {
    const device = await tcpServer({ onConnect: () => greeting });
    t.after(() => device.close());
    await assert.rejects(
      Session.open({ host: '127.0.0.1', port: device.port, timeoutMs: 500 }),
      (err) => err.kind === ERROR_KINDS.PROTOCOL,
    );
  }
});

test('a command not answered in time closes: its late answer never settles the next', async (t) => {
  const fake = await fakeProjector({ latencyMs: 150, singleClient: false });
  t.after(() => fake.close());
  const session = await Session.open({ host: '127.0.0.1', port: fake.port, timeoutMs: 500 });
  await assert.rejects(
    session.request(POWR, { timeoutMs: 50 }),
    (err) => err.kind === ERROR_KINDS.TIMEOUT && err.sent,
  );
  assert.equal(session.closed, true);
  await assert.rejects(
    session.request(POWR, { timeoutMs: 500 }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE,
  );
});

test('an answer for another command closes the session', async (t) => {
  const device = await tcpServer({ onConnect: () => 'PJLINK 0\r', onData: () => '%1INPT=31\r' });
  t.after(() => device.close());
  const session = await Session.open({ host: '127.0.0.1', port: device.port, timeoutMs: 500 });
  await assert.rejects(
    session.request(POWR, { timeoutMs: 500 }),
    (err) => err.kind === ERROR_KINDS.PROTOCOL,
  );
  assert.equal(session.closed, true);
});

test('a password asked and none given: nothing sent', async (t) => {
  const fake = await fakeProjector({ password: 'pw' });
  t.after(() => fake.close());
  const session = await Session.open({ host: '127.0.0.1', port: fake.port, timeoutMs: 500 });
  await assert.rejects(
    session.request(POWR, { timeoutMs: 500 }),
    (err) => err.kind === ERROR_KINDS.AUTH_REQUIRED && !err.sent,
  );
  assert.equal(fake.received.length, 0);
  session.close();
});

test('the client: a standby waiting goes before the other commands waiting', async (t) => {
  const fake = await fakeProjector({ latencyMs: 40 });
  t.after(() => fake.close());
  const client = new ProjectorClient({ host: '127.0.0.1', port: fake.port });
  t.after(() => client.close());
  const deadline = performance.now() + 3_000;
  const order = [];
  const ask = (param, priority) =>
    client
      .request({ cls: 1, body: 'POWR', param }, { deadline, priority })
      .then(() => order.push(param));
  await Promise.all([ask('?'), ask('1'), ask('?'), ask('0', true)]);
  assert.deepEqual(order, ['?', '0', '1', '?']);
  assert.equal(fake.peak, 1);
});

test('the client: a waiter past its deadline gives up, nothing sent', async (t) => {
  const fake = await fakeProjector({ latencyMs: 200 });
  t.after(() => fake.close());
  const client = new ProjectorClient({ host: '127.0.0.1', port: fake.port });
  t.after(() => client.close());
  const first = client.request(POWR, { deadline: performance.now() + 2_000 });
  await assert.rejects(
    client.request({ cls: 1, body: 'POWR', param: '1' }, { deadline: performance.now() + 50 }),
    (err) => err.kind === ERROR_KINDS.BUDGET && !err.sent,
  );
  await first;
  assert.ok(!fake.lines.includes('%1POWR 1'));
});

test('the client: a command needing the identity is not sent on a connection not checked', async (t) => {
  const fake = await fakeProjector();
  t.after(() => fake.close());
  const client = new ProjectorClient({ host: '127.0.0.1', port: fake.port });
  t.after(() => client.close());
  await assert.rejects(
    client.request(
      { cls: 1, body: 'POWR', param: '1' },
      { deadline: performance.now() + 1_000, identity: true },
    ),
    (err) => err.kind === ERROR_KINDS.IDENTITY && !err.sent,
  );
  assert.deepEqual(fake.lines, []);
});

test('names: UTF-8 when valid, else Latin-1; C1 controls removed', async (t) => {
  const device = await tcpServer({
    onConnect: () => 'PJLINK 0\r',
    onData: (chunk) =>
      chunk.toString().includes('NAME')
        ? Buffer.concat([
            Buffer.from('%1NAME=Sal'),
            Buffer.from('ón\u0085', 'utf8'),
            Buffer.from('\r'),
          ])
        : Buffer.concat([Buffer.from('%1INF1=Sal'), Buffer.from([0xf3]), Buffer.from('n\r')]),
  });
  t.after(() => device.close());
  const session = await Session.open({ host: '127.0.0.1', port: device.port, timeoutMs: 500 });
  const { cleanText } = await import('../src/pjlink/protocol.js');
  assert.equal(
    cleanText(await session.request({ cls: 1, body: 'NAME', param: '?' }, { timeoutMs: 500 })),
    'Salón',
  );
  assert.equal(
    cleanText(await session.request({ cls: 1, body: 'INF1', param: '?' }, { timeoutMs: 500 })),
    'Salón',
  );
  session.close();
});

test('afterWrite: called once, after the write; never when the request is refused before', async (t) => {
  const fake = await fakeProjector({ latencyMs: 100, singleClient: false });
  t.after(() => fake.close());
  const session = await Session.open({ host: '127.0.0.1', port: fake.port, timeoutMs: 500 });
  const order = [];
  const write = session.socket.write.bind(session.socket);
  session.socket.write = (...args) => {
    order.push('write');
    return write(...args);
  };
  const first = session.request(POWR, { timeoutMs: 1_000, afterWrite: () => order.push('after') });
  // A command in progress: refused before anything is written.
  await assert.rejects(
    session.request(POWR, { timeoutMs: 1_000, afterWrite: () => order.push('busy') }),
    (err) => err.kind === ERROR_KINDS.PROTOCOL,
  );
  await first;
  assert.deepEqual(order, ['write', 'after']);
  session.close();
  await assert.rejects(
    session.request(POWR, { timeoutMs: 500, afterWrite: () => order.push('closed') }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE,
  );
  const locked = await fakeProjector({ password: 'pw' });
  t.after(() => locked.close());
  const guarded = await Session.open({ host: '127.0.0.1', port: locked.port, timeoutMs: 500 });
  await assert.rejects(
    guarded.request(POWR, { timeoutMs: 500, afterWrite: () => order.push('password') }),
    (err) => err.kind === ERROR_KINDS.AUTH_REQUIRED,
  );
  guarded.close();
  assert.deepEqual(order, ['write', 'after']);
});
