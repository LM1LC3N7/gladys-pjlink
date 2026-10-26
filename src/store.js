// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume, file mode 0600): the known projectors by id (address, name, class,
// serial number, maker and model, inputs), the time of their last reading,
// the standby not confirmed yet, and the addresses where a password is
// missing or was refused (with the 6-bit mark of src/authmark.js). Never
// the password.
//
// One write at a time (a queue). A file that cannot be read (permissions) is
// never taken for an empty one: nothing is written over it. A file that is
// not JSON is moved aside to `<name>.bad`, never overwritten.
// -----------------------------------------------------------------------------

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS } from './constants.js';
import { parseInput } from './pjlink/protocol.js';

export const FILE_NAME = 'pjlink.json';

/** A projector id: `sn-<serial>` or `ip-<address>`, plain characters only. */
export const isProjectorId = (id) =>
  typeof id === 'string' && /^(?:sn|ip)-[A-Za-z0-9-]{1,48}$/.test(id);

export const emptyData = () => ({
  projectors: Object.create(null),
  /** `host:port` -> { kind, salt, mark }: a password missing or refused there. */
  authBlocks: Object.create(null),
});

const AUTH_BLOCK_KINDS = new Set(['auth_required', 'auth_refused']);
const text = (value, max) =>
  typeof value === 'string' && value !== ''
    ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, max)
    : undefined;
const finite = (value) => (Number.isFinite(value) ? value : undefined);

function sanitizeProjector(id, p) {
  const inputs = [];
  for (const input of Array.isArray(p.inputs) ? p.inputs.slice(0, LIMITS.inputs) : []) {
    const code = parseInput(input?.code);
    if (code && input.code === code && !inputs.some((i) => i.code === code)) {
      inputs.push({ code, ...(text(input.name, 32) ? { name: text(input.name, 32) } : {}) });
    }
  }
  const standby =
    p.standby && finite(p.standby.at) !== undefined
      ? {
          at: p.standby.at,
          sends: Number.isInteger(p.standby.sends) ? Math.max(0, p.standby.sends) : 0,
          accepted: p.standby.accepted === true,
        }
      : undefined;
  return {
    id,
    host: typeof p.host === 'string' && /^[a-z0-9.-]{0,253}$/.test(p.host) ? p.host : '',
    port: Number.isInteger(p.port) && p.port > 0 && p.port < 65536 ? p.port : 4352,
    name: text(p.name, LIMITS.name) ?? '',
    cls: p.cls === 2 ? 2 : 1,
    serial:
      typeof p.serial === 'string' && /^[A-Z0-9]{4,32}$/.test(p.serial) ? p.serial : undefined,
    maker: text(p.maker, 32),
    model: text(p.model, 32),
    inputs,
    lastPollAt: finite(p.lastPollAt),
    standby,
  };
}

export function sanitize(data) {
  const base = emptyData();
  if (!data || typeof data !== 'object') {
    return base;
  }
  if (data.authBlocks && typeof data.authBlocks === 'object') {
    for (const [key, block] of Object.entries(data.authBlocks).slice(0, 64)) {
      if (
        /^[a-z0-9.-]{1,253}:\d{1,5}$/.test(key) &&
        block &&
        AUTH_BLOCK_KINDS.has(block.kind) &&
        typeof block.salt === 'string' &&
        /^[0-9a-f]{32}$/.test(block.salt) &&
        Number.isInteger(block.mark) &&
        block.mark >= 0 &&
        block.mark < 64
      ) {
        base.authBlocks[key] = { kind: block.kind, salt: block.salt, mark: block.mark };
      }
    }
  }
  const projectors = data.projectors;
  if (projectors && typeof projectors === 'object') {
    for (const [id, p] of Object.entries(projectors).slice(0, 64)) {
      if (isProjectorId(id) && p && typeof p === 'object' && p.id === id) {
        base.projectors[id] = sanitizeProjector(id, p);
      }
    }
  }
  return base;
}

/** Plain JSON of the data (no prototype-less objects lost, no undefined). */
const serialize = (data) => JSON.stringify(data);

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name = FILE_NAME } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    /** Not JSON: moved aside to `<name>.bad`. */
    this.corrupted = false;
    /** Not readable (permissions...): never written over. */
    this.unavailable = false;
    this.queue = Promise.resolve();
  }

  async load() {
    let content;
    try {
      content = await readFile(this.path, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        this.unavailable = true;
      }
      return emptyData();
    }
    try {
      return sanitize(JSON.parse(content));
    } catch {
      this.corrupted = true;
      const bad = `${this.path}.bad`;
      await rename(this.path, bad).catch(() => {});
      await chmod(bad, 0o600).catch(() => {});
      return emptyData();
    }
  }

  /** Queued: one write at a time, in order. Rejects when it failed. */
  save(data) {
    const json = serialize(data);
    const run = this.queue.then(async () => {
      if (this.unavailable) {
        throw new Error('/data unreadable: not written over');
      }
      await mkdir(this.dir, { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, json, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData(), { failSave = false } = {}) {
    this.data = JSON.parse(serialize(data));
    this.saves = 0;
    this.failSave = failSave;
    this.corrupted = false;
    this.unavailable = false;
  }

  async load() {
    return sanitize(JSON.parse(serialize(this.data)));
  }

  async save(data) {
    if (this.failSave) {
      throw new Error('disk full');
    }
    this.data = JSON.parse(serialize(data));
    this.saves += 1;
  }
}
