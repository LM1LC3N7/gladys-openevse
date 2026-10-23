# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

## [0.1.1] - 2026-10-21

### Added

- OpenEVSE chargers (ESP32 WiFi firmware 4.x and 5.x) read over their local
  HTTP API (no cloud), with or without the user name and password of the web
  interface (HTTP Basic): one device, keyed by the serial of the WiFi
  gateway.
- State, connector and charging state (charging-station category), vehicle
  plugged in, power, current, voltage, current offered (pilot), energy of the
  session (plain sensor), temperature, manual override, fault (read only).
- The total energy as an energy index (kWh) behind the guard of
  gladys-p1-monitor: never 0, jumps and drops held back (kept in `/data`,
  never confirmed by time) until "Accept the held index", in two clicks
  bounded to what was shown.
- Start and pause buttons and a charging current list (6 A to a ceiling of 16
  A by default, lowered by the hardware maximum of the charger), all through
  the manual override, refused unless "Allow the commands" is on (off by
  default). Start refused without a vehicle or on a fault; the current keeps
  a pause; one start or current a minute; "Pause charging" never held back
  (not by a command in flight, the minute, a 429 or 5xx pause, refused
  credentials nor the firmware), and reaffirmed if an unconfirmed command
  lands after it.
- Reads every 30 s (configurable); failures retried after 30 s to 5 minutes;
  429 and 5xx pause, kept in `/data`; refused credentials tried again after
  15 min, 1 h, then every 6 h, kept in `/data` (no secret in it). Only named
  fields of the charger's `/config` are read: its own passwords never are.
- "Test the connection" and "Accept the held index" buttons; documentation in
  English and French; `LICENSE` and `THIRD_PARTY_NOTICES.md` shipped in the
  image.

### Fixed

- "Pause charging" is no longer refused after a restart of the integration
  (a 429/5xx pause or a credential block kept, the charger down at the
  start): the serial last read at the address is kept in `/data`, and the
  pause goes to the address even before any read.
- A start never asks for more than the ceiling: the current of the override
  in force, or the charger's own current (`max_current_soft`), is lowered to
  it; start now needs the WiFi firmware 4.1.2, as the current.
- The pause keeps the fields of the override in force (current, session
  limits, auto release) instead of clearing them.
- A 404 of `GET /override` without the firmware's message refuses start and
  the current instead of reading "no override".
- Credentials pasted in the address (`user:password@`) are never shown in the
  status.
- After a restart, a charger down or blocked is no longer shown as "another
  charger".
- Follow-up reads after commands pressed in a loop are no longer stacked.
- A pause is no longer reaffirmed once the vehicle left.
- During a 5xx pause, start and the current say "server error", not "slow
  down".

[Unreleased]: https://github.com/LM1LC3N7/gladys-openevse/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-openevse/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-openevse/releases/tag/v0.1.1
