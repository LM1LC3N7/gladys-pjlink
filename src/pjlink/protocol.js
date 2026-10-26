// -----------------------------------------------------------------------------
// PJLink class 1 and class 2 (pure): the greeting of the projector, the MD5
// authentication, the command lines and the answers, and the values of the
// commands the integration uses. Written from the public PJLink
// specification (JBMIA), cross-checked with pypjlink2 1.2.2 (benoitlouy,
// Apache-2.0, see THIRD_PARTY_NOTICES.md): `protocol.py` (line format, ERR
// codes) and `projector.py` (greeting, digest, POWR / INPT / AVMT / ERST /
// LAMP / INST values).
//
// Hostile input: every parser is linear, takes bounded strings and accepts
// only the exact shapes below; anything else is `undefined`.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

export const PJLINK_PORT = 4352;

/** A line of the projector is 256 bytes at most (the specification says 136). */
export const MAX_LINE = 256;

export const CR = 0x0d;

/** The answer codes of a refused command. */
export const ERRORS = Object.freeze({
  ERR1: 'undefined command',
  ERR2: 'out of parameter',
  ERR3: 'unavailable time',
  ERR4: 'projector failure',
});

/** A password the PJLink digest accepts: 1 to 32 printable ASCII characters. */
export const isValidPassword = (password) =>
  typeof password === 'string' && /^[\x21-\x7e](?:[\x20-\x7e]{0,30}[\x21-\x7e])?$/.test(password);

/**
 * The greeting the projector sends on connection:
 *   `PJLINK 0`           no authentication
 *   `PJLINK 1 <random>`  authentication, `random` 8 characters
 *   `PJLINK ERRA`        authentication error (some models, on connection)
 * @returns {{ auth: false } | { auth: true, random: string } | { error: 'ERRA' } | undefined}
 */
export function parseGreeting(line) {
  if (typeof line !== 'string' || line.length > 32) {
    return undefined;
  }
  if (/^PJLINK 0$/i.test(line)) {
    return { auth: false };
  }
  const auth = /^PJLINK 1 ([\x21-\x7e]{8})$/i.exec(line);
  if (auth) {
    return { auth: true, random: auth[1] };
  }
  if (/^PJLINK ERRA$/i.test(line)) {
    return { error: 'ERRA' };
  }
  return undefined;
}

/** The 32 lowercase hexadecimal characters sent before the first command. */
export function digest(random, password) {
  return createHash('md5').update(`${random}${password}`, 'latin1').digest('hex');
}

const BODY = /^[A-Z0-9]{4}$/;
const PARAM = /^[\x20-\x7e]{1,128}$/;

/**
 * `%<class><BODY> <param>` (without the CR). Throws on anything else: no CR,
 * LF nor control character can reach the projector.
 */
export function commandLine(cls, body, param) {
  if ((cls !== 1 && cls !== 2) || !BODY.test(body) || !PARAM.test(param)) {
    throw new TypeError('Invalid PJLink command');
  }
  return `%${cls}${body} ${param}`;
}

/**
 * One answer line (without the CR): `%<class><BODY>=<value>`.
 * @returns {{ cls: number, body: string, value: string, error?: string } | { authError: true } | undefined}
 */
export function parseAnswer(line) {
  if (typeof line !== 'string' || line.length > MAX_LINE) {
    return undefined;
  }
  if (/^PJLINK ERRA$/i.test(line)) {
    return { authError: true };
  }
  const match = /^%([12])([A-Za-z0-9]{4})=([^\x00-\x1f\x7f]{0,248})$/.exec(line);
  if (!match) {
    return undefined;
  }
  const value = match[3];
  const answer = { cls: Number(match[1]), body: match[2].toUpperCase(), value };
  if (Object.hasOwn(ERRORS, value.toUpperCase())) {
    answer.error = value.toUpperCase();
  } else if (value.toUpperCase() === 'ERRA') {
    return { authError: true };
  }
  return answer;
}

// --- Values --------------------------------------------------------------------

/** `POWR ?` answers. `on` is the power shown in Gladys. */
export const POWER_STATES = Object.freeze({
  0: { code: '0', label: 'Standby', on: false },
  1: { code: '1', label: 'On', on: true },
  2: { code: '2', label: 'Cooling down', on: false },
  3: { code: '3', label: 'Warming up', on: true },
});

