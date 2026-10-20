// -----------------------------------------------------------------------------
// The charger -> one Gladys device and its states (pure).
//
// `ext:<selector>:openevse:<serial>`: one device per charger, keyed by the
// serial of its WiFi gateway (`wifi_serial` of `/config`, its MAC address, in
// lower case), never by its IP address (it may change). The feature roles
// (the last part of their external ids) are published forever: never rename
// them. Every role is always built, so a republished device never loses a
// feature.
//
// No switch, no writable binary: a "turn everything off" (Google Home, Alexa,
// HomeKit, MCP, `switch.*` scenes) must never reach a charge command.
// Starting and pausing are two `button/push` features, the charging current
// a `text/select` of the whole amperes from the minimum to the ceiling. Start
// and the current refuse unless the configuration allows the commands; the
// pause too, but it is never held back otherwise (src/app.js).
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): W, A, V and kWh on `energy-sensor`,
// A and kWh on `electrical-vehicle-charge`, °C on
// `device-temperature-sensor`. The total energy of the charger is a
// cumulative counter: an `energy-sensor/index` the core turns into
// consumption, so it only ever goes through the guard of src/guard.js (never
// 0, jumps and drops held). The energy of the session is a plain sensor.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { CURRENT, FAULT_STATES, FEATURES, OVERRIDE, STATE } from './constants.js';
import { FEATURE_NAMES, OVERRIDE_NAMES, STATE_NAMES, word } from './i18n.js';

/** CHARGING_STATION_CONNECTOR_STATUS of the core (server/utils/constants.js). */
export const CONNECTOR_STATUS = {
  AVAILABLE: 0,
  OCCUPIED: 1,
  RESERVED: 2,
  UNAVAILABLE: 3,
  FAULTED: 4,
};

/** CHARGING_STATION_CHARGING_STATE of the core (OCPP 2.0.1 chargingState). */
export const CHARGING_STATE = {
  CHARGING: 0,
  EV_CONNECTED: 1,
  PAUSED_BY_VEHICLE: 2,
  PAUSED_BY_CHARGER: 3,
  IDLE: 4,
  DISCHARGING: 5,
};

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0 });

/** The features, by role, in display order (set-current gets its options in buildDevice). */
export const DEFINITIONS = {
  [FEATURES.STATUS]: text,
  [FEATURES.CONNECTOR]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CONNECTOR_STATUS,
    min: 0,
    max: 4,
  }),
  [FEATURES.CHARGING_STATE]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CHARGING_STATE,
    min: 0,
    max: 5,
  }),
  [FEATURES.PLUGGED]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.PLUGGED,
    min: 0,
    max: 1,
  }),
  [FEATURES.POWER]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.POWER,
    unit: U.WATT,
    min: 0,
    max: 50_000,
  }),
  [FEATURES.CURRENT]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.CURRENT,
    unit: U.AMPERE,
    min: 0,
    max: 100,
  }),
  [FEATURES.VOLTAGE]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.VOLTAGE,
    unit: U.VOLT,
    min: 0,
    max: 500,
  }),
  [FEATURES.PILOT]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.TARGET_CURRENT,
    unit: U.AMPERE,
    min: 0,
    max: 100,
  }),
  [FEATURES.SESSION_ENERGY]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.LAST_CHARGE_ENERGY_ADDED,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 1000,
  }),
  [FEATURES.TOTAL_ENERGY]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.INDEX,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 10_000_000,
  }),
  [FEATURES.TEMPERATURE]: sensor({
    category: C.DEVICE_TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -40,
    max: 150,
  }),
  [FEATURES.OVERRIDE]: text,
  [FEATURES.ERROR]: sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 }),
  [FEATURES.START]: button,
  [FEATURES.PAUSE]: button,
  [FEATURES.SET_CURRENT]: {
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    read_only: false,
    has_feedback: true,
    keep_history: false,
  },
};

export const ROLES = Object.keys(DEFINITIONS);
export const COMMAND_ROLES = [FEATURES.START, FEATURES.PAUSE, FEATURES.SET_CURRENT];

export const chargerIds = (gladys, serial) => gladys.externalIds('openevse', serial);

const SERIAL = '[0-9a-f]{12}';

/** The serial and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = new RegExp(`:openevse:(${SERIAL}):([a-z0-9-]+)$`).exec(externalId);
  return match && ROLES.includes(match[2]) ? { serial: match[1], role: match[2] } : undefined;
}

/** The serial of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = new RegExp(`:openevse:(${SERIAL})$`).exec(String(externalId ?? ''));
  return match ? match[1] : undefined;
}

/** The whole amperes a current command accepts: `{ low, high }` (high below low: none). */
export function currentBounds(charger, ceiling) {
  return {
    low: Math.max(CURRENT.min, charger?.minHard ?? CURRENT.min),
    high: Math.min(ceiling, charger?.maxHard ?? CURRENT.max),
  };
}

export function currentOptions({ low, high }) {
  const options = [];
  for (let amps = low; amps <= high; amps += 1) {
    options.push({ value: String(amps), label: `${amps} A`, sort_order: amps - low });
  }
  return options;
}

export const deviceName = (charger) => `OpenEVSE ${charger.serial.slice(-4).toUpperCase()}`;

/**
 * The Gladys device of the charger. `ceiling`: the current ceiling of the
 * configuration (the select is only an offer: the command checks the bounds
 * again, on the state read just before sending).
 */
