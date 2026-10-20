// -----------------------------------------------------------------------------
// The integration: the OpenEVSE charger typed in the configuration (one IP
// address, optionally the user name and password of its web interface), one
// read of it every poll interval, its Gladys device and states, the energy
// index guard, the transport badge, the "Test the connection" and "Accept the
// held index" buttons, and the three commands (start, pause, charging
// current), refused unless the configuration allows them. index.js only wires
// the SDK handlers to it.
//
// Commands follow the rules of the approved Peblar and KEBA modules:
//   - start and the current are decided on a fresh read of the charger only
//     (status and override), never on the state kept in memory, and refused
//     when a value they need is missing;
//   - the "Allow the commands" option is checked on arrival and again right
//     before sending;
//   - sent within 3.5 s of the click or refused unsent; answered by 4.3 s;
//   - a command that may have reached the charger (silence, a 5xx, an answer
//     not understood) is never answered "not sent": "sent, without
//     confirmation", then spaced reads;
//   - the ack never waits for a publication to Gladys;
//   - one command at a time, never retried; one start or current a minute;
//   - "Pause charging" is never held back: not by a command in flight (it
//     goes at once, the other one gives way if it has not left yet, and the
//     pause is sent once more when it settles), not by the minute, not by a
//     429 or 5xx pause (then one request, no read), not by refused
//     credentials, not by the firmware version; it needs no read at all;
//   - a read that began before the last command was sent may show the state
//     before it: quarantined, never applied nor published.
//
// The energy index (`total_energy`) goes through src/guard.js: never 0, a
// jump or a drop held until the user accepts it in two clicks.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, credentialsKey, normalizeConfig } from './config.js';
import {
  CURRENT,
  FAULT_STATES,
  FEATURES,
  FIRMWARE,
  HOUR,
  INDEX_MAX_KW,
  INDEX_SLACK_KWH,
  OVERRIDE,
  PATHS,
  PRESSED,
  SECOND,
  STATE,
  TIMINGS,
} from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  chargerIds,
  currentBounds,
  deviceName,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
  statusText,
} from './devices.js';
import { IndexGuard } from './guard.js';
import { ERRORS, STATE_NAMES, T, age, summaryOf, word } from './i18n.js';
import {
  OpenEvseClient,
  atLeast,
  errorReason,
  parseConfig,
  parseStatus,
} from './openevse/client.js';
import { ERROR_KINDS } from './openevse/http.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

const both = (en, fr) => ({ en, fr });
const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);
const round3 = (value) => Math.round(value * 1000) / 1000;

/** A pause began in this cycle: it stops at once. */
const PAUSED = 'paused';

/** What the guard of a command compares: the override state and its current. */
const overrideKey = (override) =>
  override ? `${override.state}:${override.chargeCurrent ?? 0}` : undefined;