export function parsePower(value) {
  return typeof value === 'string' && /^[0-3]$/.test(value) ? POWER_STATES[value] : undefined;
}

/** Off or going off: what a standby asks for. */
export const isStandbyState = (power) => power?.code === '0' || power?.code === '2';

/** Input types of `INPT`: the first character of the code. */
export const INPUT_TYPES = Object.freeze({
  1: 'RGB',
  2: 'Video',
  3: 'Digital',
  4: 'Storage',
  5: 'Network',
  6: 'Internal',
});

/**
 * An input code: class 1 `[1-5][1-9]`, class 2 also `6` and `A`-`Z` as
 * second character. Upper case, or undefined.
 */
export function parseInput(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const code = value.trim().toUpperCase();
  return /^[1-6][1-9A-Z]$/.test(code) ? code : undefined;
}

/** Whether `INPT <code>` needs the class 2 command. */
export const isClass2Input = (code) => !/^[1-5][1-9]$/.test(code);

/** The label of an input with no name: `Digital 1`, `Network A`. */
export function inputLabel(code, name) {
  if (typeof name === 'string' && name.trim() !== '') {
    return name.trim();
  }
  return `${INPUT_TYPES[code[0]] ?? 'Input'} ${code[1]}`;
}

/** `INST ?` -> the input codes (50 at most, no duplicates). */
export function parseInputList(value) {
  if (typeof value !== 'string' || value.length > 200) {
    return undefined;
  }
  const codes = [];
  for (const part of value.trim().split(' ')) {
    if (part === '') {
      continue;
    }
    const code = parseInput(part);
    if (!code || part.length !== 2) {
      return undefined;
    }
    if (!codes.includes(code)) {
      codes.push(code);
    }
  }
  return codes.slice(0, 50);
}

/**
 * `AVMT ?`: `11` video muted, `21` audio muted, `31` both, `30` (and the
 * class 2 `10`, `20`) none. Muted when any is.
 */
export function parseMute(value) {
  if (typeof value !== 'string' || !/^[123][01]$/.test(value)) {
    return undefined;
  }
  return value[1] === '1';
}

export const ERROR_ITEMS = Object.freeze([
  'fan',
  'lamp',
  'temperature',
  'cover',
  'filter',
  'other',
]);
const ERROR_LEVELS = Object.freeze({ 0: 'ok', 1: 'warning', 2: 'error' });

/** `ERST ?` -> { fan: 'ok' | 'warning' | 'error', ... }. */
export function parseErrors(value) {
  if (typeof value !== 'string' || !/^[0-2]{6}$/.test(value)) {
    return undefined;
  }
  return Object.fromEntries(ERROR_ITEMS.map((item, i) => [item, ERROR_LEVELS[value[i]]]));
}

/**
 * `LAMP ?` -> the hours of the first lamp. `<hours> <on>` pairs, 8 at most,
 * hours 0 to 99999 written with digits only.
 */
export function parseLampHours(value) {
  if (typeof value !== 'string' || value.length > 65) {
    return undefined;
  }
  const parts = value.split(' ');
  if (parts.length < 2 || parts.length > 16 || parts.length % 2 !== 0) {
    return undefined;
  }
  for (let i = 0; i < parts.length; i += 2) {
    if (!/^\d{1,5}$/.test(parts[i]) || !/^[01]$/.test(parts[i + 1])) {
      return undefined;
    }
  }
  return Number(parts[0]);
}

/** `CLSS ?` -> 1 or 2 (a later class is used as class 2). */
export function parseClass(value) {
  if (typeof value !== 'string' || !/^[1-9A-Z]$/i.test(value)) {
    return undefined;
  }
  return value === '1' ? 1 : 2;
}

/** A text of the projector (name, maker, model): control characters out, bounded. */
export function cleanText(value, max = 64) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
  return text === '' ? undefined : text.slice(0, max);
}

/**
 * `SNUM ?` (class 2) -> the serial number as an id part: letters and digits
 * only, upper case, 4 to 32 of them; anything else is undefined.
 */
export function parseSerial(value) {
  if (typeof value !== 'string' || value.length > 32) {
    return undefined;
  }
  const serial = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  // A placeholder (`0000000000`, `XXXX`) is no serial number: many models share it.
  return serial.length >= 4 && !/^(.)\1*$/.test(serial) ? serial : undefined;
}