export function buildDevice(gladys, charger, { ceiling, language }) {
  const ids = chargerIds(gladys, charger.serial);
  const params = [{ name: 'serial_number', value: charger.serial }];
  if (charger.firmware) {
    params.push({ name: 'firmware', value: charger.firmware });
  }
  if (charger.controller) {
    params.push({ name: 'controller_firmware', value: charger.controller });
  }
  return {
    name: deviceName(charger),
    external_id: ids.device,
    model: charger.model ?? 'OpenEVSE',
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
      ...(role === FEATURES.SET_CURRENT
        ? { supported_options: currentOptions(currentBounds(charger, ceiling)) }
        : {}),
    })),
    params,
  };
}

/** Paused: by the override, or the EVSE asleep or disabled (a schedule, another app). */
export const paused = (status, override) =>
  override?.state === OVERRIDE.DISABLED ||
  status?.state === STATE.SLEEPING ||
  status?.state === STATE.DISABLED;

/** The connector, as the core's charging-station category reads it (undefined: unknown). */
export function connectorOf(status) {
  if (status?.state === STATE.OFFLINE) {
    return CONNECTOR_STATUS.UNAVAILABLE;
  }
  if (FAULT_STATES.has(status?.state)) {
    return CONNECTOR_STATUS.FAULTED;
  }
  if (status?.state === STATE.DISABLED) {
    return CONNECTOR_STATUS.UNAVAILABLE;
  }
  if (status?.vehicle === 1 || status?.state === STATE.CHARGING) {
    return CONNECTOR_STATUS.OCCUPIED;
  }
  if (status?.vehicle === 0) {
    return CONNECTOR_STATUS.AVAILABLE;
  }
  return undefined;
}

/**
 * The charging state (OCPP's chargingState). No vehicle or a fault: IDLE, so
 * a scene never keeps reading "charging" after the car left.
 */
export function chargingStateOf(status, override) {
  if (status?.state === STATE.CHARGING) {
    return CHARGING_STATE.CHARGING;
  }
  if (FAULT_STATES.has(status?.state) || status?.vehicle === 0) {
    return CHARGING_STATE.IDLE;
  }
  if (status?.vehicle === 1) {
    return paused(status, override)
      ? CHARGING_STATE.PAUSED_BY_CHARGER
      : CHARGING_STATE.EV_CONNECTED;
  }
  return undefined;
}

/** The text of the status feature. */
export function statusText(status) {
  if (status?.vehicle === 1 && status.state === STATE.SLEEPING) {
    return STATE_NAMES.pausedPlugged;
  }
  return STATE_NAMES[status?.state] ?? STATE_NAMES[STATE.UNKNOWN];
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * The current values of the charger's device. Offline: only the status and
 * the connector (Gladys keeps the last value of the others). `index`: the
 * total energy the guard let through (undefined: nothing to publish).
 */
export function deviceStates(ids, charger, { online, language, ceiling, index }) {
  if (!online) {
    return [
      { role: FEATURES.STATUS, text: word(STATE_NAMES[STATE.OFFLINE], language) },
      { role: FEATURES.CONNECTOR, state: CONNECTOR_STATUS.UNAVAILABLE },
    ].map(({ role, ...value }) => ({ device_feature_external_id: ids.feature(role), ...value }));
  }
  const states = [];
  // A value outside the bounds of its feature is dropped (Gladys keeps the last one).
  const add = (role, value) => {
    const { min, max } = DEFINITIONS[role];
    if (value !== undefined && Number.isFinite(value) && value >= min && value <= max) {
      states.push({ role, state: value });
    }
  };
  const s = charger.status;
  const o = charger.override;
  if (s) {
    states.push({ role: FEATURES.STATUS, text: word(statusText(s), language) });
    add(FEATURES.CONNECTOR, connectorOf(s));
    add(FEATURES.CHARGING_STATE, chargingStateOf(s, o));
    if (s.vehicle !== undefined) add(FEATURES.PLUGGED, s.vehicle);
    if (s.power !== undefined) add(FEATURES.POWER, Math.round(s.power));
    if (s.current !== undefined) add(FEATURES.CURRENT, round(s.current, 2));
    if (s.voltage !== undefined) add(FEATURES.VOLTAGE, Math.round(s.voltage));
    if (s.pilot !== undefined) add(FEATURES.PILOT, round(s.pilot, 1));
    if (s.sessionEnergy !== undefined) add(FEATURES.SESSION_ENERGY, round(s.sessionEnergy, 3));
    if (s.temperature !== undefined) add(FEATURES.TEMPERATURE, s.temperature);
    if (s.state !== STATE.UNKNOWN) add(FEATURES.ERROR, FAULT_STATES.has(s.state) ? 1 : 0);
  }
  // Never 0, never a value the guard held back.
  if (index !== undefined && index > 0) add(FEATURES.TOTAL_ENERGY, index);
  if (o) {
    states.push({ role: FEATURES.OVERRIDE, text: word(OVERRIDE_NAMES[o.state], language) });
    // The select shows the override current when it is one of its options.
    const { low, high } = currentBounds(charger, ceiling);
    if (o.chargeCurrent !== undefined && o.chargeCurrent >= low && o.chargeCurrent <= high) {
      states.push({ role: FEATURES.SET_CURRENT, text: String(o.chargeCurrent) });
    }
  }
  return states.map(({ role, ...value }) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