/** The index Gladys already holds for a feature of a created device, when it says so. */
function lastValueOf(feature) {
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

const versionText = (v) => v.join('.');

const freshCharger = () => ({
  serial: undefined,
  firmware: undefined,
  version: undefined,
  controller: undefined,
  model: undefined,
  minHard: undefined,
  maxHard: undefined,
  configAt: -Infinity,
  configVersion: undefined,
  status: undefined,
  override: undefined,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
  /** The total energy the guard let through, to publish (undefined: nothing). */
  indexValue: undefined,
  /** When the last request that writes left, resends included (a read begun before it is quarantined). */
  lastSentAt: -Infinity,
  /** When the last command of a user left (resends of a pause excluded). */
  lastCommandAt: -Infinity,
  /** Until then, a command not confirmed may still land (a pause sent meanwhile is reaffirmed). */
  unconfirmedUntil: -Infinity,
  /** When the last start or current change left: one a minute. */
  lastCurrentAt: -Infinity,
});

export class OpenEvseApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'openevse' }),
    transport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.client = new OpenEvseClient({ transport, now });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    this.charger = freshCharger();
    this.generation = 0;
    this.started = false;
    this.pausedUntil = 0;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastTestAt = -Infinity;
    /** The command in flight: { role, sentAt, overtaken, again, promise } (a pause aside). */
    this.inFlight = undefined;
    /** `${serial}:override` -> { from, expected, moved, until }: a command sent, not seen yet. */
    this.guards = new Map();
    /** The energy index guard of the created device, and its feature id. */
    this.indexGuard = undefined;
    this.indexFeature = undefined;
    this.savedIndex = undefined;
    this.heldLogged = undefined;
    /** The first click of "Accept the held index": { fingerprint, at, listed: { to, at } }. */
    this.pendingAccept = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    await this.charger.running;
    this.config = normalizeConfig(raw);
    this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
    // A pause survives a restart and a new configuration.
    if (this.memory.pause) {
      this.pausedUntil = Math.max(this.pausedUntil, this.memory.pause.until);
    }
    this.charger = freshCharger();
    this.indexGuard = undefined;
    this.indexFeature = undefined;
    this.savedIndex = undefined;
    this.pendingAccept = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!this.config.address || this.config.badAuth) {
      // The devices already created are shown unreachable.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status()[1]);
    await this.tick();
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    for (const handle of this.charger.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.charger.followUps.clear();
    this.publisher.stop();
  }

  clearTimer() {
    if (this.charger.timer) {
      this.timers.clearTimeout(this.charger.timer);
      this.charger.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badge) and the last states. Pauses, blocks and the guard stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.liftBlockOnNewCredentials(raw);
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.rescheduleOnNewInterval(previous);
    await this.publishAll();
  }

  /** Only a new address or new credentials restart (an interval only reschedules). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalidHost !== this.config.invalidHost ||
      next.badAuth !== this.config.badAuth ||
      credentialsKey(next) !== credentialsKey(this.config)
    );
  }

  /** New credentials saved (or given at a reconnection) lift a block at once. */
  async liftBlockOnNewCredentials(raw) {
    if (credentialsKey(normalizeConfig(raw)) !== credentialsKey(this.config) && this.memory.block) {
      this.memory.block = null;
      await this.saveMemory();
    }
  }

  /** A new interval: the next read follows it, without a restart. */
  rescheduleOnNewInterval(previous) {
    const c = this.charger;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.config.address &&
      !this.config.badAuth &&
      !c.running &&
      c.online !== false
    ) {
      this.schedule();
    }
  }

  /**
   * New address or credentials restart (new credentials lift a block at
   * once); the interval, the option, the ceiling and the language apply at
   * once.
   */
  async configUpdated(raw = {}) {
    await this.liftBlockOnNewCredentials(raw);
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.rescheduleOnNewInterval(previous);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(`OpenEVSE commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (
      this.config.language !== previous.language ||
      this.config.maxCurrent !== previous.maxCurrent ||
      this.config.allowCommands !== previous.allowCommands
    ) {
      await this.publishAll();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  // --- Credentials -----------------------------------------------------------

  get blocked() {
    return Boolean(this.memory.block) && this.now() < this.memory.block.until;
  }

  /** Credentials refused (or asked for): the tries are spaced (15 min, 1 h, 6 h), kept in /data. */
  async authFailed() {
    const failures = (this.memory.block?.failures ?? 0) + 1;
    const wait = TIMINGS.authBackoff[Math.min(failures - 1, TIMINGS.authBackoff.length - 1)];
    this.memory.block = { until: this.now() + wait, failures };
    await this.saveMemory();
    this.logger.warn(
      `OpenEVSE: ${this.config.auth ? 'credentials refused' : 'credentials asked for'}; next try in ${Math.round(wait / 60000)} min`,
    );
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  get paused() {
    return this.now() < this.pausedUntil;
  }

  /**
   * The next read: after a pause or a block (never sooner than the interval),
   * after its backoff, else the interval.
   */
  schedule(delay) {
    const c = this.charger;
    this.clearTimer();
    let wait;
    if (this.paused) {
      wait = Math.max(this.pausedUntil - this.now(), this.interval);
    } else if (this.blocked) {
      wait = Math.max(this.memory.block.until - this.now(), this.interval);
    } else {
      wait = delay ?? (c.online === false ? c.wait : this.interval);
    }
    const generation = this.generation;
    c.timer = this.timers.setTimeout(
      () => {
        c.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch(() => this.logger.error('OpenEVSE refresh failed'));
        }
      },
      Math.max(0, wait ?? this.interval),
    );
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const c = this.charger;
    if (!c.running) {
      c.running = this.run().finally(() => {
        c.running = undefined;
      });
    }
    return c.running;
  }

  async run() {
    const generation = this.generation;
    const c = this.charger;
    if (this.paused || this.blocked) {
      await this.updateStatus();
      this.schedule();
      return;
    }
    let delay;
    try {
      const startedAt = this.now();
      const read = await this.readAll();
      if (generation !== this.generation) {
        return;
      }
      if (startedAt <= c.lastSentAt) {
        // Begun before a command left: it may show the state before it.
        this.logger.debug('OpenEVSE: read begun before a command, not applied');
      } else {
        this.applyRead(read);
        await this.evaluateIndex();
        if (this.memory.block) {
          this.memory.block = null;
          await this.saveMemory();
        }
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      delay = await this.failed(err);
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /**
   * `/config` when due (start, every hour, `config_version` changed), then
   * `/status`, then `/override` (firmware 4.0.1 and later). The override is
   * secondary: its failure (but a 401 or a 429) never blocks the rest.
   */
  async readAll() {
    const c = this.charger;
    const address = this.config.address;
    const auth = this.config.auth;
    const options = { timeoutMs: TIMINGS.readTimeout };
    let config;
    const readConfig = async () => {
      config = parseConfig(await this.client.get(address, auth, PATHS.config, options));
    };
    if (!c.serial || this.now() - c.configAt >= TIMINGS.configRefresh) {
      await readConfig();
    }
    const status = parseStatus(await this.client.get(address, auth, PATHS.status, options));
    if (
      !config &&
      status.configVersion !== undefined &&
      c.configVersion !== undefined &&
      status.configVersion !== c.configVersion
    ) {
      await readConfig();
    }
    let override;
    if (atLeast(config?.version ?? c.version, FIRMWARE.override)) {
      try {
        override = await this.client.override(address, auth, options);
      } catch (err) {
        if (err.kind === ERROR_KINDS.AUTH || err.kind === ERROR_KINDS.RATE_LIMITED) {
          throw err;
        }
        this.logger.warn(`OpenEVSE override: ${errorReason(err)}`);
      }
    }
    return { config, status, override };
  }

  /** A read answered: the charger as read, and the guard it may lift. */
  applyRead({ config, status, override }) {
    const c = this.charger;
    c.online = true;
    c.failures = 0;
    c.wait = undefined;
    if (config) {
      c.configAt = this.now();
      if (!config.serial) {
        c.error = 'no_id';
        return;
      }
      if (c.serial && c.serial !== config.serial) {
        // Another charger answers at this address: the old device is no longer read.
        this.logger.warn('OpenEVSE: another charger answers at this address');
        c.override = undefined;
        c.status = undefined;
        this.indexGuard = undefined;
        this.indexFeature = undefined;
      }
      Object.assign(c, {
        serial: config.serial,
        firmware: config.firmware,
        version: config.version,
        controller: config.controller,
        model: config.model,
        minHard: config.minHard,
        maxHard: config.maxHard,
      });
    }
    if (!c.serial) {
      c.error = 'no_id';
      return;
    }
    c.error = undefined;
    c.configVersion = status.configVersion ?? c.configVersion;
    this.applyLive(status, override);
  }

  /** fromCommand: the fresh read of a command (never reaffirms a pause: it would race it). */
  applyLive(status, override, { fromCommand = false } = {}) {
    const c = this.charger;
    if (status) {
      c.status = status;
    }
    if (override) {
      c.override = override;
      if (c.serial) {
        this.observe(c.serial, override, { fromCommand });
      }
    }
  }

  /** A failed read: the delay before the next one. */
  async failed(err) {
    const c = this.charger;
    const reason = errorReason(err);
    if (err.kind === PAUSED) {
      return undefined;
    }
    if (err.kind === ERROR_KINDS.AUTH) {
      // Not read until new credentials or the end of the block: offline.
      c.online = false;
      await this.authFailed();
      return undefined;
    }
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      // The charger answers: it stays online, the status shows the 429 pause.
      await this.pause(err);
      this.logger.warn(`OpenEVSE: ${reason}, pause`);
      return undefined;
    }
    // Never read again sooner than the interval.
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(c.failures, TIMINGS.backoff.length - 1)],
    );
    c.failures += 1;
    c.online = false;
    c.wait = wait;
    c.error = reason;
    if (err.kind === ERROR_KINDS.HTTP && err.status >= 500) {
      // A 5xx: a pause of the same length, kept in /data.
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
      this.memory.pause = { until: this.pausedUntil, reason: '5xx' };
      await this.saveMemory();
    }
    this.logger.warn(`OpenEVSE: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** A 429: every path waits but a pause of the charge, kept in /data. */
  async pause(err) {
    const wait = Math.min(
      TIMINGS.rateLimitMax,
      Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
    );
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    this.memory.pause = { until: this.pausedUntil, reason: '429' };
    await this.saveMemory();
  }

  pauseMessage() {
    if (!this.paused) {
      return undefined;
    }
    const wait = age(this.pausedUntil - this.now());
    return this.memory.pause?.reason === '5xx' ? T.serverError(wait) : T.rateLimited(wait);
  }

  // --- Energy index ----------------------------------------------------------

  /** The created feature of the energy index of the charger read, else undefined. */
  indexFeatureOf() {
    const c = this.charger;
    if (!c.serial) {
      return undefined;
    }
    const id = chargerIds(this.gladys, c.serial).feature(FEATURES.TOTAL_ENERGY);
    for (const device of this.gladys.devices ?? []) {
      const feature = (device?.features ?? []).find((f) => f.external_id === id);
      if (feature) {
        return feature;
      }
    }
    return undefined;
  }

  /** The guard of the created index feature, built from Gladys and /data when needed. */
  currentIndexGuard() {
    const feature = this.indexFeatureOf();
    if (!feature) {
      return undefined;
    }
    if (!this.indexGuard || this.indexFeature !== feature.external_id) {
      const saved =
        this.memory.index?.featureId === feature.external_id ? this.memory.index : undefined;
      this.indexGuard = new IndexGuard(lastValueOf(feature), saved, this.now(), INDEX_MAX_KW);
      this.indexFeature = feature.external_id;
      this.savedIndex = undefined;
    }
    return this.indexGuard;
  }

  /**
   * The total energy of the last read through the guard: what to publish
   * (the value, or the last one accepted while a value is held), kept in
   * /data when the guard changed. Nothing while the device is not created.
   */
  async evaluateIndex() {
    const c = this.charger;
    const guard = this.currentIndexGuard();
    const total = c.status?.totalEnergy;
    if (!guard || total === undefined) {
      c.indexValue = undefined;
      return;
    }
    const value = round3(total);
    const plausible = guard.accept(value, this.now());
    c.indexValue = plausible ? value : guard.held ? guard.last?.value : undefined;
    const heldKey = guard.held ? `${guard.held.direction}:${guard.held.from}` : undefined;
    if (heldKey && heldKey !== this.heldLogged) {
      this.logger.warn(
        `OpenEVSE energy index ${guard.held.direction === 'down' ? 'drop' : 'jump'} held back: "Accept the held index" takes it`,
      );
    }
    this.heldLogged = heldKey;
    await this.saveIndex();
  }

  async saveIndex() {
    const state = { featureId: this.indexFeature, ...this.indexGuard.state() };
    const key = JSON.stringify([
      state.featureId,
      state.last,
      state.held && {
        direction: state.held.direction,
        from: state.held.from,
        threshold: state.held.threshold,
      },
    ]);
    if (key === this.savedIndex) {
      return;
    }
    this.memory.index = state;
    await this.saveMemory();
    this.savedIndex = key;
  }

  /**
   * The "Accept the held index" action, in two clicks (as gladys-hubitat).
   * The first one only shows the value held and the kWh at stake. A second
   * one within 2 minutes takes it, if the same hold is still there
   * (direction, from, threshold) and the value held now stays within what
   * was shown: for a jump, from the value shown up to it + the margin of the
   * guard since; for a drop, at most it + that margin. Otherwise it is a
   * first click again. Then taken as shown (plus what the charger may draw
   * until its next read, src/guard.js), never anything else.
   */
  async acceptHeldIndex() {
    const guard = this.currentIndexGuard();
    const held = guard?.held;
    if (!held) {
      this.pendingAccept = undefined;
      return T.accept.nothing;
    }
    const fingerprint =
      held.direction === 'down'
        ? `${this.indexFeature}:down:${held.from}`
        : `${this.indexFeature}:up:${held.from}:${held.threshold}`;
    const pending = this.pendingAccept;
    const now = this.now();
    if (
      !pending ||
      pending.fingerprint !== fingerprint ||
      now - pending.at > TIMINGS.acceptConfirm ||
      now < pending.at ||
      !this.withinListed(guard, held, pending.listed, now)
    ) {
      this.pendingAccept = { fingerprint, at: now, listed: { to: held.to, at: now } };
      return T.accept.confirm(held);
    }
    this.pendingAccept = undefined;
    const taken = guard.acceptHeld();
    this.logger.info(
      `OpenEVSE energy index ${taken.direction === 'down' ? 'drop' : 'jump'} from ${taken.from} to ${taken.to} kWh accepted by the user`,
    );
    // Published at the next read, which comes now.
    this.tick().catch(() => this.logger.error('OpenEVSE refresh failed'));
    return T.accept.done(taken);
  }

  /** Whether the value held, at the second click, is still what the first one showed. */
  withinListed(guard, held, listed, now) {
    const top = listed.to + (guard.maxKw * Math.max(0, now - listed.at)) / HOUR + INDEX_SLACK_KWH;
    return held.direction === 'up' ? held.to >= listed.to && held.to <= top : held.to <= top;
  }

  // --- Status ----------------------------------------------------------------

  summary() {
    const c = this.charger;
    const s = c.status;
    return summaryOf(
      {
        name: deviceName(c),
        power: s?.power === undefined ? undefined : Math.round(s.power),
        pilot: s?.pilot,
      },
      statusText(s),
    );
  }

  /** The message with the energy index held back, if any (the user must see it). */
  withHeld(message) {
    const held = this.indexGuard?.held;
    return held ? join(message, T.held(held)) : message;
  }

  /** `[connected, message, plain]`; `plain`: the summary without "Connected". */
  status() {
    const c = this.charger;
    if (!this.config.address) {
      return [false, this.config.invalidHost ? T.invalidHost(this.config.invalidHost) : T.noHost];
    }
    if (this.config.badAuth) {
      return [false, this.config.badAuth === 'invalid' ? T.invalidAuth : T.incompleteAuth];
    }
    const pause = this.pauseMessage();
    if (pause) {
      return [false, this.withHeld(pause)];
    }
    if (this.blocked) {
      const wait = age(this.memory.block.until - this.now());
      return [false, this.withHeld(this.config.auth ? T.authRefused(wait) : T.authAsked(wait))];
    }
    if (c.online === false) {
      const wait = age(c.wait ?? this.interval);
      return [
        false,
        this.withHeld(
          c.error === ERROR_KINDS.UNREACHABLE || c.error === ERROR_KINDS.TIMEOUT
            ? T.unreachable(addressKey(this.config.address), wait)
            : T.failing(c.error ?? 'error', wait),
        ),
      ];
    }
    if (c.online === undefined) {
      return [false, T.connecting];
    }
    if (c.error === 'no_id' || !c.serial) {
      return [false, T.noId];
    }
    let summary = this.summary();
    if (this.config.allowCommands && !atLeast(c.version, FIRMWARE.current)) {
      summary = join(summary, T.oldFirmware);
    }
    summary = this.withHeld(summary);
    return [true, T.connected(summary), summary];
  }

  /** The connection status of the configuration screen. */
  async updateStatus() {
    const [connected, message, plain] = this.status();
    const orphans = this.orphans();
    if (orphans.length === 0) {
      await this.setStatus(connected, message);
      return;
    }
    const names = orphans
      .map((serial) => {
        const device = (this.gladys.devices ?? []).find(
          (d) => d.external_id === chargerIds(this.gladys, serial).device,
        );
        return typeof device?.name === 'string' && device.name !== ''
          ? `${device.name.slice(0, 60)} (${serial})`
          : serial;
      })
      .join(', ');
    // Not connected: the message never starts with "Connected".
    await this.setStatus(false, join(plain ?? message, T.otherCharger(names)));
  }

  // --- Gladys ----------------------------------------------------------------

  /** The charger read with a valid serial, else undefined. */
  known() {
    const c = this.charger;
    return c.serial && c.status ? c : undefined;
  }

  /**
   * The serials of the devices created in Gladys that the charger read is not
   * (another charger at this address, an address changed, or no answer since
   * the start). Empty while a first read is still under way.
   */
  orphans() {
    const c = this.charger;
    if (c.online === undefined && !this.blocked && this.config.address && !this.config.badAuth) {
      return [];
    }
    const serials = [];
    for (const device of this.gladys.devices ?? []) {
      const serial = parseDeviceId(device?.external_id);
      if (
        serial &&
        serial !== c.serial &&
        chargerIds(this.gladys, serial).device === device.external_id
      ) {
        serials.push(serial);
      }
    }
    return serials;
  }

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishDevices() {
    const c = this.known();
    if (!c) {
      return;
    }
    const devices = [
      buildDevice(this.gladys, c, {
        ceiling: this.config.maxCurrent,
        language: this.config.language,
      }),
    ];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    const push = (serial, charger, online) => {
      const states = deviceStates(chargerIds(this.gladys, serial), charger, {
        online,
        language: this.config.language,
        ceiling: this.config.maxCurrent,
        index: charger.indexValue,
      });
      for (const { device_feature_external_id: id, ...value } of states) {
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    };
    const c = this.known();
    if (c) {
      push(c.serial, c, c.online !== false);
    }
    // A created device the charger read is not: unreachable, never left "charging".
    for (const serial of this.orphans()) {
      push(serial, {}, false);
    }
  }

  async publishBadge() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const entries = [];
    const c = this.known();
    if (c && created.has(chargerIds(this.gladys, c.serial).device)) {
      entries.push({
        external_id: chargerIds(this.gladys, c.serial).device,
        transport: c.online === false ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.LOCAL,
      });
    }
    for (const serial of this.orphans()) {
      entries.push({
        external_id: chargerIds(this.gladys, serial).device,
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  /** A device was deleted: its guard is dropped (a new device starts a new index). */
  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id !== 'string') {
      return;
    }
    this.publisher.forget(device.external_id);
    const owned = (id) => typeof id === 'string' && id.startsWith(`${device.external_id}:`);
    if (owned(this.indexFeature)) {
      this.indexGuard = undefined;
      this.indexFeature = undefined;
      this.savedIndex = undefined;
      this.pendingAccept = undefined;
      this.charger.indexValue = undefined;
    }
    if (owned(this.memory.index?.featureId)) {
      this.memory.index = null;
      await this.saveMemory();
    }
  }

  /** The Discovery tab asks for a scan: the device of the last read, sent again. */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------

  async testConnection() {
    if (!this.config.address || this.config.badAuth || this.paused || this.blocked) {
      return this.status()[1];
    }
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      const last = JSON.parse(this.lastStatus ?? '[false,null]')[1];
      return last ? join(T.test.cooldown, last) : T.test.cooldown;
    }
    this.lastTestAt = this.now();
    // A read now (a read in progress is joined).
    await this.tick();
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? T.connecting;
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /**
   * The value of a command, strictly: null, '', ' ', true or 1.5 are never
   * read as a number. Throws a refusal when it is not valid.
   */
  commandValue(role, value) {
    if (role === FEATURES.START || role === FEATURES.PAUSE) {
      if (value === PRESSED || value === String(PRESSED)) {
        return PRESSED;
      }
      throw this.refusal(ERRORS.badButton);
    }
    const amps =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)
          ? Number(value.trim())
          : NaN;
    if (!Number.isInteger(amps)) {
      throw this.refusal(ERRORS.badCurrent);
    }
    if (amps < CURRENT.min || amps > CURRENT.max) {
      throw this.refusal(ERRORS.outOfBounds(CURRENT.min, CURRENT.max));
    }
    return amps;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const wanted = this.commandValue(target.role, value);
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (target.serial !== this.charger.serial) {
      throw this.refusal(ERRORS.unknownCharger);
    }
    const { role } = target;
    const previous = this.inFlight;
    if (previous && role === FEATURES.PAUSE && previous.role === FEATURES.PAUSE) {
      // A pause already under way: this one shares its outcome.
      return previous.promise;
    }
    // One command at a time: a busy charger refuses at once, but a pause is
    // never held back: it goes now, and once more when the other one settles.
    if (previous && role !== FEATURES.PAUSE) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const entry = {
      role,
      sentAt: undefined,
      overtaken: previous?.promise,
      /** The command overtaken: the pause is sent again only if it really left. */
      overtakenEntry: previous,
      again: undefined,
      promise: undefined,
    };
    this.inFlight = entry;
    entry.promise = this.command(target, wanted, received, entry);
    const release = () => {
      if (this.inFlight === entry) {
        this.inFlight = undefined;
      }
    };
    try {
      return await entry.promise;
    } finally {
      // A pause to send again keeps the charger busy until it is done (the
      // ack does not wait for it): a newer start is refused meanwhile.
      if (entry.again) {
        entry.again.finally(release);
      } else {
        release();
      }
    }
  }

  /** The checks before sending, on the latest configuration. */
  checkBeforeSend(generation, serial, role) {
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (generation !== this.generation || this.charger.serial !== serial) {
      throw this.refusal(ERRORS.unknownCharger);
    }
    if (role === FEATURES.PAUSE) {
      // Never held back: not by a 429 pause, a block, the minute nor the firmware.
      return;
    }
    const needed = role === FEATURES.START ? FIRMWARE.override : FIRMWARE.current;
    if (!atLeast(this.charger.version, needed)) {
      throw this.refusal(ERRORS.oldFirmware(versionText(needed)));
    }
    if (this.paused) {
      throw this.refusal(ERRORS.paused(age(this.pausedUntil - this.now())));
    }
    if (this.blocked) {
      throw this.refusal(ERRORS.noCredentials);
    }
    const since = this.now() - this.charger.lastCurrentAt;
    if (since < TIMINGS.currentMinInterval) {
      throw this.refusal(ERRORS.tooOften(age(TIMINGS.currentMinInterval - since)));
    }
  }

  /** A pause arrived after `entry` started: anything but a pause gives way. */
  pauseArrived(entry) {
    return entry.role !== FEATURES.PAUSE && this.inFlight !== entry;
  }

  /**
   * The fresh read of a command within `budget` ms: the override, and the
   * status for a start. Each request gets what is left of the budget.
   */
  async readFresh(role, budget) {
    const until = this.now() + budget;
    const left = () => Math.max(1, until - this.now());
    const address = this.config.address;
    const auth = this.config.auth;
    const status =
      role === FEATURES.START
        ? parseStatus(await this.client.get(address, auth, PATHS.status, { timeoutMs: left() }))
        : undefined;
    if (this.now() >= until) {
      throw Object.assign(new Error('Fresh read too slow'), { kind: ERROR_KINDS.TIMEOUT });
    }
    const override = await this.client.override(address, auth, { timeoutMs: left() });
    return { status, override };
  }

  /**
   * What to send (the override body, and the override it should give), from
   * the fresh read; undefined when it is already so. The fields of the
   * override in force are posted again (python-openevse-http
   * `set_override`): the firmware would clear them otherwise.
   */
  plan(role, wanted, fresh, serial) {
    const from = overrideKey(this.charger.override);
    if (role === FEATURES.PAUSE) {
      // Always sent: one request, no read, nothing to decide.
      return { body: { state: OVERRIDE.DISABLED }, from, expected: `${OVERRIDE.DISABLED}:0` };
    }
    const guarded = this.guardActive(serial);
    const { override } = fresh;
    if (role === FEATURES.START) {
      const { status } = fresh;
      if (status.vehicle === undefined) {
        throw this.refusal(ERRORS.missing);
      }
      if (status.vehicle === 0 || status.state === STATE.NO_EV) {
        throw this.refusal(ERRORS.noVehicle);
      }
      if (FAULT_STATES.has(status.state) || status.state === STATE.UNKNOWN) {
        throw this.refusal(ERRORS.fault(STATE_NAMES[status.state]));
      }
      if (status.state === STATE.CHARGING && override.state !== OVERRIDE.DISABLED && !guarded) {
        return undefined;
      }
      return {
        body: { ...override.fields, state: OVERRIDE.ACTIVE },
        from: overrideKey(override),
        expected: `${OVERRIDE.ACTIVE}:${override.chargeCurrent ?? 0}`,
      };
    }
    const { low, high } = currentBounds(this.charger, this.config.maxCurrent);
    if (wanted < low || wanted > high) {
      throw this.refusal(ERRORS.outOfBounds(low, high));
    }
    if (override.chargeCurrent === wanted && !guarded) {
      return undefined;
    }
    // The state of the override in force is kept: a pause stays a pause.
    return {
      body: {
        ...override.fields,
        ...(override.state === OVERRIDE.NONE ? {} : { state: override.state }),
        charge_current: wanted,
      },
      from: overrideKey(override),
      expected: `${override.state}:${wanted}`,
    };
  }

  async command({ serial, role }, wanted, received, entry) {
    const generation = this.generation;
    const isPause = role === FEATURES.PAUSE;
    const sendBy = received + TIMINGS.commandSendBy;
    const c = this.charger;
    this.checkBeforeSend(generation, serial, role);
    const address = this.config.address;
    const auth = this.config.auth;

    // Start and the current: the state just before acting, never the one in memory.
    let fresh;
    if (!isPause) {
      const budget = Math.min(TIMINGS.commandReadMax, sendBy - TIMINGS.commandMinSend - this.now());
      if (budget < TIMINGS.commandMinRead) {
        throw this.refusal(ERRORS.tooSlow);
      }
      const readStart = this.now();
      try {
        fresh = await this.readFresh(role, budget);
      } catch (err) {
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          await this.pause(err);
          this.updateStatus().catch(() => {});
        }
        throw this.refusal(ERRORS.unknownState(errorReason(err)));
      }
      if (generation !== this.generation) {
        throw this.refusal(ERRORS.unknownCharger);
      }
      // Applied only when no command left during the read.
      if (readStart > c.lastSentAt) {
        this.applyLive(fresh.status, fresh.override, { fromCommand: true });
        // Shown in the background: the ack never waits for Gladys.
        this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
      }
    }

    const plan = this.plan(role, wanted, fresh, serial);
    if (!plan) {
      return;
    }
    // The option may have been turned off during the read: checked again.
    this.checkBeforeSend(generation, serial, role);
    if (this.pauseArrived(entry)) {
      throw this.refusal(ERRORS.pauseMeanwhile);
    }
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    const timeoutMs = Math.max(200, received + TIMINGS.commandAnswerBy - this.now());
    const previousCurrentAt = c.lastCurrentAt;
    c.lastSentAt = this.now();
    c.lastCommandAt = this.now();
    entry.sentAt = this.now();
    if (!isPause) {
      c.lastCurrentAt = this.now();
    }
    this.logger.info(`OpenEVSE: ${role} (override ${plan.expected})`);
    try {
      await this.client.setOverride(address, auth, plan.body, { startBy: sendBy, timeoutMs });
    } catch (err) {
      const reason = errorReason(err);
      this.logger.warn(`OpenEVSE: ${role} failed (${reason})`);
      if (err.kind === ERROR_KINDS.LATE || err.kind === ERROR_KINDS.UNREACHABLE || err.notSent) {
        // Nothing left: the minute between two commands is not spent.
        c.lastCurrentAt = previousCurrentAt;
        throw this.refusal(err.kind === ERROR_KINDS.LATE ? ERRORS.tooSlow : ERRORS.notSent(reason));
      }
      if (err.kind === ERROR_KINDS.RATE_LIMITED) {
        await this.pause(err);
        this.updateStatus().catch(() => {});
        throw this.refusal(ERRORS.refused(reason));
      }
      if (err.kind === ERROR_KINDS.AUTH || (err.kind === ERROR_KINDS.HTTP && err.status < 500)) {
        this.followUp();
        throw this.refusal(ERRORS.refused(reason));
      }
      // A 5xx, a silence, an answer not understood or any other error after
      // the transport started: it may have reached the charger.
      if (!isPause) {
        // It may still land later, even after a pause: a pause sent within
        // the next 90 s is reaffirmed if a read shows the charge allowed again.
        c.unconfirmedUntil = this.now() + TIMINGS.guard;
      }
      this.guard(serial, plan, isPause && this.unconfirmed ? entry.sentAt : undefined);
      this.followUp();
      this.pauseAgain(serial, entry);
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    this.guard(serial, plan, isPause && this.unconfirmed ? entry.sentAt : undefined);
    this.followUp();
    this.pauseAgain(serial, entry);
  }

  /** Sends the pause once more, without a read nor an option check (it was accepted). */
  sendPause() {
    this.charger.lastSentAt = this.now();
    return this.client.setOverride(
      this.config.address,
      this.config.auth,
      { state: OVERRIDE.DISABLED },
      { startBy: Infinity, timeoutMs: TIMINGS.readTimeout },
    );
  }

  /**
   * A pause that overtook a command still in flight (a start or a current
   * may land after it): sent once more when that command settles.
   */
  pauseAgain(serial, entry) {
    if (!entry.overtaken || entry.role !== FEATURES.PAUSE) {
      return;
    }
    // Kept in entry.again: the pause holds the charger (inFlight) until it ends.
    entry.again = entry.overtaken
      .catch(() => {})
      .then(async () => {
        if (entry.overtakenEntry?.sentAt === undefined) {
          // The command overtaken never left (it gave way, or was refused): nothing can land.
          return;
        }
        if (this.charger.lastCommandAt > entry.sentAt) {
          // A newer command really left since this pause: its intent wins.
          this.logger.info('OpenEVSE: pause not sent again (newer command sent)');
          return;
        }
        if (this.charger.serial !== serial) {
          return;
        }
        this.logger.warn('OpenEVSE: pause sent again after the command in flight');
        await this.sendPause();
        this.guard(
          serial,
          { from: overrideKey(this.charger.override), expected: `${OVERRIDE.DISABLED}:0` },
          this.unconfirmed ? entry.sentAt : undefined,
        );
      })
      .catch(async (err) => {
        this.logger.warn(`OpenEVSE: pause again failed (${errorReason(err)})`);
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          await this.pause(err);
          await this.updateStatus();
        }
      })
      .catch(() => {});
  }

  /** Spaced reads after a command: its effect, then a check (each a new read). */
  followUp() {
    const generation = this.generation;
    const c = this.charger;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        c.followUps.delete(handle);
        if (generation === this.generation) {
          // A read under way began before the command: wait for it, then read again.
          Promise.resolve(c.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('OpenEVSE refresh failed'));
        }
      }, delay);
      c.followUps.add(handle);
    }
  }

  // --- Guard -----------------------------------------------------------------------

  /** A command not confirmed may still land on the charger. */
  get unconfirmed() {
    return this.now() < this.charger.unconfirmedUntil;
  }

  /**
   * After a command, until the charger shows it: a new command is always
   * sent, never answered "already so" on a state that may not show the
   * previous one yet. The start state is kept: a read equal to it lifts
   * nothing until a move was seen. `reassertFrom`: a pause sent while another
   * command was not confirmed (the time it left): its guard holds the whole
   * 90 s and reaffirms the pause (see observe).
   */
  guard(serial, plan, reassertFrom) {
    const key = `${serial}:override`;
    const held = this.guards.get(key);
    const pause = plan.expected === `${OVERRIDE.DISABLED}:0`;
    // A pause sent again keeps the reaffirmation of the pause it repeats.
    const keep = held?.reassertFrom !== undefined && pause && this.guardActive(serial);
    this.guards.set(key, {
      from: plan.from,
      expected: plan.expected,
      moved: false,
      until: keep ? held.until : this.now() + TIMINGS.guard,
      reassertFrom: keep ? (reassertFrom ?? held.reassertFrom) : reassertFrom,
      reasserts: keep ? held.reasserts : 0,
    });
  }

  guardActive(serial) {
    const key = `${serial}:override`;
    const guard = this.guards.get(key);
    if (guard && this.now() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /** A read of the override, through the guard. */
  observe(serial, override, { fromCommand = false } = {}) {
    if (!this.guardActive(serial)) {
      return;
    }
    const key = `${serial}:override`;
    const guard = this.guards.get(key);
    const seen = overrideKey(override);
    if (seen !== guard.from) {
      guard.moved = true;
    }
    if (guard.reassertFrom !== undefined) {
      // A pause to reaffirm: the guard holds its 90 s. The charge allowed
      // again while no start nor current left since the pause is a late
      // command landing after it: the pause is sent again, twice at most.
      if (
        override.state !== OVERRIDE.DISABLED &&
        !fromCommand &&
        !(this.inFlight && this.inFlight.role !== FEATURES.PAUSE) &&
        this.charger.lastCurrentAt <= guard.reassertFrom &&
        guard.reasserts < TIMINGS.pauseReasserts
      ) {
        guard.reasserts += 1;
        this.reassertPause(serial);
      }
      return;
    }
    if (guard.moved && seen === guard.expected) {
      this.guards.delete(key);
    }
  }

  /** Sends the pause again (a late command landed after it). No read, no option check. */
  reassertPause(serial) {
    if (this.charger.serial !== serial) {
      return;
    }
    this.logger.warn('OpenEVSE: the charge came back after a pause, pause sent again');
    this.sendPause()
      .then(() => this.followUp())
      .catch(async (err) => {
        this.logger.warn(`OpenEVSE: pause reaffirmed failed (${errorReason(err)})`);
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          await this.pause(err);
        }
      })
      .catch(() => {});
  }
}
