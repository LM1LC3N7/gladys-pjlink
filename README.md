# gladys-pjlink

[Gladys Assistant](https://gladysassistant.com) external integration for
**PJLink projectors** (class 1 and 2: Epson, Panasonic, NEC, Sony, BenQ,
Canon, Hitachi, Optoma...), on the local network: power on, standby, input,
A/V mute, lamp hours and error report, through **PJLink** (TCP port 4352),
without any cloud. Unofficial, not affiliated with JBMIA nor with any
projector maker.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, tested against a fake projector only,
> never with a real projector.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (PjlinkApp)
                                   ├─ src/pjlink/client.js    one address: one connection, turns, Standby first
                                   ├─ src/pjlink/session.js   greeting, MD5 digest, one command at a time, bounded lines
                                   ├─ src/pjlink/protocol.js  lines and values (pure)
                                   ├─ src/model.js            projectors -> Gladys devices and states (pure)
                                   └─ src/store.js            /data/pjlink.json: projectors, kept standbys, password blocks
```

- **Projectors** are added by IP address (configuration) and identified on a
  scan of the Discovery tab: class (`CLSS`), serial number (`SNUM`, class 2),
  maker, model, name, inputs and their names. External id `pjlink:sn-<serial>`,
  or `pjlink:ip-<address>` for a projector that gives no serial.
- **One connection at a time** per projector (a projector accepts one), one
  command in flight, closed after 3 s of silence; the identity is checked once
  per connection before anything is published or sent (Standby aside).
- **Readings** at the configured interval (60 s by default, 30 s at least),
  never sooner on a restart, a reconnection, a saved configuration, Check or
  a Scan (the follow-ups of a command, and a Check of a blocked projector,
  aside);
  `POWR`, `ERST`, `LAMP`, and `INPT`, `AVMT` when on.
- **Commands** (Power on, input, A/V mute): serialized per projector, decided
  on the state read just before, confirmed by a read back, answered within
  3.5 s.
- **Standby** is the protective command: first in line, cancels what was
  queued before it, cuts a reading frozen for 1 s. Accepted (`OK`): never
  sent again blindly. Not accepted (ERR3, no answer, unreachable): kept in
  /data and sent again by the readings that show the projector on (3 times at
  most, 10 minutes), decided on a power read at a restart.
- **Password** (optional): MD5 digest before the first command of a
  connection. A missing or refused one blocks the projector, persisted, never
  tried again by itself; only a 6-bit mark of a refused one is kept, to tell
  a changed password after a restart.

## Development

```bash
npm install
npm test
npm run lint && npm run format:check
npm run cover   # regenerates cover.png
```

See `CLAUDE.md` for the rules, `TODO.md` for the decisions and what comes
next.

## License

Apache-2.0, see `LICENSE` and `THIRD_PARTY_NOTICES.md`.
