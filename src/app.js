// -----------------------------------------------------------------------------
// The integration: the PJLink projectors it knows (typed addresses, Scan),
// the Gladys devices built from them, the readings (power, input, A/V mute,
// lamp hours, errors), the commands (Power on, input, A/V mute: serialized
// per projector, decided on the state read just before, confirmed by a read
// back, within the 5 s Gladys gives a command), the Standby (the protective
// command: out of the queue, first in line, kept in /data and sent again
// until a reading shows it applied), the passwords missing or refused
// (persisted, never tried again by themselves) and the status.
// index.js only wires the SDK handlers to it.
//
// Clocks: `monotonic` paces the readings, the follow-ups and the age of a
// reading; `now` (wall) only dates what /data keeps across a restart. The
// network and the 5 s of Gladys are real time (`performance.now()`).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { markOf, newSalt } from './authmark.js';
import { addressKey, normalizeConfig } from './config.js';
import { DEVICE_TYPE, FEATURES, LIMITS, TIMINGS } from './constants.js';
import { T } from './i18n.js';
import { buildDevice, featureKey, inputOptions, projectorName, stateList } from './model.js';
import { ProjectorClient } from './pjlink/client.js';
import {
  PJLINK_PORT,
  cleanText,
  isClass2Input,
  isStandbyState,
  parseClass,
  parseErrors,
  parseInput,
  parseInputList,
  parseLampHours,
  parseMute,
  parsePower,
  parseSerial,
} from './pjlink/protocol.js';
import { ERROR_KINDS, ProjectorError } from './pjlink/session.js';
import { FileStore, emptyData, isProjectorId } from './store.js';

const AUTH_KINDS = new Set([ERROR_KINDS.AUTH_REQUIRED, ERROR_KINDS.AUTH_REFUSED]);
const COMMANDS = new Set([FEATURES.POWER_ON, FEATURES.INPUT, FEATURES.AV_MUTE]);
const short = (value) =>
  String(value)
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, 32);
const rt = () => performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** The id of a projector that gives no serial number: its address. */
export const addressId = ({ host, port }) =>
  `ip-${host.replace(/[^a-z0-9]/gi, '-').slice(0, 40)}${port === PJLINK_PORT ? '' : `-${port}`}`;

/** The error Gladys gets (logged only: Gladys does not show it). */
const fail = (kind, message, sent = false) => new ProjectorError(kind, message, { sent });

