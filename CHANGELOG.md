# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- PJLink projectors (class 1 and 2) on the local network, added by IP address
  and created from the Discovery tab: power state, status, input (with the
  input names of class 2), A/V mute, lamp hours and error report.
- Power on, input and A/V mute: decided on the state read just before,
  confirmed by a read back, answered within 3.5 s ("nothing sent", "sent,
  without confirmation", "not applied yet", "refused by the projector").
- Standby, the protective command: first in line, never held back by a
  reading or a command, cancels the commands still waiting, cuts a reading
  frozen for 1 s, kept in /data and sent again until a reading shows it
  applied (3 times at most, 10 minutes), sent at once at a restart.
- Optional PJLink password (MD5 digest); a missing or refused password blocks
  its projector without any automatic retry until it is changed or "Check the
  projectors" succeeds.
- Identity checked once per connection (serial number, or maker and model)
  before anything is published or sent.
- "Check the projectors" button; user documentation in English and French.
