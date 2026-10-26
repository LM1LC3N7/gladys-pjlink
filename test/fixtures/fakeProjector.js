// -----------------------------------------------------------------------------
// A fake PJLink projector on 127.0.0.1, on the TCP server of the test kit
// (one client at a time, like a real projector): the greeting (password
// optional, a new random each connection), the MD5 digest before the first
// command, ERRA and close on a wrong one, then the class 1 / class 2
// commands the integration uses, with the power cycle (warm-up, cool-down).
// `state` can be changed live; `lines` keeps every command received (the
// digest stripped), `digests` the digests received.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { tcpServer } from '../kit/tcp.mjs';

const md5 = (text) => createHash('md5').update(text, 'latin1').digest('hex');

export async function fakeProjector(options = {}) {
  const { latencyMs = 0, singleClient = true, port, ...overrides } = options;
  const state = {
    cls: 2,
    serial: 'SN0001',
    maker: 'EPSON',
    model: 'EB-W49',
    name: 'Living room',
    power: '0',
    input: '31',
    inputs: ['11', '31', '32'],
    inputNames: { 11: 'Computer', 31: 'HDMI 1', 32: 'HDMI 2' },
    mute: '30',
    lamp: '1234 1',
    errors: '000000',
    password: '',
    /** body -> 'ERR1'...: answered instead of the value. */
    refuse: {},
    /** body -> 'ERR3'...: answered to a command (not a question). */
    refuseSet: {},
    /** bodies never answered (the connection stays open). */
    silent: new Set(),
    /** POWR 1 goes to '3' (warming up) instead of '1' at once. */
    warmUp: false,
    /** POWR 0 goes to '2' (cooling down) instead of '0' at once. */
    coolDown: false,
    /** Commands answered OK but not applied. */
    ignore: false,
    ...overrides,
  };
  const lines = [];
  const digests = [];
  let authFailures = 0;

  const value = (cls, body, param) => {
    if (state.silent.has(body)) {
      return null;
    }
    const query = param === '?' || param.startsWith('?');
    if (state.refuse[body]) {
      return state.refuse[body];
    }
    if (!query && state.refuseSet[body]) {
      return state.refuseSet[body];
    }
    const on = state.power === '1';
    switch (body) {
      case 'POWR':
        if (query) {
          return state.power;
        }
        if (param === '1') {
          if (state.power === '2') return 'ERR3';
          if (!state.ignore && state.power === '0') state.power = state.warmUp ? '3' : '1';
          return 'OK';
        }
        if (param === '0') {
          if (state.power === '3') return 'ERR3';
          if (!state.ignore && state.power === '1') state.power = state.coolDown ? '2' : '0';
          return 'OK';
        }
        return 'ERR2';
      case 'INPT':
        if (!on) return 'ERR3';
        if (query) return state.input;
        if (!state.inputs.includes(param)) return 'ERR2';
        if (cls === 1 && !/^[1-5][1-9]$/.test(param)) return 'ERR2';
        if (!state.ignore) state.input = param;
        return 'OK';
      case 'AVMT':
        if (!on) return 'ERR3';
        if (query) return state.mute;
        if (!/^[123][01]$/.test(param)) return 'ERR2';
        if (!state.ignore) state.mute = param;
        return 'OK';
      case 'ERST':
        return state.errors;
      case 'LAMP':
        return state.lamp;
      case 'NAME':
        return state.name;
      case 'INF1':
        return state.maker;
      case 'INF2':
        return state.model;
      case 'CLSS':
        return String(state.cls);
      case 'SNUM':
        return cls === 2 && state.cls === 2 && state.serial ? state.serial : 'ERR1';
      case 'INST':
        return state.inputs.join(' ');
      case 'INNM': {
        if (cls !== 2 || state.cls !== 2) return 'ERR1';
        const name = state.inputNames[param.slice(1)];
        return name ?? 'ERR2';
      }
      default:
        return 'ERR1';
    }
  };

  const handle = (text, conn) => {
    const out = [];
    for (let raw of text.split('\r')) {
      if (raw === '') {
        continue;
      }
      if (state.password && !conn.authed) {
        const match = /^([0-9a-f]{32})(%.*)$/.exec(raw);
        if (match) {
          digests.push(match[1]);
        }
        if (!match || match[1] !== md5(`${conn.random}${state.password}`)) {
          authFailures += 1;
          setTimeout(() => conn.destroy(), 20);
          return 'PJLINK ERRA\r';
        }
        conn.authed = true;
        raw = match[2];
      }
      lines.push(raw);
      const match = /^%([12])([A-Z0-9]{4}) (.*)$/.exec(raw);
      if (!match) {
        out.push('%1ERR1=ERR1\r');
        continue;
      }
      const cls = Number(match[1]);
      const answer = value(cls, match[2], match[3]);
      if (answer === null) {
        continue;
      }
      out.push(typeof answer === 'string' ? `%${cls}${match[2]}=${answer}\r` : answer);
    }
    return out.length > 0 ? out.join('') : undefined;
  };

  const device = await tcpServer({
    port,
    singleClient,
    latencyMs,
    onConnect: (conn) => {
      if (state.greeting !== undefined) {
        return state.greeting;
      }
      conn.random = randomBytes(4).toString('hex');
      return state.password ? `PJLINK 1 ${conn.random}\r` : 'PJLINK 0\r';
    },
    onData: (chunk, conn) => handle(chunk.toString('latin1'), conn),
  });
  Object.defineProperty(device, 'authFailures', { get: () => authFailures });
  return Object.assign(device, {
    state,
    lines,
    digests,
    /** The commands received (not the questions). */
    commands: () => lines.filter((l) => !/ \?/.test(l)),
    address: `127.0.0.1:${device.port}`,
  });
}
