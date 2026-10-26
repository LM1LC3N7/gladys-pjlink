// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The password is
// kept here only, never logged, never written to /data nor in a message.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { LIMITS, POLL_INTERVAL } from './constants.js';
import { PJLINK_PORT, isValidPassword } from './pjlink/protocol.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  addresses: '',
  poll_interval: POLL_INTERVAL.default,
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * One address typed by the user: an IPv4 address or a host name, with an
 * optional port (4352 by default). A pasted URL is reduced to its host.
 * Never 0.0.0.0, a broadcast nor a multicast address.
 * @returns {{ host: string, port: number } | undefined} undefined when invalid.
 */
export function parseAddress(raw) {
  let text = String(raw ?? '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  let port = PJLINK_PORT;
  const withPort = /^(.+):(\d{1,5})$/.exec(text);
  if (withPort) {
    port = Number(withPort[2]);
    text = withPort[1];
    if (port < 1 || port > 65535) {
      return undefined;
    }
  }
  if (text === '' || text.length > 253) {
    return undefined;
  }
  if (isIP(text) === 4) {
    const [a, , , d] = text.split('.').map(Number);
    if (a === 0 || a >= 224 || d === 255) {
      return undefined;
    }
    return { host: text, port };
  }
  if (/^[\d.]+$/.test(text)) {
    return undefined;
  }
  return text.split('.').every((label) => LABEL.test(label)) ? { host: text, port } : undefined;
}

/** `host:port`, the key of an address. */
export const addressKey = ({ host, port }) => `${host}:${port}`;

const entries = (raw) =>
  String(raw ?? '')
    .split(/[\s,;]+/)
    .filter((entry) => entry !== '');

export function normalizeConfig(raw = {}) {
  const c = {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)),
  };
  const addresses = [];
  const invalid = [];
  for (const entry of entries(c.addresses)) {
    const address = parseAddress(entry);
    if (!address) {
      // Shown back cleaned and short: never a control character.
      invalid.push(entry.replace(/[^\x20-\x7e]/g, '?').slice(0, 40));
    } else if (
      !addresses.some((a) => addressKey(a) === addressKey(address)) &&
      addresses.length < LIMITS.addresses
    ) {
      addresses.push(address);
    }
  }
  // The password as typed (spaces around it are not part of it).
  const password = typeof c.password === 'string' ? c.password.trim() : '';
  const passwordValid = isValidPassword(password);
  const interval = Number(c.poll_interval);
  return {
    addresses,
    invalid,
    password: passwordValid ? password : '',
    /** A password was typed but cannot be sent (too long, not ASCII, control characters). */
    passwordInvalid: password !== '' && !passwordValid,
    pollInterval:
      typeof c.poll_interval !== 'string' || c.poll_interval.trim() !== ''
        ? Number.isFinite(interval)
          ? Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval)))
          : POLL_INTERVAL.default
        : POLL_INTERVAL.default,
  };
}
