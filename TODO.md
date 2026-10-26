# TODO — PJLink v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local control** (2026-10-26): projectors added by IP
      address, identified on a Scan (class, serial number, maker, model, name,
      inputs); power, status, input, A/V mute, lamp hours, errors; Power on,
      input and A/V mute decided on a fresh read and confirmed by a read back;
      Standby as the protective command (first in line, kept in /data, sent
      again, sent at boot); persisted password blocks; "Check the projectors";
      docs en/fr. Tested against a fake projector on the loopback interface
      only, never with a real device.
- [ ] **Milestone 2 — real projectors** (testers with any PJLink projector,
      class 1 and class 2). To check first:
  - that the projector answers in standby with the network standby on (some
    models close PJLink in standby, as the specification allows);
  - the answer to `POWR 0` while warming up (ERR3 expected) and how long the
    warm-up lasts (the kept standby is sent again by the readings);
  - whether `SNUM` answers on every class 2 model, and in standby;
  - the `INST` / `INNM` of recent models (class 2 inputs `6x`, `xA`...);
  - whether the projector closes an idle connection itself before 30 s, and
    how fast it accepts a new one after a close (one retry after 150 ms);
  - laser models: `LAMP` answer (ERR1 expected, the feature then stays empty);
  - the rendering on the Gladys dashboard: the two `button/push`, the
    `unknown/binary` power, the `text/text` status and errors, the
    `text/select` input, the `television/volume-mute` press, the
    `duration/integer` lamp hours.
