# TODO — OpenEVSE v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (lot 11) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-20): one charger by IP address,
      optional HTTP Basic credentials, one device per `wifi_serial`, state,
      connector, charging state, plugged, power, current, voltage, pilot,
      session energy (plain sensor), energy index behind the guard of
      gladys-p1-monitor with "Accept the held index" in two clicks,
      temperature, override, fault flag, start/pause buttons and current
      select behind `allow_commands` (off), pause never held back, one start
      or current a minute, late reads quarantined, 429/5xx pauses and
      credential blocks persisted, test button, docs en/fr, cover. Tested
      against made-up answers only.
- [x] **Milestone 1 fixes — review 1** (2026-10-21): pause after a restart
      before any read (B1: last serial kept in `/data`, pause to the address
      even without it), start bounded by the ceiling (I1: override current or
      `max_current_soft` lowered, firmware 4.1.2), pause keeps the override
      fields (I2), and M1-M7 (404 of `/override` only "none" with a `msg`,
      credentials in the address never shown, no "another charger" before a
      read, follow-up reads not stacked, no reaffirmed pause without a
      vehicle, 5xx refusal text, dead code). Reviewer scenarios in
      `test/app.test.js` ("B1", "I1", "I2", "M1"…).
- [ ] **Milestone 2 — real charger**: run against a real OpenEVSE (see "To
      check"), turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: the websocket (`/ws`, live status instead of
      polling), "back to automatic" (`DELETE /override`, a start in disguise:
      behind the option), divert (solar) mode, session limits (`/limit`),
      several chargers — each behind the option, never a switch.

## To check on a real charger

- `GET /override` with no override: a 404 `{"msg": "No manual override"}`
  (read as "none") or a 200 `{}`? Both are read as none.
- `POST /override {"state": "disabled"}` alone: does it pause at once (EVSE
  state 254), and what `auto_release` does the firmware give it when it is
  left out (released when the vehicle leaves?).
- `POST /override` replaces the whole override (python-openevse-http posts
  the fields in force again for that reason): check that a current posted
  with `state: "disabled"` keeps the charge paused.
- An override with only `charge_current` (no `state`): accepted, and the
  charge neither started nor stopped by it?
- The answers of a POST (`{"msg": "OK"}`, "Created", "Updated"?) and of a
  refused one (400 with `msg`?).
- `total_energy` (kWh) vs `watthour` (Wh): reset by `DELETE /emeter`? (the
  guard holds the drop until accepted). `session_energy` after the vehicle
  left.
- The 401 of a wrong Basic auth; whether `/status` stays open without
  credentials on some firmwares.
- `temp` in tenths of a degree on every board (`temp1` on older ones).
- Two clients (Home Assistant, an OCPP server and Gladys) on the same
  override: the last write wins.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-openevse:0.1.0`):
  the first Release (patch) gives 0.1.1.
- **Reference**: python-openevse-http 1.9.0 (Apache-2.0, firstof9, the
  library of Home Assistant's OpenEVSE integration), read at commit
  `1e44838`; full license and notice in `THIRD_PARTY_NOTICES.md`. Neighbours:
  gladys-peblar (structure, commands) and gladys-keba (commands).
- **Firmware 4.x and 5.x of the ESP32 gateway only**: `wifi_serial` (the id
  of the device) is missing from 2.x and 3.x; no RAPI (`/r`). Start needs
  4.0.1 (`/override`), the current 4.1.2 (as the library's `set_current`); an
  unknown version (a dev build name) refuses both. The pause is sent whatever
  the version (a missing route answers 404: refused, said so). (Review 1)
  start needs 4.1.2 too: it may post `charge_current` to keep the ceiling.
- **Start bounded by the ceiling** (review 1, as Peblar): the
  `charge_current` of the override in force is lowered to the ceiling (never
  raised); without one, `max_current_soft` of `/config` (the 7th field read,
  the charger's own current) above the ceiling gives `charge_current` = the
  ceiling, under it nothing is added; missing: start refused.
- **The serial last read is kept in `/data`** with the address key (the id
  of the device, not a secret), restored at a start for the same address:
  the pause works before any read; start and the current wait for a read
  (version and bounds unknown). With no serial kept (/data lost), a pause is
  still sent to the configured address while no charger was read since the
  start (pausing whatever answers there is harmless). No orphan is shown
  until a read succeeded.
- **The pause posts the fields of the override last read** (no read before
  it), `state: "disabled"`; sent again and reaffirmed the same way.
  Reaffirmed only while a vehicle is plugged in (auto release).
- **A 404 of `GET /override` is "none" only with a JSON `msg`** (the
  firmware's answer); empty or text: an error, start and current refused.
- **Credentials typed in the address** (`@`): never parsed nor shown, a
  fixed message.
- **Follow-up reads**: a new command replaces the pending ones (at most one
  per delay). gladys-peblar has the same stacking and the same "pause refused
  before the first read after a restart" pattern (`src/app.js`), to check
  separately (reported to Louis by the review).
- **Commands through the manual override only** (`POST /override`, the
  fields in force posted again): start = `state: "active"`, pause =
  `state: "disabled"` (no read, the fields last read kept: review 1), current = `charge_current` with the
  state of the override in force kept (a pause stays a pause, so no "stopped"
  refusal as on Peblar). Never `/config` (`max_current_soft` would be a
  setting written to the flash of the charger), never `DELETE /override`
  (could start a charge through a schedule: Milestone 3, behind the option).
- **The pause is behind `allow_commands` too** (as Peblar's and KEBA's stop):
  with the option off nothing is ever sent. Once allowed it is never held
  back: no fresh read, through a 429/5xx pause, a block, the minute, the
  firmware check, a command in flight (which gives way if not sent yet; the
  pause is sent again after it only if it really left).
- **A 2xx whose answer is not a "done" message** is "sent, without
  confirmation" (the charger received it), never "refused".
- **Energy index**: `total_energy` (kWh, else `watthour` / 1000) is a
  cumulative counter, so an `energy-sensor/index` the core bills, through
  the IndexGuard of gladys-p1-monitor as gladys-hubitat took it (only change:
  `maxKw` a parameter, 25 kW here, slack 0.5 kWh), "Accept the held index" in
  two clicks within 2 minutes bounded to what was shown. The guard state
  (reference, value held, feature id) is in `/data`; a deleted device drops
  it. The docs say to put the charger under the main meter in the Energy
  settings. The session energy stays a plain sensor.
- **`/config` holds secrets** (WiFi, MQTT, emoncms, web passwords): only
  seven named fields are read; the answer is never logged, stored nor kept.
- **No User-Agent, no `X-Requested-With`**: node:http sends neither; the
  firmware asks the latter only for actuators sent by GET, and every command
  here is a POST.
- **401 only is "credentials"**; a 403 is an HTTP refusal (the firmware's
  CSRF answer). No credentials and a 401: "the charger asks for them", the
  same spaced block.
- **One start or current a minute**, a pause never limited.
- **OCPP overlap** with sescandell/gladys-ocpp-integration: said in the docs
  (pick one driver), no code for it.
- **Temperature** on `device-temperature-sensor` (°C, the charger's own
  sensor), `temp` then `temp1`, tenths of a degree.
- **The store validator** (`npx github:GladysAssistant/integration-store .`)
  cannot be run from the agent session: to run by the publication step.
