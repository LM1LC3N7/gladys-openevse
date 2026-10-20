# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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

[Unreleased]: https://github.com/LM1LC3N7/gladys-openevse/commits/main
