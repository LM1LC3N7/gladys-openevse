// -----------------------------------------------------------------------------
// The OpenEVSE HTTP API, ported from python-openevse-http 1.9.0 (Apache-2.0,
// firstof9/python-openevse-http): `/config`, `/status` and `/override`, the
// fields the library reads from them, its EVSE states, and the override it
// posts to start, pause and set the charging current (the fields of the
// override in force are posted again, so the firmware does not clear them).
// Reads are never retried here (the app spaces its new tries); a command is
// never retried at all (it may have reached the charger).
//
// The answers come from the network: only own fields of a plain object are
// read, each with its exact type (a missing or mistyped value is undefined,
// never a default, so that a command is refused rather than decided on a
// guess). JSON.parse keeps `__proto__` as a plain own key: it never reaches a
// prototype, and it is never read. `/config` also holds the passwords of the
// charger (WiFi, MQTT, emoncms...): only the named fields below are read, the
// answer itself is never kept, logged nor stored.
// -----------------------------------------------------------------------------

import { EVSE_STATES, LIMITS, OVERRIDE, PATHS, STATE, SUCCESS_ANSWERS } from '../constants.js';
import { ChargerError, ERROR_KINDS, request as httpRequest } from './http.js';

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const integer = (value) => (Number.isInteger(value) ? value : undefined);
const plain = (data) => data !== null && typeof data === 'object' && !Array.isArray(data);
const nonNegative = (value) => {
  const n = number(value);
  return n !== undefined && n >= 0 ? n : undefined;
};

/** A short text from the charger, without control characters. */
export function text(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean === '' ? undefined : clean.slice(0, LIMITS.textLength);
}

/** The serial (`wifi_serial`, the MAC of the gateway, "1234567890AB") in lower case. */
export function serialOf(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const serial = value.trim().toLowerCase();
  return /^[0-9a-f]{12}$/.test(serial) ? serial : undefined;
}

/** "4.1.2", "v5.1.0", "4.1.2.dev3" -> [4, 1, 2]; a build name ("master_abc") -> undefined. */
export function versionOf(value) {
  const match = typeof value === 'string' ? /^v?(\d{1,3})\.(\d{1,3})\.(\d{1,3})/.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Whether `version` is at least `min`; an unknown version never is. */
export function atLeast(version, min) {
  if (!version) {
    return false;
  }
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== min[i]) {
      return version[i] > min[i];
    }
  }
  return true;
}

const notObject = () => new ChargerError(ERROR_KINDS.PROTOCOL, 'Not a JSON object');

/** A whole number of amperes usable as a bound (1 to 80 A), else undefined. */
const amperes = (value) =>
  Number.isInteger(value) && value >= 1 && value <= 80 ? value : undefined;

/** GET /config -> identity, firmware versions, hardware bounds. Nothing else is read. */
export function parseConfig(data) {
  if (!plain(data)) {
    throw notObject();
  }
  const gateway = text(own(data, 'version'));
  return {
    serial: serialOf(own(data, 'wifi_serial')),
    firmware: gateway,
    version: versionOf(gateway),
    controller: text(own(data, 'firmware')),
    model: text(own(data, 'buildenv')),
    minHard: amperes(own(data, 'min_current_hard')),
    maxHard: amperes(own(data, 'max_current_hard')),
    /** The charger's own charging current, used when no override sets one (a start). */
    softMax: amperes(own(data, 'max_current_soft')),
  };
}

/** A temperature in tenths of a degree (`false`: no sensor) -> °C, else undefined. */
function tenths(value) {
  const n = number(value);
  return n === undefined || n <= -400 || n >= 2000 ? undefined : Math.round(n) / 10;
}

/** GET /status -> the state of the EVSE and its readings (A, V, W, kWh, °C). */
export function parseStatus(data) {
  if (!plain(data)) {
    throw notObject();
  }
  const code = integer(own(data, 'state'));
  const vehicle = integer(own(data, 'vehicle'));
  const amp = nonNegative(own(data, 'amp'));
  const voltage = nonNegative(own(data, 'voltage'));
  const power = nonNegative(own(data, 'power'));
  // The session in Wh (`session_energy`), else in watt-seconds (older firmware).
  const sessionWh = nonNegative(own(data, 'session_energy'));
  const wattsec = nonNegative(own(data, 'wattsec'));
  // The total in kWh (`total_energy`), else in Wh (`watthour`).
  const totalKwh = nonNegative(own(data, 'total_energy'));
  const watthour = nonNegative(own(data, 'watthour'));
  const temp = tenths(own(data, 'temp')) ?? tenths(own(data, 'temp1'));
  const configVersion = integer(own(data, 'config_version'));
  return {
    state:
      code !== undefined && Object.hasOwn(EVSE_STATES, code) ? EVSE_STATES[code] : STATE.UNKNOWN,
    vehicle: vehicle === 0 || vehicle === 1 ? vehicle : undefined,
    current: amp,
    voltage,
    // The power the charger gives (firmware 4.2.2 and later), else V × A.
    power: power ?? (amp !== undefined && voltage !== undefined ? amp * voltage : undefined),
    pilot: nonNegative(own(data, 'pilot')),
    sessionEnergy:
      sessionWh !== undefined
        ? sessionWh / 1000
        : wattsec !== undefined
          ? wattsec / 3_600_000
          : undefined,
    totalEnergy: totalKwh ?? (watthour === undefined ? undefined : watthour / 1000),
    temperature: temp,
    configVersion,
  };
}

