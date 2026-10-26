// -----------------------------------------------------------------------------
// One PJLink session with a projector: a TCP connection to port 4352, the
// greeting (`PJLINK 0`, or `PJLINK 1 <random>` when a password protects it),
// then one command at a time, each answered by one line ending with CR. The
// MD5 digest of the password goes before the first command only, as the
// specification (and pypjlink2) does; `PJLINK ERRA` answers a wrong one.
//
// Hostile input: a line is MAX_LINE bytes at most, checked before parsing;
// anything longer, or not PJLink, closes the session. A command that timed
// out closes the session too: its late answer never settles the next one.
// The password is never logged, never put in an error.
//
// `lastActivity` (real monotonic ms) moves on every write and every byte
// received: the client cuts a session frozen for 1 s when a standby waits.
// -----------------------------------------------------------------------------

import { connect as netConnect } from 'node:net';
import { CR, MAX_LINE, commandLine, digest, parseAnswer, parseGreeting } from './protocol.js';

export const ERROR_KINDS = Object.freeze({
  /** No TCP connection (refused, no route, timeout): nothing reached the projector. */
  UNREACHABLE: 'unreachable',
  /** Connected, but no greeting in time: nothing sent. */
  NO_ANSWER: 'no_answer',
  /** The projector asks for a password and none can be sent: nothing sent. */
  AUTH_REQUIRED: 'auth_required',
  /** The projector refused the password (`PJLINK ERRA`): the command was not run. */
  AUTH_REFUSED: 'auth_refused',
  /** The answer is not PJLink, too long, or for another command. */
  PROTOCOL: 'protocol',
  /** A command was sent and not answered in time: it may have been run. */
  TIMEOUT: 'timeout',
  /** The connection closed after a command was sent: it may have been run. */
  CLOSED: 'closed',
  /** The projector answered ERR1 to ERR4. */
  REFUSED: 'refused',
  /** No time left: nothing sent. */
  BUDGET: 'budget',
  /** Cut for a standby (frozen for 1 s): not a failure of the projector. */
  PREEMPTED: 'preempted',
  /** The identity of the projector was not checked on this connection: nothing sent. */
  IDENTITY: 'identity',
});

export class ProjectorError extends Error {
  constructor(kind, message, { sent = false, code } = {}) {
    super(message);
    this.name = 'ProjectorError';
    this.kind = kind;
    /** Whether the command may have reached the projector. */
    this.sent = sent;
    /** ERR1 to ERR4 for REFUSED. */
    this.code = code;
  }
}

const realMonotonic = () => performance.now();

export class Session {
  /**
   * Opens a session within `timeoutMs` (TCP connection and greeting).
   * Rejects with a ProjectorError.
   */
  static open({ host, port, timeoutMs, connect = netConnect, monotonic = realMonotonic }) {
    const session = new Session(monotonic);
    return session.start({ host, port, timeoutMs, connect }).then(() => session);
  }

  constructor(monotonic = realMonotonic) {
    this.monotonic = monotonic;
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
    this.greeting = undefined;
    this.authSent = false;
    this.closed = false;
    this.pending = undefined;
    this.lastActivity = monotonic();
    /** The identity checked on this session ('ok'), reset with every new session. */
    this.identity = undefined;
    this.closedPromise = new Promise((resolve) => {
      this.markClosed = resolve;
    });
  }

  get open() {
    return Boolean(this.greeting) && !this.closed;
  }

  /** Whether the next command needs the password. */
  get needsPassword() {
    return Boolean(this.greeting?.auth) && !this.authSent;
  }

