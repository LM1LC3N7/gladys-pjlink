// -----------------------------------------------------------------------------
// The PJLink lines and values (pure): exact shapes only, bounded, linear.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressKey, normalizeConfig, parseAddress } from '../src/config.js';
import {
  commandLine,
  digest,
  inputLabel,
  isValidPassword,
  parseAnswer,
  parseClass,
  parseErrors,
  parseGreeting,
  parseInput,
  parseInputList,
  parseLampHours,
  parseMute,
  parsePower,
  parseSerial,
} from '../src/pjlink/protocol.js';

test('the greeting', () => {
  assert.deepEqual(parseGreeting('PJLINK 0'), { auth: false });
  assert.deepEqual(parseGreeting('PJLINK 1 498e4a67'), { auth: true, random: '498e4a67' });
  assert.deepEqual(parseGreeting('PJLINK ERRA'), { error: 'ERRA' });
  for (const bad of ['PJLINK 1', 'PJLINK 1 498e4a6', 'PJLINK 2', 'HTTP/1.1 200', '', undefined]) {
    assert.equal(parseGreeting(bad), undefined, String(bad));
  }
});

test('the digest of the specification example', () => {
  // PJLink specification: random 498e4a67, password JBMIAProjectorLink.
  assert.equal(digest('498e4a67', 'JBMIAProjectorLink'), '5d8409bc1c3fa39749434aa3a5c38682');
});

test('command lines: never a CR, LF nor control character', () => {
  assert.equal(commandLine(1, 'POWR', '?'), '%1POWR ?');
  assert.equal(commandLine(2, 'INNM', '?31'), '%2INNM ?31');
  for (const [cls, body, param] of [
    [3, 'POWR', '1'],
    [1, 'POW', '1'],
    [1, 'powr', '1'],
    [1, 'POWR', '1\r%1POWR 0'],
    [1, 'POWR', '\n'],
    [1, 'POWR', ''],
    [1, 'POWR', 'x'.repeat(129)],
  ]) {
    assert.throws(() => commandLine(cls, body, param), /Invalid/, JSON.stringify(param));
  }
});

test('answers', () => {
  assert.deepEqual(parseAnswer('%1POWR=1'), { cls: 1, body: 'POWR', value: '1' });
  assert.deepEqual(parseAnswer('%1powr=OK'), { cls: 1, body: 'POWR', value: 'OK' });
  assert.deepEqual(parseAnswer('%1INPT=ERR3'), {
    cls: 1,
    body: 'INPT',
    value: 'ERR3',
    error: 'ERR3',
  });
  assert.deepEqual(parseAnswer('PJLINK ERRA'), { authError: true });
  assert.deepEqual(parseAnswer('%1POWR=ERRA'), { authError: true });
  for (const bad of [
    '%3POWR=1',
    '%1POWR 1',
    'POWR=1',
    '%1POWR=\x01',
    `%1NAME=${'x'.repeat(300)}`,
  ]) {
    assert.equal(parseAnswer(bad), undefined, bad.slice(0, 20));
  }
});

test('values', () => {
  assert.deepEqual(
    ['0', '1', '2', '3', '4', '', '01'].map((v) => parsePower(v)?.label),
    ['Standby', 'On', 'Cooling down', 'Warming up', undefined, undefined, undefined],
  );
  assert.equal(parsePower('constructor'), undefined);
  assert.equal(parseInput('31'), '31');
  assert.equal(parseInput('3a'), '3A');
  assert.equal(parseInput('70'), undefined);
  assert.equal(parseInput('30'), undefined);
  assert.deepEqual(parseInputList('11 31 32 31'), ['11', '31', '32']);
  assert.equal(parseInputList('11 3'), undefined);
  assert.equal(parseInputList('11  31').length, 2);
  assert.equal(inputLabel('3A'), 'Digital A');
  assert.equal(inputLabel('31', ' HDMI 1 '), 'HDMI 1');
  assert.deepEqual(['30', '31', '11', '21', '10', '41', '3'].map(parseMute), [
    false,
    true,
    true,
    true,
    false,
    undefined,
    undefined,
  ]);
  assert.deepEqual(parseErrors('012000'), {
    fan: 'ok',
    lamp: 'warning',
    temperature: 'error',
    cover: 'ok',
    filter: 'ok',
    other: 'ok',
  });
  assert.equal(parseErrors('0120003'), undefined);
  assert.equal(parseErrors('01200x'), undefined);
  assert.equal(parseLampHours('1234 1'), 1234);
  assert.equal(parseLampHours('0 0 99999 1'), 0);
  for (const bad of ['', '1234', '1234 2', '-1 1', '1.5 1', '123456 1', '1 1 2']) {
    assert.equal(parseLampHours(bad), undefined, bad);
  }
  assert.equal(parseClass('1'), 1);
  assert.equal(parseClass('2'), 2);
  assert.equal(parseClass(''), undefined);
  assert.equal(parseSerial(' ab-12 34 '), 'AB1234');
  assert.equal(parseSerial('abc'), undefined);
  assert.equal(parseSerial('x'.repeat(33)), undefined);
});

test('passwords PJLink can send', () => {
  assert.ok(isValidPassword('JBMIAProjectorLink'));
  assert.ok(isValidPassword('a b'));
  for (const bad of ['', ' a', 'é', 'a\r', 'x'.repeat(33)]) {
    assert.equal(isValidPassword(bad), false, JSON.stringify(bad));
  }
});

test('addresses typed in the configuration', () => {
  assert.deepEqual(parseAddress('192.168.1.60'), { host: '192.168.1.60', port: 4352 });
  assert.deepEqual(parseAddress('http://Proj.lan:4353/x'), { host: 'proj.lan', port: 4353 });
  for (const bad of [
    '0.0.0.0',
    '192.168.1.255',
    '224.0.0.1',
    '255.255.255.255',
    '1.2.3',
    'a..b',
    'x:0',
    'x:70000',
    'a b',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  const config = normalizeConfig({
    addresses: '192.168.1.60, bad\x07host ;192.168.1.60',
    poll_interval: '5',
    password: ' pw ',
  });
  assert.deepEqual(config.addresses.map(addressKey), ['192.168.1.60:4352']);
  assert.deepEqual(config.invalid, ['bad?host']);
  assert.equal(config.pollInterval, 30);
  assert.equal(config.password, 'pw');
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 60);
  assert.equal(normalizeConfig({ password: 'é' }).passwordInvalid, true);
});
