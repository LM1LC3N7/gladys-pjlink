// -----------------------------------------------------------------------------
// The client of one projector address. A projector accepts one PJLink
// connection at a time, so everything for that address goes through here:
// one session, one command in flight (never pipelined), handed over command
// by command. A standby (`priority`) takes the next turn, before the
// readings and commands waiting, and cuts the command in flight when nothing
// has come from the projector for `frozenCut` (1 s): the old connection is
// closed before a new one is opened. The session is reused while used and
// closed after `idleClose` of silence.
//
// Times here are real (the network): `performance.now()` and the global
// timers, whatever clock the app is given for its schedules.
// -----------------------------------------------------------------------------

import { connect as netConnect } from 'node:net';
import { PJLINK_PORT } from './protocol.js';
import { ERROR_KINDS, ProjectorError, Session } from './session.js';

const mono = () => performance.now();

export class ProjectorClient {
  constructor({
    host,
    port = PJLINK_PORT,
    connect = netConnect,
    connectTimeout = 2_000,
    requestTimeout = 2_000,
    idleClose = 3_000,
    frozenCut = 1_000,
  }) {
    this.host = host;
    this.port = port;
    this.connect = connect;
    this.connectTimeout = connectTimeout;
    this.requestTimeout = requestTimeout;
    this.idleClose = idleClose;
    this.frozenCut = frozenCut;
    this.current = undefined;
    this.busy = false;
    this.waiters = [];
    this.idleTimer = undefined;
    this.watch = undefined;
    this.stopped = false;
  }

  // --- The turn -------------------------------------------------------------------

  /** Resolves with a release function once it is this caller's turn. */
  acquire(priority, deadline) {
    if (this.stopped) {
      return Promise.reject(new ProjectorError(ERROR_KINDS.BUDGET, 'Stopped, nothing sent'));
    }
    this.clearIdle();
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve, reject) => {
      const waiter = { priority, resolve, reject };
      waiter.timer = setTimeout(
        () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(
            new ProjectorError(ERROR_KINDS.BUDGET, 'No time left (projector busy), nothing sent'),
          );
        },
        Math.max(0, deadline - mono()),
      );
      if (priority) {
        const index = this.waiters.findIndex((w) => !w.priority);
        this.waiters.splice(index === -1 ? this.waiters.length : index, 0, waiter);
        this.watchFrozen();
      } else {
        this.waiters.push(waiter);
      }
    });
  }

  /** While a standby waits: the command in flight is cut once frozen for `frozenCut`. */
  watchFrozen() {
    if (this.watch) {
      return;
    }
    this.watch = setInterval(() => {
      if (!this.waiters.some((w) => w.priority)) {
        clearInterval(this.watch);
        this.watch = undefined;
        return;
      }
      if (this.current?.frozenFor(this.frozenCut)) {
        this.current.preempt();
      }
    }, 50);
    this.watch.unref?.();
  }

  async release() {
    const session = this.current;
    if (session?.closed) {
      // The next one opens its connection only after this one is closed.
      await Promise.race([session.closedPromise, new Promise((r) => setTimeout(r, 1_000))]);
      if (this.current === session) {
        this.current = undefined;
      }
    }
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(() => this.release());
      return;
    }
    this.busy = false;
    this.armIdle();
  }

  // --- Session and commands ------------------------------------------------------------

  async session(budget) {
    if (this.current?.open) {
      return this.current;
    }
    if (!(budget > 0)) {
      throw new ProjectorError(ERROR_KINDS.BUDGET, 'No time left, nothing sent');
    }
    if (this.last && this.last !== this.current) {
      // A projector accepts one connection: the old one is closed first.
      await Promise.race([this.last.closedPromise, new Promise((r) => setTimeout(r, 500))]);
    }
    const started = mono();
    for (let attempt = 1; ; attempt += 1) {
      const session = new Session();
      this.current = session;
      this.last = session;
      try {
        await session.start({
          host: this.host,
          port: this.port,
          timeoutMs: Math.min(this.connectTimeout, budget - (mono() - started)),
          connect: this.connect,
        });
        return session;
      } catch (err) {
        // Closed before any greeting: the projector may still hold the old
        // connection (one at a time). Tried once more, shortly after.
        const left = budget - (mono() - started);
        if (
          attempt > 1 ||
          err.kind !== ERROR_KINDS.NO_ANSWER ||
          session.greetingSeen ||
          left < 400
        ) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }

  /**
   * One command in its turn, within `deadline` (real monotonic ms):
   * `{ cls, body, param }` -> the value answered. `password` is sent only if
   * the projector asks for one on this session. `identity`: sent only on a
   * session whose identity was checked (`session.identity === 'ok'`), else
   * nothing is sent. `withSession`: resolves `{ value, session }`.
   * `beforeSend()`: called once the turn and the session are obtained, right
   * before writing; a throw means nothing is sent. `afterWrite()`: called
   * right after the bytes were written to the socket.
   */
  async request(
    command,
    { deadline, priority = false, password, identity, withSession, beforeSend, afterWrite } = {},
  ) {
    const release = await this.acquire(priority, deadline);
    try {
      const left = () => deadline - mono();
      const session = await this.session(left());
      if (identity && session.identity !== 'ok') {
        throw new ProjectorError(
          ERROR_KINDS.IDENTITY,
          'Identity not checked on this connection, nothing sent',
        );
      }
      if (!(left() > 0)) {
        throw new ProjectorError(ERROR_KINDS.BUDGET, 'No time left, nothing sent');
      }
      // The caller's last check, in its turn, just before the bytes leave (throws: nothing sent).
      beforeSend?.();
      try {
        const value = await session.request(command, {
          timeoutMs: Math.min(this.requestTimeout, left()),
          password,
          afterWrite,
        });
        return withSession ? { value, session } : value;
      } catch (err) {
        if (err.kind !== ERROR_KINDS.REFUSED && err.kind !== ERROR_KINDS.AUTH_REQUIRED) {
          session.destroy();
        }
        throw err;
      }
    } finally {
      await release();
    }
  }

  clearIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  armIdle() {
    this.clearIdle();
    if (!this.current) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (!this.busy) {
        this.current?.close();
        this.current = undefined;
      }
    }, this.idleClose);
    this.idleTimer.unref?.();
  }

  close() {
    this.stopped = true;
    this.clearIdle();
    clearInterval(this.watch);
    this.watch = undefined;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new ProjectorError(ERROR_KINDS.BUDGET, 'Stopped, nothing sent'));
    }
    this.current?.close();
    this.current = undefined;
  }
}