  start({ host, port, timeoutMs, connect }) {
    return new Promise((resolve, reject) => {
      let connected = false;
      let settled = false;
      const fail = (kind, message) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.destroy();
          reject(new ProjectorError(kind, message));
        }
      };
      const timer = setTimeout(
        () =>
          connected
            ? fail(ERROR_KINDS.NO_ANSWER, 'The projector did not greet (no PJLink answer)')
            : fail(ERROR_KINDS.UNREACHABLE, 'No connection to the projector (timeout)'),
        Math.max(1, timeoutMs),
      );
      this.handshake = {
        fail,
        done: () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        },
      };
      try {
        this.socket = connect({ host, port });
      } catch {
        fail(ERROR_KINDS.UNREACHABLE, 'No connection to the projector');
        this.markClosed();
        return;
      }
      this.socket.setNoDelay?.(true);
      this.socket.on('connect', () => {
        connected = true;
        this.lastActivity = this.monotonic();
      });
      this.socket.on('data', (chunk) => this.receive(chunk));
      this.socket.on('error', (err) => {
        fail(
          connected ? ERROR_KINDS.NO_ANSWER : ERROR_KINDS.UNREACHABLE,
          `No connection to the projector (${err.code ?? 'network error'})`,
        );
      });
      this.socket.on('close', () => {
        fail(
          connected ? ERROR_KINDS.NO_ANSWER : ERROR_KINDS.UNREACHABLE,
          'The projector closed the connection',
        );
        this.closed = true;
        this.rejectPending(ERROR_KINDS.CLOSED, 'The projector closed the connection', true);
        this.markClosed();
      });
    });
  }

  receive(chunk) {
    if (this.closed) {
      return;
    }
    this.lastActivity = this.monotonic();
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    let end = this.buffer.indexOf(CR);
    while (end !== -1) {
      if (end > MAX_LINE) {
        this.tooLong();
        return;
      }
      const line = this.buffer.subarray(0, end).toString('latin1').replace(/^\n+/, '');
      this.buffer = this.buffer.subarray(end + 1);
      this.line(line);
      if (this.closed) {
        return;
      }
      end = this.buffer.indexOf(CR);
    }
    // Bounded before the end of the line arrives, whatever the chunks.
    if (this.buffer.length > MAX_LINE) {
      this.tooLong();
    }
  }

  tooLong() {
    if (this.handshake) {
      this.handshake.fail(ERROR_KINDS.PROTOCOL, 'Not a PJLink greeting (too long)');
    }
    this.destroy();
    this.rejectPending(ERROR_KINDS.PROTOCOL, 'Answer too long', true);
  }

  line(text) {
    if (!this.greeting) {
      const greeting = parseGreeting(text);
      if (!greeting) {
        this.handshake.fail(ERROR_KINDS.PROTOCOL, 'Not a PJLink greeting');
      } else if (greeting.error) {
        this.handshake.fail(ERROR_KINDS.AUTH_REFUSED, 'The projector refused the session (ERRA)');
      } else {
        this.greeting = greeting;
        const { done } = this.handshake;
        this.handshake = undefined;
        done();
      }
      return;
    }
    const pending = this.pending;
    if (!pending) {
      // An answer nobody waits for (late, or unsolicited): dropped.
      return;
    }
    clearTimeout(pending.timer);
    this.pending = undefined;
    const answer = parseAnswer(text);
    if (answer?.authError) {
      // The command was not run: the projector checks the digest first.
      this.destroy();
      pending.reject(
        new ProjectorError(ERROR_KINDS.AUTH_REFUSED, 'The projector refused the password'),
      );
      return;
    }
    if (!answer || answer.cls !== pending.cls || answer.body !== pending.body) {
      // Out of step: a new session next time.
      this.destroy();
      pending.reject(
        new ProjectorError(ERROR_KINDS.PROTOCOL, `Unexpected answer to ${pending.body}`, {
          sent: true,
        }),
      );
      return;
    }
    if (answer.error) {
      pending.reject(
        new ProjectorError(ERROR_KINDS.REFUSED, `Refused by the projector (${answer.error})`, {
          sent: true,
          code: answer.error,
        }),
      );
      return;
    }
    pending.resolve(answer.value);
  }

  /**
   * Sends one command (`POWR`, `?` or `1`) and resolves with the value of
   * its answer (`OK`, `1`...). ERRn rejects with REFUSED, `PJLINK ERRA` with
   * AUTH_REFUSED. `password` is used only when the projector asked for one
   * and this is the first command of the session: without it, nothing is
   * sent (AUTH_REQUIRED).
   */
  request({ cls = 1, body, param }, { timeoutMs, password }) {
    let line;
    try {
      line = commandLine(cls, body, param);
    } catch (err) {
      return Promise.reject(new ProjectorError(ERROR_KINDS.PROTOCOL, err.message));
    }
    if (!this.open) {
      return Promise.reject(new ProjectorError(ERROR_KINDS.UNREACHABLE, 'Session closed'));
    }
    if (this.pending) {
      return Promise.reject(new ProjectorError(ERROR_KINDS.PROTOCOL, 'A command is in progress'));
    }
    if (!(timeoutMs > 0)) {
      return Promise.reject(new ProjectorError(ERROR_KINDS.BUDGET, 'No time left, nothing sent'));
    }
    let prefix = '';
    if (this.needsPassword) {
      if (typeof password !== 'string' || password === '') {
        return Promise.reject(
          new ProjectorError(ERROR_KINDS.AUTH_REQUIRED, 'The projector asks for a password'),
        );
      }
      prefix = digest(this.greeting.random, password);
      this.authSent = true;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        // Closed: a late answer must never settle the next command.
        this.destroy();
        reject(
          new ProjectorError(ERROR_KINDS.TIMEOUT, 'Sent, without answer from the projector', {
            sent: true,
          }),
        );
      }, timeoutMs);
      this.pending = { timer, resolve, reject, cls, body };
      this.lastActivity = this.monotonic();
      this.socket.write(`${prefix}${line}\r`);
    });
  }

  rejectPending(kind, message, sent) {
    if (this.pending) {
      const { reject, timer } = this.pending;
      clearTimeout(timer);
      this.pending = undefined;
      reject(new ProjectorError(kind, message, { sent }));
    }
  }

  /** In flight with nothing received for `ms`: connecting, greeting or answer. */
  frozenFor(ms) {
    return (
      !this.closed &&
      (Boolean(this.pending) || !this.greeting) &&
      this.monotonic() - this.lastActivity >= ms
    );
  }

  destroy() {
    this.closed = true;
    this.socket?.destroy();
    if (!this.socket) {
      this.markClosed();
    }
  }

  /** Cut for a standby: the command in flight fails PREEMPTED. */
  preempt() {
    if (this.handshake) {
      this.handshake.fail(ERROR_KINDS.PREEMPTED, 'Cut for a standby');
    }
    this.rejectPending(ERROR_KINDS.PREEMPTED, 'Cut for a standby', true);
    this.destroy();
  }

  close() {
    this.rejectPending(ERROR_KINDS.CLOSED, 'Session closed', true);
    this.destroy();
  }
}
