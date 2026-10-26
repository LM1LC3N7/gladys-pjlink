// -----------------------------------------------------------------------------
// Known projectors -> Gladys devices and states (pure). One Gladys device per
// projector, keyed by its id (`sn-<serial>` for a class 2 projector that
// gives its serial number, else `ip-<address>`): see TODO.md "Decisions".
//
// Categories and types of the Gladys core only: the power state read only
// (`unknown/binary`) and two `button/push` ("Power on", "Standby"), never a
// switch an "everything off" could reach; `text/text` for the status and
// the errors, `text/select` for the input, `television/volume-mute` for the
// A/V mute press, `duration/integer` in hours for the lamp.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, FEATURES, LIMITS } from './constants.js';
import { ERROR_ITEMS, inputLabel, parseInput } from './pjlink/protocol.js';

export const LABELS = Object.freeze({
  unreachable: 'Unreachable',
  identity: 'Identity not confirmed',
  moved: 'Another projector at this address',
  noErrors: 'OK',
});

/** The feature definitions, by frozen key, in their frozen order. */
export const FEATURE_SPECS = Object.freeze({
  [FEATURES.POWER]: {
    name: 'Power',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    keep_history: true,
  },
  [FEATURES.POWER_ON]: {
    name: 'Power on',
    category: C.BUTTON,
    type: T.BUTTON.PUSH,
    min: 0,
    max: 1,
  },
  [FEATURES.STANDBY]: { name: 'Standby', category: C.BUTTON, type: T.BUTTON.PUSH, min: 0, max: 1 },
  [FEATURES.STATUS]: {
    name: 'Status',
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
  },
  [FEATURES.INPUT]: {
    name: 'Input',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
  },
  [FEATURES.AV_MUTE]: {
    name: 'A/V mute',
    category: C.TELEVISION,
    type: T.TELEVISION.VOLUME_MUTE,
    min: 0,
    max: 1,
    has_feedback: true,
  },
  [FEATURES.LAMP_HOURS]: {
    name: 'Lamp hours',
    category: C.DURATION,
    type: T.DURATION.INTEGER,
    unit: U.HOURS,
    min: 0,
    max: 99_999,
    read_only: true,
  },
  [FEATURES.ERRORS]: {
    name: 'Errors',
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
  },
});

/** Options of the input dropdown: `{ value, label }` with string labels only. */
export function inputOptions(projector) {
  return (projector.inputs ?? []).slice(0, LIMITS.inputs).map(({ code, name }) => ({
    value: code,
    label: inputLabel(code, name),
  }));
}

export function projectorName(projector) {
  if (projector.name) {
    return projector.name;
  }
  const model = [projector.maker, projector.model].filter(Boolean).join(' ');
  return model || `PJLink projector ${projector.host || projector.id}`;
}

export function buildDevice(gladys, projector) {
  const ids = gladys.externalIds(DEVICE_TYPE, projector.id);
  return {
    name: projectorName(projector),
    external_id: ids.device,
    should_poll: false,
    params: [{ name: 'IP_ADDRESS', value: projector.host || '' }],
    // Always the full, fixed list: a device published again never loses a feature.
    features: Object.entries(FEATURE_SPECS).map(([key, { name, ...spec }]) => ({
      name,
      external_id: ids.feature(key),
      read_only: false,
      has_feedback: false,
      keep_history: false,
      ...spec,
      ...(key === FEATURES.INPUT ? { supported_options: inputOptions(projector) } : {}),
    })),
  };
}

/** The feature key of a feature external id of `device`, or undefined. */
export function featureKey(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId ?? '').startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : undefined;
}

/** `Lamp: warning, Filter: error`, or `OK`. */
export function errorsText(errors) {
  const items = ERROR_ITEMS.filter((item) => errors[item] !== 'ok').map(
    (item) => `${item[0].toUpperCase()}${item.slice(1)}: ${errors[item]}`,
  );
  return items.length === 0 ? LABELS.noErrors : items.join(', ');
}

/**
 * The states of a reading:
 *   undefined                       nothing known: nothing published
 *   { reachable: false }            no connection: the status only
 *   { identity: 'unconfirmed' | 'moved' }   the status only
 *   { reachable: true, power, input?, muted?, lampHours?, errors? }
 * Only the values actually read are published.
 */
export function stateList(gladys, projector, reading) {
  if (!reading) {
    return [];
  }
  const id = (key) => gladys.externalIds(DEVICE_TYPE, projector.id).feature(key);
  const status = (text) => [{ device_feature_external_id: id(FEATURES.STATUS), text }];
  if (reading.identity === 'moved') {
    return status(LABELS.moved);
  }
  if (reading.identity === 'unconfirmed') {
    return status(LABELS.identity);
  }
  if (reading.reachable === false) {
    return status(LABELS.unreachable);
  }
  const states = [];
  if (reading.power) {
    states.push({
      device_feature_external_id: id(FEATURES.POWER),
      state: reading.power.on ? 1 : 0,
    });
    states.push({ device_feature_external_id: id(FEATURES.STATUS), text: reading.power.label });
  }
  const input = parseInput(reading.input);
  if (input && inputOptions(projector).some((o) => o.value === input)) {
    states.push({ device_feature_external_id: id(FEATURES.INPUT), text: input });
  }
  if (typeof reading.muted === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.AV_MUTE), state: reading.muted ? 1 : 0 });
  }
  if (Number.isInteger(reading.lampHours)) {
    states.push({ device_feature_external_id: id(FEATURES.LAMP_HOURS), state: reading.lampHours });
  }
  if (reading.errors) {
    states.push({
      device_feature_external_id: id(FEATURES.ERRORS),
      text: errorsText(reading.errors),
    });
  }
  return states;
}
