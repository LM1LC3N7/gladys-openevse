# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "pause"   # tests whose name matches
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
index.js                          SDK wiring only: handlers registered before connect()
src/handlers.js                   SDK handlers -> OpenEvseApp (shared with the tests)
src/app.js                        polling, device, states, status, index guard, commands
src/devices.js                    device and states of the charger (pure); feature roles are frozen
src/guard.js                      energy index guard (gladys-p1-monitor's, approved; maxKw a parameter)
src/openevse/client.js            /config, /status, /override, answer parsing (pure parsers)
src/openevse/http.js              one bounded HTTP exchange (node:http), error kinds
src/store.js                      /data/openevse-state.json: pauses, block, index guard; no secret
src/publisher.js                  states to Gladys within 300 per minute
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       English and French runtime texts
scripts/cover.mjs                 cover.png generator (plain Node, no dependency)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (here `wifi_serial`), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates
  a new device and orphans the old one. The same goes for every key users
  store: manifest `config_schema`, `actions`, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log, store or show the user name or the password;
  never keep the body of an HTTP answer (`/config` holds the charger's own
  passwords: read named fields only). A `secret` field is "kept by Gladys in
  its database, never shown again", never "encrypted".
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code: change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. Files are
  UTF-8 without BOM (`test/encoding.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
- **OpenEVSE.** Commands stay behind `allow_commands` (off by default), are
  buttons and a select (never a switch), and all `POST /override` with the
  fields in force posted again. Start and the current are decided on a fresh
  read (status, override), checked again right before sending, one a minute;
  start refused without a vehicle or on a fault; the current keeps the
  override state (a pause stays a pause). "Pause charging" is never held back
  (no read, through a command in flight, the minute, a pause, a block, the
  firmware) and is reaffirmed within 90 s of an unconfirmed command. A read
  begun before a command left is never applied. Refused credentials block the
  tries (15 min, 1 h, 6 h, in `/data`). The total energy is an
  `energy-sensor/index` and only ever goes through `src/guard.js`: keep that
  guard as approved (never 0, jumps and drops held, never confirmed by time,
  two clicks bounded to what was shown).