export class PjlinkApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'pjlink' }),
    store = new FileStore(),
    connect,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    timings = TIMINGS,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.connect = connect;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.timings = timings;
    this.config = normalizeConfig();
    /** Whether a configuration was read from Gladys in this run. */
    this.configured = false;
    this.data = undefined;
    this.loading = undefined;
    /** address key -> ProjectorClient (one connection per projector). */
    this.clients = new Map();
    /** id -> { at (monotonic), reachable, power, ... } */
    this.readings = new Map();
    /** id -> monotonic time of the last reading started. */
    this.lastAttempt = new Map();
    /** id -> number of standbys asked: what was queued before one never leaves after it. */
    this.stops = new Map();
    /** id -> number of commands sent: a reading crossing one is dropped. */
    this.sends = new Map();
    /** id -> promise of the last queued command. */
    this.queues = new Map();
    /** ids being read. */
    this.inFlight = new Set();
    /** id -> [timer handles] of the follow-up readings. */
    this.followUps = new Map();
    /** id -> timer handle of the dedicated power reading of a kept standby. */
    this.standbyWatches = new Map();
    /** address key -> { at (monotonic), kind? } of the last identification. */
    this.probes = new Map();
    /** ids of the devices created in Gladys. */
    this.created = new Set();
    /** monotonic times of the states published in the last minute. */
    this.published = [];
    this.backgroundTimers = new Set();
    this.generation = 0;
    this.pollTimer = undefined;
    this.persistTimer = undefined;
    this.saveFailed = false;
    this.configFailed = false;
    this.lastStatus = undefined;
    this.warned = new Set();
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Reads /data once. A saved time in the future is invalid. */
  load() {
    if (!this.loading) {
      this.loading = (async () => {
        try {
          this.data = await this.store.load();
        } catch {
          this.data = emptyData();
        }
        if (this.store.corrupted) {
          this.logger.warn('Unreadable /data/pjlink.json moved to pjlink.json.bad');
        }
        if (this.store.unavailable) {
          this.logger.warn('/data/pjlink.json cannot be read: kept as is, nothing written over it');
        }
        const now = this.now();
        const mono = this.monotonic();
        for (const p of this.projectors) {
          // An accepted standby is never sent again after a restart (the
          // projector may have been switched on since, unseen).
          if (p.standby && (p.standby.accepted || !this.standbyAlive(p, now))) {
            delete p.standby;
          }
          if (p.lastPollAt !== undefined) {
            // Never sooner than the interval after a restart; a future date counts as now.
            this.lastAttempt.set(p.id, mono - Math.max(0, now - p.lastPollAt));
          }
        }
      })();
    }
    return this.loading;
  }

  /**
   * At the start of the container, before Gladys is reached: the standbys
   * kept in /data leave at once, without the configuration nor a reading
   * (a projector asking for a password gets them once it is read).
   */
  async boot() {
    await this.load();
    await this.flushStandbys({ boot: true });
  }

  /**
   * (Re)start with a configuration: on every connection to Gladys
   * (`connected`) and on every configuration save (`saved`). Never makes a
   * projector read sooner than the interval.
   */
  async start(raw = {}, { connected = false } = {}) {
    const generation = this.generation;
    await this.load();
    if (generation !== this.generation) {
      return;
    }
    const first = !this.configured;
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.configured = true;
    this.configFailed = false;
    this.started = true;
    this.liftChangedPasswords(previous, first);
    for (const [key, client] of this.clients) {
      if (!this.config.addresses.some((a) => addressKey(a) === key) && !this.projectorAt(key)) {
        client.close();
        this.clients.delete(key);
      }
    }
    if (connected) {
      // The status is said again; the states are not (nothing republished as new).
      this.lastStatus = undefined;
    }
    await this.flushStandbys();
    await this.step('read the Gladys devices', () => this.refreshCreated());
    await this.step('identify the addresses', () => this.probeAddresses());
    if (generation !== this.generation) {
      return;
    }
    await this.step('publish the devices', () => this.publishDevices());
    this.schedule();
    await this.step('publish the status', () => this.updateStatus());
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  stop() {
    this.started = false;
    this.generation += 1;
    this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    for (const handle of this.backgroundTimers) {
      this.timers.clearTimeout(handle);
    }
    this.backgroundTimers.clear();
    this.followUps.clear();
    this.standbyWatches.clear();
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    // Written at a clean stop (the readings' times, a standby kept).
    return this.data ? this.save() : Promise.resolve();
  }

  /** Background work, cancelled by stop(). */
  later(task, ms) {
    const generation = this.generation;
    const handle = this.timers.setTimeout(() => {
      this.backgroundTimers.delete(handle);
      if (generation === this.generation) {
        Promise.resolve()
          .then(task)
          .catch((err) => this.logger.debug?.(`Background task failed: ${err.message}`));
      }
    }, ms);
    this.backgroundTimers.add(handle);
    return handle;
  }

  /** A grouped write of /data (the queue of the store keeps them in order). */
  persist() {
    if (this.persistTimer || !this.data) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.save();
    }, this.timings.persistDelay);
  }

  save() {
    return this.store.save(this.data).then(
      () => {
        if (this.saveFailed) {
          this.saveFailed = false;
          this.updateStatus().catch(() => {});
        }
      },
      (err) => {
        if (!this.saveFailed) {
          this.saveFailed = true;
          this.logger.warn(`Could not save /data: ${err.message}`);
          this.updateStatus().catch(() => {});
        }
      },
    );
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  // --- Known projectors ---------------------------------------------------------

  get projectors() {
    return Object.values(this.data?.projectors ?? {});
  }

  projectorOf(device) {
    return this.projectors.find(
      (p) => this.gladys.externalIds(DEVICE_TYPE, p.id).device === device?.external_id,
    );
  }

  projectorAt(key) {
    return this.projectors.find((p) => p.host && addressKey(p) === key);
  }

  /** The client of an address (one connection per projector, whoever asks). */
  clientOf(address) {
    const key = addressKey(address);
    let client = this.clients.get(key);
    if (!client) {
      client = new ProjectorClient({
        host: address.host,
        port: address.port,
        connect: this.connect,
        connectTimeout: this.timings.connectTimeout,
        requestTimeout: this.timings.requestTimeout,
        idleClose: this.timings.idleClose,
        frozenCut: this.timings.frozenCut,
      });
      this.clients.set(key, client);
    }
    return client;
  }

  counter(map, id) {
    return map.get(id) ?? 0;
  }

  bump(map, id) {
    map.set(id, this.counter(map, id) + 1);
  }

  // --- Passwords (persisted per address, never tried again by themselves) -----------

  authBlock(address) {
    return this.data?.authBlocks?.[addressKey(address)];
  }

  isAuthBlocked(address) {
    return Boolean(this.authBlock(address));
  }

  /**
   * A password missing or refused at an address: kept with the 6-bit mark of
   * the password tried, nothing sent there by itself until the password is
   * changed or the "Check" button succeeds.
   */
  setAuthBlock(address, kind) {
    const key = addressKey(address);
    const previous = this.data.authBlocks[key];
    const salt = newSalt();
    this.data.authBlocks[key] = { kind, salt, mark: markOf(salt, this.config.password) };
    this.persist();
    if (previous?.kind !== kind) {
      this.logger.warn(
        `${key}: ${kind === ERROR_KINDS.AUTH_REQUIRED ? 'a password is required' : 'password refused'}; not tried again until the password is changed or "Check the projectors" is pressed`,
      );
      this.updateStatus().catch(() => {});
    }
  }

  clearAuthBlock(address) {
    const key = addressKey(address);
    if (this.data.authBlocks[key]) {
      delete this.data.authBlocks[key];
      this.persist();
      this.logger.info(`${key}: password accepted`);
      this.updateStatus().catch(() => {});
    }
  }

  /**
   * A new password lifts the blocks: compared as typed within this run, by
   * its mark after a restart (the same mark: the same password, most likely).
   */
  liftChangedPasswords(previous, first) {
    let changed = false;
    for (const [key, block] of Object.entries(this.data.authBlocks)) {
      const lift = first
        ? markOf(block.salt, this.config.password) !== block.mark
        : previous.password !== this.config.password;
      if (lift) {
        delete this.data.authBlocks[key];
        // Identified again at once with the new password.
        this.probes.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  /** A session error: a password problem becomes a block (never at boot, config unread). */
  noteSessionError(address, err) {
    if (AUTH_KINDS.has(err?.kind) && this.configured) {
      this.setAuthBlock(address, err.kind);
    }
  }

  // --- Identification -------------------------------------------------------------

  async refreshCreated() {
    let list;
    try {
      list = await this.gladys.getDevices();
    } catch (err) {
      if (!Array.isArray(this.gladys.devices)) {
        throw err;
      }
      list = this.gladys.devices;
    }
    const byExternalId = new Map(
      this.projectors.map((p) => [this.gladys.externalIds(DEVICE_TYPE, p.id).device, p.id]),
    );
    this.created = new Set(
      (Array.isArray(list) ? list : [])
        .map((d) => byExternalId.get(d?.external_id))
        .filter(Boolean),
    );
  }

  /**
   * Asks the projector at `address` who it is: class, serial number (class
   * 2), maker, model, name, inputs (and their names, class 2). Throws a
   * ProjectorError. `checkAuth`: one try even if the password is blocked.
   */
  async identify(address, { checkAuth = false } = {}) {
    if (this.isAuthBlocked(address) && !checkAuth) {
      throw fail(this.authBlock(address).kind, 'Password problem, not tried again');
    }
    this.probes.set(addressKey(address), { at: this.monotonic() });
    const client = this.clientOf(address);
    const deadline = rt() + this.timings.identifyBudget;
    const password = this.config.password;
    const ask = async (cls, body, param = '?') => {
      try {
        return await client.request({ cls, body, param }, { deadline, password });
      } catch (err) {
        if (err.kind === ERROR_KINDS.REFUSED) {
          return undefined;
        }
        throw err;
      }
    };
    let info;
    try {
      const cls = parseClass(await ask(1, 'CLSS')) ?? 1;
      info = { cls };
      if (cls === 2) {
        info.serial = parseSerial(await ask(2, 'SNUM'));
      }
      info.maker = cleanText(await ask(1, 'INF1'), 32);
      info.model = cleanText(await ask(1, 'INF2'), 32);
      info.name = cleanText(await ask(1, 'NAME'), LIMITS.name);
      const codes = (parseInputList(await ask(cls, 'INST')) ?? []).slice(0, LIMITS.inputs);
      info.inputs = [];
      for (const code of codes) {
        const name = cls === 2 ? cleanText(await ask(2, 'INNM', `?${code}`), 32) : undefined;
        info.inputs.push({ code, ...(name ? { name } : {}) });
      }
    } catch (err) {
      this.noteSessionError(address, err);
      this.probes.set(addressKey(address), { at: this.monotonic(), kind: err.kind });
      throw err;
    }
    this.clearAuthBlock(address);
    this.probes.set(addressKey(address), { at: this.monotonic() });
    return this.remember(address, info);
  }

  /**
   * Keeps what was identified. Ids are frozen: a serial number read moves its
   * projector to the address (DHCP); a projector that answers no serial at
   * the address of one keyed by its serial is not another one (unreadable,
   * nothing changed); an address-keyed projector whose maker or model no
   * longer matches is never written over.
   */
  remember(address, info) {
    const projectors = this.data.projectors;
    const key = addressKey(address);
    const atAddress = this.projectors.filter((p) => p.host && addressKey(p) === key);
    let id = info.serial ? `sn-${info.serial}` : addressId(address);
    if (!info.serial && atAddress.some((p) => p.serial)) {
      this.logger.warn(`${key}: no serial number answered, identity unreadable: nothing changed`);
      return undefined;
    }
    const sameModel = (p) => p.maker === info.maker && p.model === info.model;
    if (info.serial && !projectors[id]) {
      // A projector known by its address only, same maker and model: its id stays.
      const byAddress = atAddress.find((p) => !p.serial && sameModel(p));
      if (byAddress) {
        id = byAddress.id;
      }
    }
    if (!isProjectorId(id)) {
      return undefined;
    }
    let projector = projectors[id];
    if (
      projector &&
      !projector.serial &&
      (projector.maker || projector.model) &&
      !sameModel(projector)
    ) {
      this.warnOnce(
        `other:${id}`,
        `${key}: another projector model answers (${info.maker ?? '?'} ${info.model ?? '?'}): not written over`,
      );
      return undefined;
    }
    if (!projector) {
      if (Object.keys(projectors).length >= LIMITS.projectors) {
        this.warnOnce(
          'projectors',
          `More than ${LIMITS.projectors} projectors: the next ones are ignored`,
        );
        return undefined;
      }
      projector = { id, host: '', port: PJLINK_PORT, name: '', cls: 1, inputs: [] };
      projectors[id] = projector;
    }
    // A projector keyed by another serial number lost this address (DHCP).
    for (const other of atAddress) {
      if (other.id !== id && other.serial && info.serial && other.serial !== info.serial) {
        this.logger.warn(`${projectorName(other)} no longer answers at ${key}`);
        other.host = '';
        this.readings.set(other.id, { at: this.monotonic(), identity: 'moved' });
      }
    }
    if (projector.host && addressKey(projector) !== key) {
      this.logger.warn(
        `${projectorName(projector)}: serial number ${info.serial ?? '?'} now at ${key} (was ${addressKey(projector)}): moved, or two projectors give the same serial number`,
      );
    }
    Object.assign(projector, {
      host: address.host,
      port: address.port,
      cls: info.cls,
      maker: info.maker,
      model: info.model,
    });
    if (info.serial && projector.id === `sn-${info.serial}`) {
      projector.serial = info.serial;
    }
    if (info.name) {
      projector.name = info.name;
    }
    if (info.inputs.length > 0) {
      projector.inputs = info.inputs;
    }
    this.persist();
    return projector;
  }

  /** Typed addresses with no known projector: at start, then every `probeRetry`. */
  async probeAddresses() {
    let changed = false;
    await Promise.all(
      this.config.addresses.map(async (address) => {
        const key = addressKey(address);
        if (this.projectorAt(key) || this.isAuthBlocked(address)) {
          return;
        }
        const last = this.probes.get(key)?.at;
        if (last !== undefined && this.monotonic() - last < this.timings.probeRetry) {
          return;
        }
        try {
          changed = Boolean(await this.identify(address)) || changed;
        } catch (err) {
          this.logger.debug?.(`${key}: ${err.message}`);
        }
      }),
    );
    if (changed) {
      await this.publishDevices();
    }
    return changed;
  }

  /**
   * Scan (Discovery tab): every typed address identified again, never
   * sooner than the interval (an address identified less than one interval
   * ago keeps what is known). Names and inputs change here only.
   */
  async scan() {
    const interval = this.config.pollInterval * 1000;
    await Promise.all(
      this.config.addresses.map(async (address) => {
        const last = this.probes.get(addressKey(address))?.at;
        if (last !== undefined && this.monotonic() - last < interval) {
          return;
        }
        try {
          await this.identify(address);
        } catch (err) {
          this.logger.debug?.(`${addressKey(address)}: ${err.message}`);
        }
      }),
    );
    await this.publishDevices();
    await this.updateStatus();
  }

  /** Input options of the created device, merged in: never lost after a /data reset. */
  mergeCreatedInputs(projector) {
    const externalId = this.gladys.externalIds(DEVICE_TYPE, projector.id).device;
    const created = (Array.isArray(this.gladys.devices) ? this.gladys.devices : []).find(
      (d) => d?.external_id === externalId,
    );
    const feature = (Array.isArray(created?.features) ? created.features : []).find(
      (f) => f?.external_id === `${externalId}:${FEATURES.INPUT}`,
    );
    for (const option of Array.isArray(feature?.supported_options)
      ? feature.supported_options
      : []) {
      const code = parseInput(option?.value);
      if (
        code &&
        option.value === code &&
        !projector.inputs.some((i) => i.code === code) &&
        projector.inputs.length < LIMITS.inputs
      ) {
        const name = cleanText(typeof option.label === 'string' ? option.label : undefined, 32);
        projector.inputs.push({ code, ...(name ? { name } : {}) });
        this.persist();
      }
    }
  }

  async publishDevices() {
    if (!this.data) {
      return;
    }
    const projectors = this.projectors;
    projectors.forEach((p) => this.mergeCreatedInputs(p));
    await this.gladys.publishDiscoveredDevices(projectors.map((p) => buildDevice(this.gladys, p)));
  }

  /**
   * The identity of the projector on the current connection, checked once
   * per connection before anything of it is published or commanded:
   * `ok`, `moved` (another serial, or another maker / model at an
   * address-keyed projector) or `unconfirmed` (unreadable: not another one).
   */
  async ensureIdentity(projector, client, deadline) {
    if (client.current?.open && client.current.identity === 'ok') {
      return 'ok';
    }
    const password = this.config.password;
    const ask = async (cls, body) => {
      try {
        return await client.request(
          { cls, body, param: '?' },
          { deadline, password, withSession: true },
        );
      } catch (err) {
        if (err.kind === ERROR_KINDS.REFUSED) {
          return { value: undefined, session: client.current };
        }
        throw err;
      }
    };
    if (projector.serial) {
      const { value, session } = await ask(2, 'SNUM');
      const serial = parseSerial(value);
      if (!serial) {
        return 'unconfirmed';
      }
      if (serial !== projector.serial) {
        return 'moved';
      }
      session.identity = 'ok';
      return 'ok';
    }
    const maker = await ask(1, 'INF1');
    const model = await ask(1, 'INF2');
    const read = [cleanText(maker.value, 32), cleanText(model.value, 32)];
    const kept = [projector.maker, projector.model];
    if (read[0] === kept[0] && read[1] === kept[1]) {
      if (maker.session !== model.session || !model.session) {
        return 'unconfirmed';
      }
      model.session.identity = 'ok';
      return 'ok';
    }
    // Unreadable where something is kept: not another projector, not this one either.
    if ((read[0] === undefined && kept[0]) || (read[1] === undefined && kept[1])) {
      return 'unconfirmed';
    }
    return 'moved';
  }

  /** The identity is not this projector's: nothing published but the status. */
  identityProblem(projector, identity) {
    if (identity === 'moved' && projector.serial) {
      // A serial number proves it: the address is no longer this projector's (DHCP).
      this.logger.warn(
        `${projectorName(projector)}: another projector answers at ${projector.host}`,
      );
      projector.host = '';
      this.persist();
    } else {
      this.warnOnce(
        `identity:${projector.id}:${identity}`,
        `${projectorName(projector)}: identity ${identity === 'moved' ? 'contradicted' : 'unreadable'} at ${projector.host}`,
      );
    }
    this.updateStatus().catch(() => {});
    return { identity };
  }

  // --- Readings -----------------------------------------------------------------------

  pollable() {
    return this.projectors.filter(
      (p) => this.created.has(p.id) && p.host && !this.isAuthBlocked(p),
    );
  }

  /** The monotonic time from which the next reading of `p` may start (from the caller's `mono`). */
  dueAt(projector, mono) {
    const last = this.lastAttempt.get(projector.id);
    return last === undefined ? mono : last + this.config.pollInterval * 1000;
  }

  /** One timer for every reading due, and for the typed addresses not answering yet. */
  schedule() {
    this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    if (!this.started) {
      return;
    }
    const mono = this.monotonic();
    let next = Infinity;
    for (const p of this.pollable()) {
      if (!this.inFlight.has(p.id)) {
        next = Math.min(next, this.dueAt(p, mono));
      }
    }
    for (const address of this.config.addresses) {
      const key = addressKey(address);
      if (!this.projectorAt(key) && !this.isAuthBlocked(address)) {
        next = Math.min(next, (this.probes.get(key)?.at ?? mono) + this.timings.probeRetry);
      }
    }
    if (next === Infinity) {
      return;
    }
    const generation = this.generation;
    this.pollTimer = this.timers.setTimeout(
      () => {
        this.pollTimer = undefined;
        if (generation === this.generation) {
          this.tick();
        }
      },
      Math.max(0, next - mono),
    );
  }

  /** The readings due now (each on its own: a slow projector delays no other). */
  tick() {
    const mono = this.monotonic();
    const due = this.pollable().filter(
      (p) => !this.inFlight.has(p.id) && mono >= this.dueAt(p, mono) - this.timings.timerSlack,
    );
    const work = due.map((p) => this.readState(p));
    work.push(this.probeAddresses().catch(() => {}));
    // The next timer at once: the readings started have moved their due time.
    this.schedule();
    return Promise.all(work)
      .then(() => {
        this.schedule();
        return this.updateStatus();
      })
      .catch((err) => this.logger.warn(`Polling failed: ${err.message}`));
  }

  async readState(projector, options) {
    if (this.inFlight.has(projector.id)) {
      return this.readings.get(projector.id);
    }
    this.inFlight.add(projector.id);
    let reading;
    try {
      reading = await this.read(projector, options);
    } finally {
      this.inFlight.delete(projector.id);
      // A timer that fell during this reading skipped it: the readings go on (the timer is replaced, never doubled).
      this.schedule();
    }
    if (reading !== undefined) {
      this.readings.set(projector.id, { ...reading, at: this.monotonic() });
      await this.publishStates(projector);
    }
    return reading;
  }

  /**
   * One reading: identity (once per connection), `POWR ?`, then a standby
   * kept is sent again if the projector is still on, then `ERST ?`,
   * `LAMP ?`, and `INPT ?`, `AVMT ?` when on (a command the model refuses
   * is left out). Returns the reading, `{ reachable: false }` when nothing
   * answers, undefined when nothing can be said.
   */
  async read(projector, { checkAuth = false } = {}) {
    const id = projector.id;
    // The time of the attempt is written before the reading (never sooner after a restart).
    this.lastAttempt.set(id, this.monotonic());
    projector.lastPollAt = this.now();
    this.persist();
    if (!projector.host || (this.isAuthBlocked(projector) && !checkAuth)) {
      return undefined;
    }
    const sends = this.counter(this.sends, id);
    const client = this.clientOf(projector);
    const deadline = rt() + this.timings.readBudget;
    const password = this.config.password;
    const ask = (cls, body) =>
      client.request({ cls, body, param: '?' }, { deadline, password, identity: true });
    const optional = async (cls, body) => {
      try {
        return await ask(cls, body);
      } catch (err) {
        if (err.kind === ERROR_KINDS.REFUSED) {
          return undefined;
        }
        throw err;
      }
    };
    try {
      const identity = await this.ensureIdentity(projector, client, deadline);
      if (identity !== 'ok') {
        this.clearAuthBlock(projector);
        this.standbyGap(projector);
        return this.identityProblem(projector, identity);
      }
      const stops = this.counter(this.stops, id);
      let power = parsePower(await ask(1, 'POWR'));
      if (!power) {
        throw fail(ERROR_KINDS.PROTOCOL, 'Unexpected power state');
      }
      this.clearAuthBlock(projector);
      if (projector.standby && stops === this.counter(this.stops, id)) {
        // Read after the standby was asked: decides whether it is sent again.
        if (this.settleStandby(projector, power) === 'send') {
          const result = await this.sendStandby(projector, { resend: true });
          if (result.power) {
            power = result.power;
          }
        }
      }
      if (projector.standby) {
        this.watchStandby(projector);
      }
      const reading = { reachable: true, power };
      reading.errors = parseErrors(await optional(1, 'ERST'));
      reading.lampHours = parseLampHours(await optional(1, 'LAMP'));
      if (power.code === '1') {
        reading.input = parseInput(await optional(projector.cls, 'INPT'));
        reading.muted = parseMute(await optional(1, 'AVMT'));
      }
      if (this.counter(this.sends, id) !== sends) {
        // A command left during this reading: its own read back is the fresh one.
        return undefined;
      }
      return reading;
    } catch (err) {
      this.noteSessionError(projector, err);
      if (err.kind === ERROR_KINDS.PREEMPTED || err.kind === ERROR_KINDS.BUDGET) {
        return undefined;
      }
      this.standbyGap(projector);
      if (err.kind === ERROR_KINDS.UNREACHABLE || err.kind === ERROR_KINDS.NO_ANSWER) {
        return { reachable: false };
      }
      if (!AUTH_KINDS.has(err.kind)) {
        this.warnOnce(`read:${id}:${err.kind}`, `${projectorName(projector)}: ${err.message}`);
      }
      return undefined;
    }
  }

  /** At most `statesPerMinute` states a minute, all projectors together. */
  allowStates(count) {
    const mono = this.monotonic();
    this.published = this.published.filter((at) => mono - at < 60_000);
    if (this.published.length + count > LIMITS.statesPerMinute) {
      this.warnOnce('rate', 'Too many states this minute: some readings were not published');
      return false;
    }
    for (let i = 0; i < count; i += 1) {
      this.published.push(mono);
    }
    return true;
  }

  async publishStates(projector) {
    if (!this.created.has(projector.id)) {
      return;
    }
    const states = stateList(this.gladys, projector, this.readings.get(projector.id));
    if (states.length === 0 || !this.allowStates(states.length)) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.logger.warn(
        `Could not publish the states of ${projectorName(projector)}: ${err.message}`,
      );
    }
  }

  /** Values just read during a command: merged and published, not awaited (the ack never waits for Gladys). */
  update(projector, values) {
    const previous = this.readings.get(projector.id);
    this.readings.set(projector.id, {
      ...(previous?.reachable ? previous : {}),
      identity: undefined,
      reachable: true,
      ...values,
      // Merged values keep the age of the reading they come from.
      at: previous?.reachable ? previous.at : this.monotonic(),
    });
    this.publishStates(projector).catch(() => {});
  }

  /** A reading younger than one interval. */
  isFresh(reading) {
    return reading !== undefined && this.monotonic() - reading.at < this.config.pollInterval * 1000;
  }

  /** Read again 5 s and 20 s later (grouped: a new command replaces the follow-ups waiting). */
  followUp(projector) {
    for (const handle of this.followUps.get(projector.id) ?? []) {
      this.timers.clearTimeout(handle);
      this.backgroundTimers.delete(handle);
    }
    this.followUps.set(
      projector.id,
      this.timings.followUps.map((delay) =>
        this.later(async () => {
          await this.readState(projector);
          await this.updateStatus();
        }, delay),
      ),
    );
  }

  // --- Standby, the protective command -------------------------------------------------

  /**
   * A kept standby not expired: in this run, its age on the monotonic clock;
   * read back from /data, on the wall clock (a date in the future is invalid).
   */
  standbyAlive(projector, now) {
    const standby = projector.standby;
    if (!standby) {
      return false;
    }
    if (standby.atMono !== undefined) {
      return this.monotonic() - standby.atMono <= this.timings.standbyKeep;
    }
    const wall = now ?? this.now();
    return standby.at <= wall + 60_000 && wall - standby.at <= this.timings.standbyKeep;
  }

  /**
   * What a power read after the standby means for it: `applied` (standby,
   * cooling down), `newer` (warming up after the projector accepted it: a
   * power on started since), `wait` (warming up, the standby refused or not
   * sent: sent once on), `send` (on), or `expired` / `given-up`. Anything but
   * `wait` and `send` drops it.
   */
  settleStandby(projector, power) {
    const standby = projector.standby;
    let decision;
    if (!this.standbyAlive(projector)) {
      decision = 'expired';
    } else if (isStandbyState(power)) {
      decision = 'applied';
    } else if (power.code === '3') {
      decision = standby.accepted ? 'newer' : 'wait';
    } else if (standby.sends >= this.timings.standbySends) {
      decision = 'given-up';
    } else {
      decision = 'send';
    }
    if (decision !== 'wait' && decision !== 'send') {
      if (decision !== 'applied') {
        this.logger.warn(`${projectorName(projector)}: kept standby dropped (${decision})`);
      }
      this.clearStandby(projector);
    }
    return decision;
  }

  /**
   * A reading failed or was not this projector's: an accepted standby is no
   * longer followed without a gap, so never sent again (a power on by the
   * remote meanwhile would be stopped).
   */
  standbyGap(projector) {
    if (projector.standby?.accepted) {
      this.logger.info(
        `${projectorName(projector)}: standby accepted, not followed: not sent again`,
      );
      this.clearStandby(projector);
    }
  }

  /**
   * While a standby is kept: a power reading of its own every
   * `standbyWatch` (12 s), whatever the refresh interval, that sends it as
   * soon as the projector accepts it (on after warming up, back on the
   * network). Stops when the standby is confirmed, dropped or expired.
   */
  watchStandby(projector) {
    if (this.standbyWatches.has(projector.id) || !projector.standby) {
      return;
    }
    const handle = this.later(async () => {
      this.standbyWatches.delete(projector.id);
      const p = this.data?.projectors?.[projector.id];
      if (!p?.standby) {
        return;
      }
      if (!this.standbyAlive(p)) {
        this.logger.warn(`${projectorName(p)}: kept standby dropped (expired)`);
        this.clearStandby(p);
        return;
      }
      if (p.standby.boot !== 'password') {
        await this.checkStandby(p, { priority: false });
      }
      if (p.standby) {
        this.watchStandby(p);
      }
      await this.updateStatus();
    }, this.timings.standbyWatch);
    this.standbyWatches.set(projector.id, handle);
  }

  clearStandby(projector) {
    const watch = this.standbyWatches.get(projector.id);
    if (watch) {
      this.timers.clearTimeout(watch);
      this.backgroundTimers.delete(watch);
      this.standbyWatches.delete(projector.id);
    }
    if (projector.standby) {
      delete projector.standby;
      this.persist();
      this.updateStatus().catch(() => {});
    }
  }

  /**
   * Standby pressed: never refused for a reading, a password block, a
   * command or a reading in progress, a queue, Gladys or the configuration.
   * Cancels the commands still waiting, takes the next turn of the
   * connection (cutting a frozen one), sends `POWR 0`, reads the power back.
   * Not applied yet: kept in /data and sent again (3 times at most, 10
   * minutes) by the next readings, the first ones 5 s and 20 s later.
   */
  async standby(projector) {
    this.bump(this.stops, projector.id);
    projector.standby = { at: this.now(), atMono: this.monotonic(), sends: 0, accepted: false };
    this.persist();
    this.updateStatus().catch(() => {});
    const result = await this.sendStandby(projector);
    if (result.confirmed) {
      return undefined;
    }
    if (projector.standby) {
      this.followUp(projector);
      this.watchStandby(projector);
    }
    throw fail(result.kind ?? ERROR_KINDS.TIMEOUT, result.message, result.sent);
  }

  /**
   * Sends `POWR 0` within `standbyBudget`, tried again every `standbyRetry`
   * while nothing could be sent. `{ confirmed, sent, message, power }`.
   */
  async sendStandby(projector, { boot = false, resend = false } = {}) {
    const name = projectorName(projector);
    if (!projector.host) {
      return {
        kind: ERROR_KINDS.UNREACHABLE,
        message: `${name}: address unknown, nothing sent (kept, sent once it is found)`,
      };
    }
    const id = projector.id;
    const stops = this.counter(this.stops, id);
    const standby = projector.standby;
    const deadline = rt() + this.timings.standbyBudget;
    /** Counted as a send of the kept standby only when it left (not ERR3). */
    const left = (counts = true) => {
      this.bump(this.sends, id);
      if (counts && resend && standby && projector.standby === standby) {
        standby.sends += 1;
        this.persist();
      }
    };
    const client = this.clientOf(projector);
    // A refused password is never sent again by a standby.
    const password = this.isAuthBlocked(projector) ? undefined : this.config.password;
    const ask = (param) =>
      client.request({ cls: 1, body: 'POWR', param }, { deadline, priority: true, password });
    const verify = async () => {
      let power;
      try {
        power = parsePower(await ask('?'));
      } catch {
        return undefined;
      }
      if (power) {
        this.update(projector, { power });
      }
      return power;
    };
    const settle = (power, sentMessage) => {
      if (isStandbyState(power) && stops === this.counter(this.stops, id)) {
        this.clearStandby(projector);
        return { confirmed: true, sent: true, power };
      }
      if (isStandbyState(power)) {
        return { confirmed: true, sent: true, power };
      }
      return {
        sent: true,
        power,
        kind: ERROR_KINDS.TIMEOUT,
        message: power
          ? `Sent (OK); ${name} shows "${power.label}": not applied yet (sent again if the next reading still shows it on)`
          : sentMessage,
      };
    };
    let last;
    while (deadline - rt() >= this.timings.minSendTime) {
      try {
        await ask('0');
        left();
        if (standby && projector.standby === standby && stops === this.counter(this.stops, id)) {
          // Accepted: never sent again but on a reading without a gap.
          standby.accepted = true;
          this.persist();
        }
        const power = await verify();
        if (!power) {
          this.standbyGap(projector);
        }
        return settle(power, `Sent, accepted by ${name} (OK); not read back`);
      } catch (err) {
        last = err;
        if (err.kind === ERROR_KINDS.REFUSED) {
          // ERR3 (warming up, cooling down) is not one of the resends.
          left(err.code !== 'ERR3');
          // The power read back tells which.
          const power = await verify();
          if (isStandbyState(power)) {
            return settle(power);
          }
          return {
            sent: true,
            power,
            kind: err.kind,
            message: `Refused by ${name} (${err.code}${power ? `, ${power.label.toLowerCase()}` : ''}): kept, sent again once the projector is on`,
          };
        }
        if (AUTH_KINDS.has(err.kind)) {
          if (!boot) {
            this.noteSessionError(projector, err);
          }
          return {
            kind: err.kind,
            waitsPassword: boot,
            message: `${name}: password missing or refused, nothing sent (kept)`,
          };
        }
        if (err.sent) {
          left();
          return {
            sent: true,
            kind: err.kind,
            message: `Sent, without answer from ${name} (sent again at the next readings)`,
          };
        }
        // Nothing left: tried again shortly, within the budget.
        await sleep(
          Math.min(this.timings.standbyRetry, deadline - rt() - this.timings.minSendTime),
        );
      }
    }
    return {
      kind: last?.kind ?? ERROR_KINDS.BUDGET,
      message: `${name} does not answer, nothing sent (kept, sent again at the next readings)`,
    };
  }

  /**
   * Every standby kept in /data, all at once, each checked against its
   * expiry and decided on a power read first (never sent blind); at boot
   * without the configuration (a projector asking for a password waits for
   * it).
   */
  async flushStandbys({ boot = false } = {}) {
    await Promise.all(
      this.projectors.map(async (p) => {
        if (!p.standby) {
          return;
        }
        if (!this.standbyAlive(p)) {
          this.clearStandby(p);
          return;
        }
        if (!boot && p.standby.boot !== 'password') {
          return;
        }
        const standby = p.standby;
        const result = await this.checkStandby(p, { boot });
        if (result.waitsPassword && p.standby === standby) {
          standby.boot = 'password';
        } else if (p.standby === standby) {
          delete standby.boot;
        }
        if (p.standby && !result.confirmed) {
          this.logger.warn(`${projectorName(p)}: standby kept: ${result.message}`);
          this.watchStandby(p);
        }
      }),
    );
  }

  /** A kept standby at a (re)start: the power read first, then the decision. */
  async checkStandby(projector, { boot = false, priority = true } = {}) {
    const name = projectorName(projector);
    if (!projector.host) {
      return { message: `${name}: address unknown` };
    }
    const client = this.clientOf(projector);
    const password = this.isAuthBlocked(projector) ? undefined : this.config.password;
    let power;
    try {
      power = parsePower(
        await client.request(
          { cls: 1, body: 'POWR', param: '?' },
          { deadline: rt() + this.timings.standbyBudget, priority, password },
        ),
      );
    } catch (err) {
      if (AUTH_KINDS.has(err.kind)) {
        if (!boot) {
          this.noteSessionError(projector, err);
        }
        return {
          waitsPassword: boot,
          message: `${name}: password missing or refused, nothing sent`,
        };
      }
      if (err.kind !== ERROR_KINDS.PREEMPTED && err.kind !== ERROR_KINDS.BUDGET) {
        this.standbyGap(projector);
      }
      return { message: `${name}: power not read (${err.message}), nothing sent` };
    }
    if (!power) {
      return { message: `${name}: unexpected power state, nothing sent` };
    }
    this.update(projector, { power });
    const decision = this.settleStandby(projector, power);
    if (decision === 'send') {
      return this.sendStandby(projector, { boot, resend: true });
    }
    return { confirmed: decision === 'applied', message: `${name}: ${decision}` };
  }

  // --- Commands --------------------------------------------------------------------

  async setValue(device, feature, value) {
    // /data is enough: a command never waits for the configuration.
    await this.load();
    const projector = this.projectorOf(device);
    if (!projector) {
      throw new Error(`Unknown projector ${short(device?.external_id)}`);
    }
    const key = featureKey(device.external_id, feature?.external_id);
    if (key === FEATURES.STANDBY) {
      return this.standby(projector);
    }
    if (!COMMANDS.has(key)) {
      throw new Error(`Feature "${short(key)}" cannot be commanded`);
    }
    let code;
    if (key === FEATURES.INPUT) {
      code = parseInput(typeof value === 'string' ? value : undefined);
      if (!code || value !== code || !inputOptions(projector).some((o) => o.value === code)) {
        throw new Error(`Unknown input "${short(value)}", nothing sent`);
      }
    }
    // The budget runs from the request of Gladys, the wait in the queue included.
    const ctx = {
      deadline: rt() + this.timings.commandBudget,
      stops: this.counter(this.stops, projector.id),
      sent: false,
      late: false,
    };
    const previous = this.queues.get(projector.id) ?? Promise.resolve();
    const run = previous.then(() => {
      if (ctx.late) {
        throw fail(ERROR_KINDS.BUDGET, 'No time left for this command, nothing sent');
      }
      return this.command(projector, key, code, ctx);
    });
    const settled = run.catch(() => {});
    this.queues.set(projector.id, settled);
    let timer;
    const deadline = new Promise((resolve, reject) => {
      // Real time: the ack Gladys waits for.
      timer = setTimeout(
        () => {
          ctx.late = true;
          reject(
            ctx.sent
              ? fail(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the projector', true)
              : fail(ERROR_KINDS.BUDGET, 'No time left for this command, nothing sent'),
          );
        },
        Math.max(0, ctx.deadline - rt()) + 100,
      );
    });
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
      if (this.queues.get(projector.id) === settled) {
        settled.then(() => {
          if (this.queues.get(projector.id) === settled) {
            this.queues.delete(projector.id);
          }
        });
      }
    }
  }

  async command(projector, key, code, ctx) {
    const name = projectorName(projector);
    const id = projector.id;
    const nothing = (message, kind = ERROR_KINDS.BUDGET) =>
      fail(kind, `${name}: ${message}, nothing sent`);
    if (!projector.host) {
      throw nothing('address unknown (type it, then Scan)', ERROR_KINDS.UNREACHABLE);
    }
    if (this.isAuthBlocked(projector)) {
      throw nothing(
        'password missing or refused (see the configuration)',
        this.authBlock(projector).kind,
      );
    }
    if (this.counter(this.stops, id) !== ctx.stops) {
      throw nothing('standby asked meanwhile');
    }
    if (projector.standby && key !== FEATURES.POWER_ON) {
      throw nothing('standby in progress (not confirmed yet)');
    }
    const client = this.clientOf(projector);
    const password = this.config.password;
    const left = () => ctx.deadline - rt();
    const ask = async (cls, body, what) => {
      try {
        return await client.request(
          { cls, body, param: '?' },
          { deadline: ctx.deadline, password, identity: true },
        );
      } catch (err) {
        throw this.readError(err, what, ctx);
      }
    };
    const send = (cls, body, param) =>
      client.request(
        { cls, body, param },
        {
          deadline: ctx.deadline,
          password,
          identity: true,
          // Checked in the turn of the connection, just before the bytes
          // leave: a Standby that went first cancels it; never after Gladys
          // was told "nothing sent".
          beforeSend: () => {
            if (ctx.late || left() < this.timings.minSendTime) {
              throw nothing('no time left for this command');
            }
            if (this.counter(this.stops, id) !== ctx.stops) {
              throw nothing('standby asked meanwhile');
            }
            this.bump(this.sends, id);
          },
          // Only after the write: a refused write (session closed meanwhile) sent nothing.
          afterWrite: () => {
            ctx.sent = true;
          },
        },
      );
    const notApplied = (what) =>
      fail(ERROR_KINDS.TIMEOUT, `Sent; ${name} ${what}: not applied yet`, true);
    /** The read back after a send: a failure is "sent, not confirmed", never a refusal. */
    const readBack = async (cls, body) => {
      try {
        return await client.request(
          { cls, body, param: '?' },
          { deadline: ctx.deadline, password, identity: true },
        );
      } catch {
        throw fail(ERROR_KINDS.TIMEOUT, `Sent (OK); ${name} not read back yet`, true);
      }
    };
    try {
      let identity;
      try {
        identity = await this.ensureIdentity(projector, client, ctx.deadline);
      } catch (err) {
        throw this.readError(err, 'Identity', ctx);
      }
      if (identity !== 'ok') {
        this.readings.set(id, {
          ...this.identityProblem(projector, identity),
          at: this.monotonic(),
        });
        this.publishStates(projector).catch(() => {});
        throw nothing(
          identity === 'moved'
            ? 'another projector answers at its address'
            : 'identity not confirmed (serial number, maker or model unreadable)',
          ERROR_KINDS.IDENTITY,
        );
      }
      const power = parsePower(await ask(1, 'POWR', 'Power state'));
      if (!power) {
        throw nothing('unexpected power state', ERROR_KINDS.PROTOCOL);
      }
      this.update(projector, { power });
      switch (key) {
        case FEATURES.POWER_ON: {
          if (power.on) {
            return undefined;
          }
          if (power.code === '2') {
            throw nothing('cooling down');
          }
          await send(1, 'POWR', '1');
          if (projector.standby && this.counter(this.stops, id) === ctx.stops) {
            // A newer command that left and was accepted: the kept standby is not sent again.
            this.clearStandby(projector);
          }
          const after = parsePower(await readBack(1, 'POWR'));
          if (after?.on) {
            this.update(projector, { power: after });
            return undefined;
          }
          throw notApplied(after ? `shows "${after.label}"` : 'not read back');
        }
        case FEATURES.INPUT: {
          if (power.code !== '1') {
            throw nothing(`not on (${power.label.toLowerCase()})`);
          }
          // Read with the class of the projector, set with class 1 when the code allows.
          const cls = projector.cls;
          const before = parseInput(await ask(cls, 'INPT', 'Input'));
          if (before === code) {
            this.update(projector, { input: code });
            return undefined;
          }
          await send(isClass2Input(code) ? 2 : 1, 'INPT', code);
          const after = parseInput(await readBack(cls, 'INPT'));
          if (after === code) {
            this.update(projector, { input: code });
            return undefined;
          }
          throw notApplied(after ? `shows input ${after}` : 'not read back');
        }
        case FEATURES.AV_MUTE: {
          if (power.code !== '1') {
            throw nothing(`not on (${power.label.toLowerCase()})`);
          }
          // Gladys sends a press: the mute is read just before and the explicit
          // opposite is sent, never a toggle.
          const muted = parseMute(await ask(1, 'AVMT', 'A/V mute state'));
          if (muted === undefined) {
            throw nothing('A/V mute state unknown');
          }
          await send(1, 'AVMT', muted ? '30' : '31');
          const after = parseMute(await readBack(1, 'AVMT'));
          if (after === !muted) {
            this.update(projector, { muted: after });
            return undefined;
          }
          throw notApplied(after === undefined ? 'not read back' : 'shows the A/V mute unchanged');
        }
        default:
          throw new Error(`Feature "${short(key)}" cannot be commanded`);
      }
    } catch (err) {
      this.noteSessionError(projector, err);
      throw this.commandError(projector, err, ctx);
    }
  }

  /** A read during a command: before the send, nothing was sent. */
  readError(err, what, ctx) {
    if (!(err instanceof ProjectorError) || ctx.sent) {
      return err;
    }
    if (
      err.kind === ERROR_KINDS.UNREACHABLE ||
      err.kind === ERROR_KINDS.NO_ANSWER ||
      AUTH_KINDS.has(err.kind)
    ) {
      return err;
    }
    if (err.kind === ERROR_KINDS.REFUSED) {
      return fail(err.kind, `${what} not readable (${err.code}), nothing sent`);
    }
    return fail(err.kind, `${what} not read in time, nothing sent`);
  }

  /** The error Gladys gets: "nothing sent" or "sent, without confirmation", exactly. */
  commandError(projector, err, ctx) {
    const name = projectorName(projector);
    if (!(err instanceof ProjectorError)) {
      return err;
    }
    if (ctx.sent) {
      if (err.kind === ERROR_KINDS.REFUSED && err.sent) {
        return fail(
          err.kind,
          err.code === 'ERR4'
            ? `Refused by ${name} (ERR4: projector failure, see its errors)`
            : `Refused by ${name} (${err.code}): not available now or on this model`,
          true,
        );
      }
      if (err.sent) {
        // Left, not confirmed: read again to know.
        this.followUp(projector);
        return err.message.startsWith('Sent')
          ? err
          : fail(err.kind, 'Sent, without confirmation from the projector', true);
      }
      return err;
    }
    if (err.kind === ERROR_KINDS.UNREACHABLE || err.kind === ERROR_KINDS.NO_ANSWER) {
      return fail(
        err.kind,
        `${name} does not answer (off, standby without network?), nothing sent`,
      );
    }
    if (AUTH_KINDS.has(err.kind)) {
      return fail(
        err.kind,
        `${name}: password missing or refused (see the configuration), nothing sent`,
      );
    }
    if (/nothing sent$/.test(err.message)) {
      return err;
    }
    return fail(err.kind, `${name}: ${err.message}, nothing sent`);
  }

  // --- Device lifecycle --------------------------------------------------------------

  /**
   * A device created (or updated) in Gladys: read if due, else a reading
   * younger than the interval is published for a new device; an update
   * republishes nothing (never stale as new).
   */
  async deviceCreated(device, { updated = false } = {}) {
    await this.load();
    const projector = this.projectorOf(device);
    if (!projector) {
      return;
    }
    const known = this.created.has(projector.id);
    this.created.add(projector.id);
    const reading = this.readings.get(projector.id);
    const mono = this.monotonic();
    if (this.isFresh(reading)) {
      if (!(updated && known)) {
        await this.publishStates(projector);
      }
    } else if (projector.host && mono >= this.dueAt(projector, mono) - this.timings.timerSlack) {
      await this.readState(projector);
    }
    this.schedule();
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    await this.load();
    const projector = this.projectorOf(device);
    if (projector) {
      this.created.delete(projector.id);
      // Forgotten: the next Scan finds it again from scratch.
      delete this.data.projectors[projector.id];
      this.readings.delete(projector.id);
      this.lastAttempt.delete(projector.id);
      this.persist();
      this.schedule();
      await this.updateStatus();
    }
  }

  // --- Configuration screen button ---------------------------------------------------

  /**
   * "Check the projectors": a reading younger than the interval is shown as
   * is; a projector whose password is blocked is tried once (a success lifts
   * the block, the one way besides a new password).
   */
  async checkProjectors() {
    const lines = [];
    const typed = this.config.addresses.filter((a) => !this.projectorAt(addressKey(a)));
    await Promise.all(
      typed.map(async (address) => {
        const key = addressKey(address);
        try {
          const blocked = this.isAuthBlocked(address);
          const last = this.probes.get(key)?.at;
          if (
            !blocked &&
            last !== undefined &&
            this.monotonic() - last < this.config.pollInterval * 1000
          ) {
            lines.push(
              T.checkLine(key, undefined, this.probes.get(key)?.kind ? T.noAnswer : undefined),
            );
            return;
          }
          const projector = await this.identify(address, { checkAuth: blocked });
          lines.push(T.checkLine(key, undefined, projector ? T.found : T.notKept));
        } catch (err) {
          lines.push(
            T.checkLine(key, undefined, AUTH_KINDS.has(err.kind) ? T.passwordProblem : T.noAnswer),
          );
        }
      }),
    );
    if (typed.length > 0) {
      await this.publishDevices().catch(() => {});
    }
    await Promise.all(
      this.projectors.map(async (p) => {
        const label = `${projectorName(p)} (${p.host || '?'})`;
        const blocked = this.isAuthBlocked(p);
        let reading = this.readings.get(p.id);
        if (p.host && (blocked || !this.isFresh(reading))) {
          reading = (await this.readState(p, { checkAuth: blocked })) ?? reading;
        }
        lines.push(
          T.checkLine(label, reading, this.isAuthBlocked(p) ? T.passwordProblem : undefined),
        );
      }),
    );
    this.schedule();
    await this.updateStatus();
    return lines.length === 0 ? T.noProjector : T.check(lines);
  }

  // --- Status ---------------------------------------------------------------------

  async updateStatus() {
    if (!this.started || !this.data) {
      return;
    }
    const generation = this.generation;
    const notes = [];
    if (this.store.corrupted) {
      notes.push(T.dataReset);
    }
    if (this.store.unavailable) {
      notes.push(T.dataUnreadable);
    } else if (this.saveFailed) {
      notes.push(T.saveFailed);
    }
    if (this.config.invalid.length > 0) {
      notes.push(T.invalidEntries(this.config.invalid));
    }
    if (this.config.passwordInvalid) {
      notes.push(T.passwordInvalid);
    }
    const label = (key) => {
      const projector = this.projectorAt(key);
      return projector ? projectorName(projector) : key;
    };
    const blocked = (kind) =>
      Object.entries(this.data.authBlocks)
        .filter(([, block]) => block.kind === kind)
        .map(([key]) => label(key));
    const required = blocked(ERROR_KINDS.AUTH_REQUIRED);
    const refused = blocked(ERROR_KINDS.AUTH_REFUSED);
    if (required.length > 0) {
      notes.push(T.authRequired(required));
    }
    if (refused.length > 0) {
      notes.push(T.authRefused(refused));
    }
    const silent = this.config.addresses
      .filter((a) => {
        const kind = this.probes.get(addressKey(a))?.kind;
        return kind && !AUTH_KINDS.has(kind) && !this.projectorAt(addressKey(a));
      })
      .map(addressKey);
    if (silent.length > 0) {
      notes.push(T.noAnswerAt(silent));
    }
    const created = this.projectors.filter((p) => this.created.has(p.id));
    const lost = created.filter((p) => !p.host).map(projectorName);
    if (lost.length > 0) {
      notes.push(T.addressUnknown(lost));
    }
    const reading = (p) => this.readings.get(p.id);
    const off = created.filter((p) => p.host && reading(p)?.reachable === false).map(projectorName);
    if (off.length > 0) {
      notes.push(T.unreachable(off));
    }
    const doubt = created.filter((p) => p.host && reading(p)?.identity).map(projectorName);
    if (doubt.length > 0) {
      notes.push(T.identityProblem(doubt));
    }
    const pending = this.projectors.filter((p) => p.standby).map(projectorName);
    if (pending.length > 0) {
      notes.push(T.standbyPending(pending));
    }
    const status = { connected: required.length + refused.length === 0 };
    if (notes.length > 0) {
      status.message = {
        en: notes.map((n) => n.en).join(' '),
        fr: notes.map((n) => n.fr).join(' '),
      };
    }
    const key = JSON.stringify(status);
    if (key === this.lastStatus || generation !== this.generation) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Could not publish the status: ${err.message}`);
    }
  }

  /** getConfig() failed: said in the status (once per failure series). */
  async configUnread() {
    if (this.configFailed) {
      return;
    }
    this.configFailed = true;
    try {
      await this.gladys.setConnectionStatus(false, T.configUnread);
      this.lastStatus = undefined;
    } catch {
      // Gladys unreachable: nothing to say it to.
    }
  }
}