/**
 * GET /override -> the override in force (`state`, `charge_current`...), or
 * `none`. The fields of python-openevse-http's `set_override`, kept with their
 * exact type so that a command posts them back unchanged.
 */
export function parseOverride(data) {
  if (!plain(data)) {
    throw notObject();
  }
  const state = own(data, 'state');
  const fields = {};
  for (const key of ['charge_current', 'max_current', 'energy_limit', 'time_limit']) {
    const value = integer(own(data, key));
    if (value !== undefined && value >= 0 && value <= 1_000_000_000) {
      fields[key] = value;
    }
  }
  const autoRelease = own(data, 'auto_release');
  if (typeof autoRelease === 'boolean') {
    fields.auto_release = autoRelease;
  }
  return {
    state: state === OVERRIDE.ACTIVE || state === OVERRIDE.DISABLED ? state : OVERRIDE.NONE,
    chargeCurrent: fields.charge_current > 0 ? fields.charge_current : undefined,
    fields,
  };
}

export const NO_OVERRIDE = Object.freeze({
  state: OVERRIDE.NONE,
  chargeCurrent: undefined,
  fields: Object.freeze({}),
});

/** Retry-After (seconds or an HTTP date) in ms, else undefined. */
export function retryAfterOf(header, now = Date.now()) {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  if (/^\s*\d+\s*$/.test(value)) {
    return Number(value) * 1000;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The error of a non-2xx answer (the body is never kept: it may echo a secret). */
function statusError(response, now) {
  if (response.status === 429) {
    return new ChargerError(ERROR_KINDS.RATE_LIMITED, 'HTTP 429', {
      status: 429,
      retryAfter: retryAfterOf(response.headers?.['retry-after'], now),
    });
  }
  if (response.status === 401) {
    return new ChargerError(ERROR_KINDS.AUTH, 'HTTP 401', { status: 401 });
  }
  return new ChargerError(ERROR_KINDS.HTTP, `HTTP ${response.status}`, {
    status: response.status,
  });
}

/** The reason of an error for a log or a message: its kind and status, never the answer. */
export function errorReason(err) {
  if (
    err?.kind === ERROR_KINDS.HTTP ||
    err?.kind === ERROR_KINDS.RATE_LIMITED ||
    err?.kind === ERROR_KINDS.AUTH
  ) {
    return `HTTP ${err.status}`;
  }
  return err?.kind ?? 'error';
}

const ok = (response) => response.status >= 200 && response.status <= 299;

function json(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new ChargerError(ERROR_KINDS.PROTOCOL, 'Not JSON');
  }
}

/** The Basic auth header of the web interface credentials, else none. */
const authHeaders = (auth) =>
  auth
    ? {
        Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.password}`, 'utf8').toString('base64')}`,
      }
    : {};

export class OpenEvseClient {
  constructor({ transport = httpRequest, now = Date.now } = {}) {
    this.transport = transport;
    this.now = now;
  }

  async exchange(address, options) {
    const response = await this.transport({ ...address, ...options });
    if (!ok(response)) {
      throw statusError(response, this.now());
    }
    return response;
  }

  /** GET -> the JSON answer. */
  async get(address, auth, path, { timeoutMs }) {
    return json(
      await this.exchange(address, { method: 'GET', path, headers: authHeaders(auth), timeoutMs }),
    );
  }

  /**
   * GET /override -> the override in force. A 404 means none only when the
   * firmware says so (a JSON `msg`): an empty or text 404 (no such route, a
   * proxy) is an error, so a command is never decided on a guessed "none".
   */
  async override(address, auth, { timeoutMs }) {
    const response = await this.transport({
      ...address,
      method: 'GET',
      path: PATHS.override,
      headers: authHeaders(auth),
      timeoutMs,
    });
    if (response.status === 404) {
      let answer;
      try {
        answer = JSON.parse(response.body);
      } catch {
        answer = undefined;
      }
      if (plain(answer) && typeof own(answer, 'msg') === 'string') {
        return NO_OVERRIDE;
      }
    }
    if (!ok(response)) {
      throw statusError(response, this.now());
    }
    return parseOverride(json(response));
  }

  /**
   * POST /override `body`, never retried. `startBy`: refused unsent (LATE)
   * after it. A 2xx whose answer is not one of the "done" messages is
   * PROTOCOL (the charger received it, its outcome is unknown).
   */
  async setOverride(address, auth, body, { startBy, timeoutMs }) {
    if (!plain(body)) {
      throw Object.assign(new Error('Bad override'), { notSent: true });
    }
    if (this.now() > startBy) {
      throw new ChargerError(ERROR_KINDS.LATE, 'Too late to send');
    }
    const response = await this.exchange(address, {
      method: 'POST',
      path: PATHS.override,
      headers: authHeaders(auth),
      body: JSON.stringify(body),
      timeoutMs,
    });
    let answer;
    try {
      answer = JSON.parse(response.body);
    } catch {
      answer = undefined;
    }
    const msg = plain(answer) ? own(answer, 'msg') : undefined;
    if (typeof msg !== 'string' || !SUCCESS_ANSWERS.has(msg)) {
      throw new ChargerError(ERROR_KINDS.PROTOCOL, 'Unexpected answer');
    }
  }
}
