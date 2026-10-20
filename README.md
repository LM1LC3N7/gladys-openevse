# gladys-openevse

[Gladys Assistant](https://gladysassistant.com) external integration for
**OpenEVSE** EV chargers (ESP32 WiFi firmware 4.x and 5.x) through their
local HTTP API: state, connector and charging state, vehicle plugged in,
power, current, voltage, current offered, energy of the session, energy index
(behind a plausibility guard), temperature, manual override; start, pause and
the charging current behind an off-by-default option. **Never tested with a
real charger. Not affiliated with OpenEVSE.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (OpenEvseApp)
                                  ├─ src/openevse/client.js  /config, /status, /override, parsing (own fields, exact types)
                                  ├─ src/openevse/http.js    the only network access (node:http, bounded)
                                  ├─ src/devices.js          the device and its states (pure)
                                  ├─ src/guard.js            energy index guard (gladys-p1-monitor's, maxKw as a parameter)
                                  ├─ src/publisher.js        states within 300/min
                                  └─ src/store.js            /data/openevse-state.json (pauses, block, index guard; no secret)
```

- **Credentials**: none, or the user name and password of the web interface
  (HTTP Basic, plain HTTP: in clear on the LAN). A 401 blocks the tries for
  15 min, 1 h, then 6 h (kept in `/data`, no secret in it).
- **Reads**: `GET /config` at the start, every hour and when `config_version`
  changes (only `wifi_serial`, `version`, `firmware`, `buildenv`,
  `min_current_hard`, `max_current_hard` are read: the answer also holds the
  charger's own passwords), `GET /status` and `GET /override` every 30 s
  (configurable, 10 s – 10 min). An override that fails never blocks the
  status. Failures retried after 30 s, 1, 2, 5 min, never under the interval;
  429 and 5xx pause, kept in `/data`.
- **Device**: `ext:<selector>:openevse:<wifi_serial>` (lower case), never the
  IP address. Readings on `energy-sensor` (W, A, V), the total energy as an
  `energy-sensor/index` (kWh) through `src/guard.js` (never 0, jumps and
  drops held, never confirmed by time, taken by "Accept the held index" in
  two clicks bounded to what was shown, 25 kW), the session energy and the
  pilot on `electrical-vehicle-charge`, the temperature on
  `device-temperature-sensor`, the connector and the charging state on the
  core's `charging-station` category. No `publishEnergyConsumption`.
- **Commands** (`allow_commands`, off by default): two `button/push` features
  (start, pause) and a `text/select` (6 A to the ceiling), never a switch nor
  a writable binary. All three `POST /override` (firmware 4.0.1, 4.1.2 for the
  current), posting the fields of the override in force again. Start and the
  current read status and override first and decide on that read only, check
  the option again right before sending, leave within 3.5 s of the click or
  are refused unsent, and are answered by 4.3 s; a silence, a 5xx or an
  answer not understood is "sent, without confirmation", followed by reads
  5 s and 20 s later. Start refused without a vehicle or on a fault; one
  start or current a minute. The pause is never held back (no read, one
  request, through a 429/5xx pause, a block, the minute or a command in
  flight, which gives way if not sent yet). A poll read begun before a
  command left is quarantined.
- **Hostile answers**: 64 KB at most, only own fields read with their exact
  type (no prototype pollution; a missing value refuses a command), no answer
  text in the logs, no User-Agent of any kind.

## Credits

The endpoints, their fields, the EVSE states and the override are ported from
[python-openevse-http](https://github.com/firstof9/python-openevse-http)
(firstof9, Apache-2.0, 1.9.0). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Modelled on the sibling
integrations [gladys-peblar](https://github.com/LM1LC3N7/gladys-peblar)
(local HTTP charger, commands) and
[gladys-keba](https://github.com/LM1LC3N7/gladys-keba) (charger commands); the
index guard is the one of
[gladys-p1-monitor](https://github.com/LM1LC3N7/gladys-p1-monitor).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run cover                                   # cover.png, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: the charger is a fake behind the injected
transport, Gladys is the SDK's fake; `test/client.test.js` runs the real
transport against a loopback server.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from an Apache-2.0 project,
credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also shipped in
the Docker image).
