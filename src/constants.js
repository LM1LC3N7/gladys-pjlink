// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions), limits and timings.
// Every key here is stored by Gladys or by its users: never rename one.
// -----------------------------------------------------------------------------

/** `gladys.externalIds(DEVICE_TYPE, <projector id>)`. */
export const DEVICE_TYPE = 'pjlink';

export const FEATURES = Object.freeze({
  POWER: 'power',
  POWER_ON: 'power_on',
  STANDBY: 'standby',
  STATUS: 'status',
  INPUT: 'input',
  AV_MUTE: 'av_mute',
  LAMP_HOURS: 'lamp_hours',
  ERRORS: 'errors',
});

export const ACTIONS = Object.freeze({
  CHECK: 'check_projectors',
});

/** Seconds. 30 s at least: 10 projectors x 8 states stay far under 300 states a minute. */
export const POLL_INTERVAL = Object.freeze({ min: 30, max: 600, default: 60 });

export const TIMINGS = Object.freeze({
  /** TCP connection and greeting. */
  connectTimeout: 2_000,
  /** One command (pypjlink2 waits 10 s; a PJLink answer is immediate). */
  requestTimeout: 2_000,
  /** A session unused this long is closed (a projector accepts one connection). */
  idleClose: 3_000,
  /** A standby cuts the command in flight when nothing came for this long. */
  frozenCut: 1_000,
  /** A whole reading (connection and up to 8 commands). */
  readBudget: 8_000,
  /** A whole identification (Scan, up to 30 commands). */
  identifyBudget: 15_000,
  /**
   * Gladys waits 5 s for the ack of a command: the whole command (turn,
   * reads, send and read back) gets `commandBudget`, a send needs at least
   * `minSendTime` of it left.
   */
  commandBudget: 3_500,
  minSendTime: 300,
  /** A standby is answered within this, retried every `standbyRetry` until then. */
  standbyBudget: 3_200,
  standbyRetry: 250,
  /** After a command not confirmed yet: read again this much later. */
  followUps: Object.freeze([5_000, 20_000]),
  /** A standby not confirmed is kept (in /data) this long, sent again 3 times at most. */
  standbyKeep: 2 * 60_000,
  /** While a standby is kept: its own power reading this often (any refresh interval). */
  standbyWatch: 12_000,
  standbySends: 3,
  /** A typed address where nothing answered is asked again after this. */
  probeRetry: 60_000,
  /** getConfig() failed: tried again after this, doubled up to `configRetryMax`. */
  configRetry: 5_000,
  configRetryMax: 60_000,
  /** Writes to /data are grouped. */
  persistDelay: 500,
  /** A timer may fire this much early (Node): still on time. */
  timerSlack: 20,
});

export const LIMITS = Object.freeze({
  projectors: 10,
  addresses: 10,
  inputs: 20,
  name: 64,
  /** States published a minute, all projectors (Gladys accepts 300). */
  statesPerMinute: 280,
});
