# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for PJLink projectors (class 1
and 2, TCP port 4352, local network): a Node.js service (Node 22+, ESM, no
build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template;
the protocol is written from the public PJLink specification, cross-checked
with `pypjlink2` (Apache-2.0, see `THIRD_PARTY_NOTICES.md`). Decisions are
recorded in `TODO.md`.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/standby.test.js          # one file
node --test --test-name-pattern "Standby" # tests whose name matches
npm run cover                             # regenerates cover.png
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only; app.boot() sends the standbys kept in /data first
src/handlers.js                   every SDK handler -> PjlinkApp (shared with the tests); getConfig() retries
src/app.js                        projectors, identity, readings, commands, Standby, passwords, status
src/pjlink/protocol.js            greeting, digest, lines, values (pure)
src/pjlink/session.js             one TCP session: greeting, digest, one command at a time, bounded lines
src/pjlink/client.js              one address: one connection, turns (Standby first), frozen cut, idle close
src/model.js                      projectors -> Gladys devices and states (pure)
src/store.js                      /data/pjlink.json (a write queue, never written over when unreadable)
src/authmark.js                   the 6-bit mark of a refused password
src/constants.js                  frozen keys, limits, timings
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       status and button texts, English and French
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test: fake Gladys (SDK), fake projector (test/fixtures/), kit (test/kit/)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** `gladys.externalIds('pjlink', id)`, `id`
  being `sn-<serial>` (class 2 `SNUM`) or `ip-<address>` (see `TODO.md`).
  Never changed afterwards. The same goes for every key users store: manifest
  `config_schema`, `actions`, feature keys.
- **No switch** for power: buttons ("Power on", "Standby") and read-only
  states only.
- **Standby is the protective command**: never refused for a reading, a
  queue, a command, the configuration or Gladys; nothing queued before it
  leaves after it; kept in /data until a reading shows it applied. Any change
  near it needs a test in `test/standby.test.js`.
- **Commands are decided on the state read just before**, never on memory,
  and are a success only when read back; a command that may have left is
  "sent, without confirmation", never "nothing sent".
- **Clocks**: `monotonic` for every schedule and age (one read per decision),
  `now` (wall) only for what /data keeps; the network and the 5 s of Gladys in
  real time. Tests use the clocks of `test/kit/clock.mjs`.
- **The password** (config `password`) is never logged, never written to
  /data nor put in a message. A refused one is never sent again by itself.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was set once by hand, see `TODO.md`).
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`;
  `supported_options[].label` is a plain string. `test/manifest.test.js` ties
  the manifest to the code.
- **User-facing text** is bilingual, UTF-8 without BOM (`test/encoding.test.js`),
  and a secret is never called encrypted.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never leave the loopback interface.
