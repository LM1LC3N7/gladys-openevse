// -----------------------------------------------------------------------------
// OpenEVSE constants, manifest keys, limits and timings.
//
// An OpenEVSE charger (WiFi gateway on an ESP32, firmware 4.x or 5.x) answers
// a documented HTTP API on port 80, as python-openevse-http (Apache-2.0,
// firstof9/python-openevse-http 1.9.0, the library of Home Assistant's OpenEVSE
// integration) reads it:
//   - `GET /config`: identity (`wifi_serial`), firmware versions, hardware
//     current bounds. It also holds the WiFi, MQTT and other passwords of the
//     charger: only a few named fields are ever read from it;
//   - `GET /status`: EVSE state, vehicle, current, voltage, power, pilot,
//     energies, temperatures;
//   - `GET` / `POST /override`: the manual override (firmware 4.0.1 and
//     later): `state` "active" (charge now) or "disabled" (paused), and
//     `charge_current` (firmware 4.1.2 and later for the current).
// Optional HTTP Basic auth (the user name and password of the web interface).
// The older RAPI commands (`/r`, firmware 2.x and 3.x) are not used.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 80;

export const PATHS = {
  status: '/status',
  config: '/config',
  override: '/override',
};

/** The gateway firmware a command needs (python-openevse-http `_version_check`). */
export const FIRMWARE = {
  override: [4, 0, 1],
  current: [4, 1, 2],
};

/**
 * The charging current, in whole amperes: never below 6 A (IEC 61851, the
 * lowest current a vehicle accepts) nor the hardware minimum of the charger,
 * never above the ceiling of the configuration (16 A by default, 80 A at
 * most) nor the hardware maximum read from the charger.
 */
export const CURRENT = {
  min: 6,
  max: 80,
  defaultCeiling: 16,
};

/** The EVSE states of `/status` (python-openevse-http `states`), as our names. */
export const EVSE_STATES = {
  0: 'unknown',
  1: 'no_ev',
  2: 'connected',
  3: 'charging',
  4: 'vent_required',
  5: 'diode_check',
  6: 'gfci_fault',
  7: 'no_ground',
  8: 'stuck_relay',
  9: 'gfci_self_test',
  10: 'over_temperature',
  254: 'sleeping',
  255: 'disabled',
};

/** Our states: the EVSE states, plus `offline` (no answer). */
export const STATE = {
  UNKNOWN: 'unknown',
  NO_EV: 'no_ev',
  CONNECTED: 'connected',
  CHARGING: 'charging',
  VENT_REQUIRED: 'vent_required',
  DIODE_CHECK: 'diode_check',
  GFCI_FAULT: 'gfci_fault',
  NO_GROUND: 'no_ground',
  STUCK_RELAY: 'stuck_relay',
  GFCI_SELF_TEST: 'gfci_self_test',
  OVER_TEMPERATURE: 'over_temperature',
  SLEEPING: 'sleeping',
  DISABLED: 'disabled',
  OFFLINE: 'offline',
};

/** The error states of the EVSE (4 to 10): never a start on them. */
export const FAULT_STATES = new Set([
  STATE.VENT_REQUIRED,
  STATE.DIODE_CHECK,
  STATE.GFCI_FAULT,
  STATE.NO_GROUND,
  STATE.STUCK_RELAY,
  STATE.GFCI_SELF_TEST,
  STATE.OVER_TEMPERATURE,
]);

/** The override states (`/override`), plus `none` (no override: the charger decides). */
export const OVERRIDE = {
  ACTIVE: 'active',
  DISABLED: 'disabled',
  NONE: 'none',
};

/** The answers of a command that mean "done" (python-openevse-http SUCCESS_ANSWERS). */
export const SUCCESS_ANSWERS = new Set([
  'OK',
  'done',
  'no change',
  'Created',
  'Updated',
  'Deleted',
]);

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  STATUS: 'status',
  CONNECTOR: 'connector-status',
  CHARGING_STATE: 'charging-state',
  PLUGGED: 'plugged',
  POWER: 'power',
  CURRENT: 'current',
  VOLTAGE: 'voltage',
  PILOT: 'pilot',
  SESSION_ENERGY: 'session-energy',
  TOTAL_ENERGY: 'total-energy',
  TEMPERATURE: 'temperature',
  OVERRIDE: 'override',
  ERROR: 'error',
  START: 'start-charge',
  PAUSE: 'pause-charge',
  SET_CURRENT: 'set-current',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  ACCEPT_HELD_INDEX: 'accept_held_index',
};

/** The value a `button/push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 10,
  max: 600,
  default: 30,
};

/**
 * The energy index guard (src/guard.js): the most a charger may draw on
 * average between two reads (80 A at 240 V is 19.2 kW, three-phase builds
 * 22 kW), and the kWh always accepted on top (rounding, a late read).
 */
export const INDEX_MAX_KW = 25;
export const INDEX_SLACK_KWH = 0.5;

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** `/config` is a few KB, `/status` about 2 KB. */
  responseBytes: 64 * 1024,
  /** Longest text kept from an answer (firmware, model). */
  textLength: 60,
  /** User name and password of the web interface: printable ASCII, bounded. */
  secretMin: 1,
  secretMax: 256,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request of the polling (a LAN charger answers in well under 1 s). */
  readTimeout: 5 * SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** 429: Retry-After bounded to 1 min .. 6 h, 5 min without. A 5xx pauses as a failed read. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 5 * MINUTE,
  /** User name and password refused: new tries 15 min, 1 h, then every 6 h (kept in /data). */
  authBackoff: [15 * MINUTE, HOUR, 6 * HOUR],
  /** `/config` (identity, bounds): at the start, every hour, and when `config_version` changes. */
  configRefresh: HOUR,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button reads the charger at most this often. */
  testCooldown: 10 * SECOND,
  /** "Accept the held index": the second click must come within this delay of the first. */
  acceptConfirm: 2 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the fresh read and the command
   * must leave by 3.5 s after the click, or the command is refused unsent;
   * the answer is awaited until 4.3 s, after which the command is "sent,
   * without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The fresh read of a command (status and override): 1.5 s at most, 0.3 s left to send. */
  commandReadMax: 1_500,
  commandMinRead: 300,
  commandMinSend: 300,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until the override shows what it asked, or 90 s. */
  guard: 90 * SECOND,
  /** A pause reaffirmed at most this often while its guard holds (a late command landing after it). */
  pauseReasserts: 2,
  /** One start or current change a minute; a pause is never limited. */
  currentMinInterval: MINUTE,
};