- [ ] **Milestone 3 — more**: volume (`SVOL`, class 2, capped by an option as
      the audio modules), freeze (`FREZ`), filter hours (`FILT`), the class 2
      search (`SRCH` by UDP broadcast: the answer goes to port 4352 of the
      sender, not to the port the core sends from, so it needs a check with
      the core's `scanNetwork`), the status notifications (`LKUP`, UDP 4352),
      one password per projector, `keywords` / `countries` in the manifest.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: pypjlink2 1.2.2 (Apache-2.0, PyPI 2020-06-14, repository read at
  `c96c6ed`, frozen since 2020, the library of the Home Assistant PJLink
  integration) is Python and synchronous; the protocol is a public standard,
  so it is written from the specification in JavaScript (`src/pjlink/`) and
  only cross-checked with the library (notice in `THIRD_PARTY_NOTICES.md`,
  copied into the image). No runtime dependency besides the SDK.
- SDK `^0.15.0`: the template asks `^0.16.0`, not published on npm on
  2026-10-26 (`npm view` gives 0.15.0). Migrate when it is (CHANGELOG 0.16.0:
  music, AI and TTS types, nothing used here).
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1: the one exception to
  "versions belong to the Release workflow", because the template's 1.0.0 and
  its image were someone else's. The first patch release gives 0.1.1.
- Manifest: category `multimedia` (projectors are media devices, table §3 of
  the catalog spec), transport `local`, no `network_discovery` (see milestone
  3), no `keywords` / `countries` yet.
- **External ids** (frozen rule): `gladys.externalIds('pjlink', <id>)`, `<id>`
  = `sn-<SERIAL>` where `SERIAL` is the class 2 `SNUM` answer in upper case,
  letters and digits only (4 to 32), else `ip-<address>` (non-alphanumerics as
  dashes, `-<port>` when not 4352). A projector first known by its address
  keeps that id even if it later gives a serial with the same maker and model
  (no promotion). No serial readable at the address of a projector keyed by
  its serial: nothing changed (unreadable is not another projector). Another
  serial: the old projector loses the address (proof), the new one is added.
  An address-keyed projector whose maker or model differs is never written
  over (its device is deleted in Gladys to start over: a deleted device is
  forgotten from /data). Feature keys are frozen: `power`, `power_on`,
  `standby`, `status`, `input`, `av_mute`, `lamp_hours`, `errors`. Every
  publication carries the full, fixed feature list; the input options come
  from `INST` / `INNM` at a Scan, merged with the `supported_options` of the
  created device (never lost after a /data reset); names and inputs change at
  a Scan only.
- **Identity** checked once per connection (`session.identity`, reset with
  every connection) before any reading is published and any command but
  Standby is sent: `SNUM` for a serial-keyed projector, `INF1` + `INF2` for
  an address-keyed one (on the same connection). Unreadable: "Identity not
  confirmed", nothing published but the status, nothing sent but Standby.
- **Power: read-only state + two `button/push`, no `switch`** (lesson of lot
  6). Power 1 for `1` (on) and `3` (warming up), 0 for `0` and `2`.
  Unreachable publishes the status only (never a power 0: not a measure).
  Power on is sent from `0` only (refused, nothing sent, while cooling down;
  nothing to do when on or warming up). Not a sensitive command: no option
  (a projector is not in the list of the lot rules; the Epson module does the
  same).
- **Standby = the protective command.** Out of the command queue: it takes
  the next turn of the connection (`priority`), before the readings and
  commands waiting; a command in flight with nothing received for 1 s
  (connecting, greeting or answer) is cut, the old connection closed before a
  new one opens. Every command asked before it and not sent yet is refused
  "nothing sent" (`stops` counter checked just before the bytes leave). It
  sends `POWR 0` without reading anything first, reads the power back
  (standby or cooling down: confirmed); retried every 250 ms within 3.2 s
  while nothing could be sent. Not confirmed: kept in /data (`standby: { at,
sends }`, written before the send; a failed save does not stop the send),
  sent again by the readings (follow-ups at 5 s and 20 s, then the regular
  ones), 3 times at most, 10 minutes at most; at boot, every valid one is
  sent at once without `getConfig()` nor a reading (a date in the future or
  past the 10 minutes: dropped). Dropped when a reading made after it shows
  `0`, `2` or `3` (a power on started since is never stopped by a resend), or
  when a Power on asked after it is sent and answered OK. Residual case
  (documented): a projector seen on (`1`) gets it again, so a power on by
  the remote is stopped if the readings missed both the cool-down (2) and the
  warm-up (3) in between (the confirm read and the follow-ups at 5 s and 20 s
  failing); a cool-down usually lasts 30 s or more (to check at milestone 2). While it is kept,
  input and A/V mute are refused "nothing sent". A refused password is not
  sent by a Standby (the connection is made, the greeting read: a projector
  that no longer asks for a password gets it). At boot, a projector asking
  for a password waits for the configuration (no block is set without it).
  There are no pauses (429/5xx), tokens or rate limits in this local
  protocol: nothing else can hold it back.
- Commands (Power on, input, A/V mute): serialized per projector (a promise
  chain), budget 3.5 s from the Gladys request (queue included), the ack
  given in real time; each reads `POWR ?` first (decides), then the current
  value; the send is checked just before the bytes leave (budget ≥ 300 ms, no
  Standby since); success only when the read back shows the value, the value
  of before = "not applied yet", follow-up readings at 5 s and 20 s. A/V mute
  is a press (Gladys sends a press): `AVMT ?` read, the explicit opposite
  (`31` / `30`) sent, never a toggle; any mute (`11`, `21`, `31`) counts as
  muted. Input codes listed in the dropdown only (strict pattern, no CR can
  reach the projector), set with class 1 `INPT` when the code allows.
- Readings: every created projector at the interval (30 to 600 s, 60 by
  default), one timer, one read of the monotonic clock per decision; the time
  of the attempt written to /data before the reading (a restart never reads
  sooner, a date in the future counts as now); never sooner on a
  reconnection, a saved configuration, Check, Scan or a device created or
  updated (a reading younger than the interval is published for a new
  device, nothing for an update). A reading crossing a command that left is
  dropped (the command's read back is fresh). Questions the model refuses
  (ERR) are left out. 280 states a minute at most for all projectors (10
  projectors, 30 s minimum: far under).
- Passwords (one for all projectors, 32 printable ASCII characters at most):
  a missing (`PJLINK 1` and no password) or refused (`PJLINK ERRA`) password
  blocks `host:port`, persisted in /data with a 6-bit salted SHA-256 mark of
  the password tried; no reading, command or identification there, no retry
  by itself (timers, reconnection, restart). Lifted by a password change
  (compared as typed within a run, by its mark after a restart: 1 chance in
  64 to stay blocked) or a successful "Check the projectors" (one try per
  press). The mark identifies nothing (test: about 156 of the 10 000
  four-digit codes share one) and is erased on success; the good password
  never has one. The config has no user name (PJLink has none).
- getConfig() failing on a connection: the status says so, retried 5 s,
  doubled up to 60 s, without end, stopped by a disconnection. Commands and
  Standby use /data meanwhile.
- /data: one write queue; an unreadable file (permissions) is never written
  over (status says so, nothing saved); a file that is not JSON is moved to
  `pjlink.json.bad` (ids are rebuilt identically by a Scan; the password
  blocks and kept standbys of that file are lost). Written at a clean stop.
- Hostile input: a line is 256 bytes at most, checked before its end arrives;
  the greeting and answers match exact patterns, an answer for another
  command closes the connection; names, makers, models cleaned of control
  characters and bounded; /data sanitized (no prototype, bounded tables).
  Typed addresses: never 0.0.0.0, a broadcast (`.255`) nor a multicast
  address.
- Categories and types from the core only: `unknown/binary`, `button/push`,
  `text/text`, `text/select`, `television/volume-mute`, `duration/integer`
  with the unit `hours`.
- Tests: the fake projector of `test/fixtures/` on the TCP server of the
  kit (one client at a time, like a real projector), the SDK's fake Gladys,
  the kit's clocks (`test/kit/`, copied from `~/code/ref/gladys-testkit`).
