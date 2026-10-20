// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake charger behind the transport. Timers and Date are mocked:
// the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { OpenEvseApp } from '../src/app.js';
import { ACTIONS, HOUR, MINUTE, SECOND } from '../src/constants.js';
import { CHARGING_STATE, CONNECTOR_STATUS } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  HOST,
  NOW,
  PASSWORD,
  SERIAL,
  USER,
  config,
  fakeCharger,
  settle,
  status,
} from './fixtures/fakeOpenevse.js';

const CONFIG = { host: HOST };
const ALLOWED = { ...CONFIG, allow_commands: true };
const DEVICE = `ext:test-integration:openevse:${SERIAL}`;
const feature = (role) => `${DEVICE}:${role}`;
const SECRETS = [
  PASSWORD,
  'wifi-secret-123',
  'web-secret-456',
  'mqtt-secret-789',
  'emon-secret-000',
];

async function setup(
  t,
  {
    config: cfg = CONFIG,
    server = fakeCharger(),
    store = memoryStore(),
    create = true,
    logs = [],
  } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config: cfg });
  const app = new OpenEvseApp({
    gladys,
    logger: recorder(logs),
    transport: server.transport,
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms, step = SECOND) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
  }
  const target = (role) => {
    const device = gladys.fake.devices.find((d) => d.external_id === DEVICE);
    return [device, device.features.find((f) => f.external_id === feature(role))];
  };
  const press = async (role, value = 1, wait = 5 * SECOND) => {
    const ack = gladys.fake.setValue(...target(role), value);
    await settle();
    await advance(wait, 100);
    return ack;
  };
  return { gladys, app, server, store, advance, logs, press, target, charger: server.charger };
}

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

const last = (gladys, role) => gladys.fake.lastState(feature(role));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const deviceOf = (gladys) => gladys.fake.discoveredDevices.at(-1);

/** No secret anywhere a user or a log reader may see. */
function assertNoSecret({ gladys, logs, store }) {
  const seen = JSON.stringify([
    logs,
    gladys.fake.connectionStatus,
    store.data,
    gladys.fake.discoveredDevices,
  ]);
  for (const secret of SECRETS) {
    assert.ok(!seen.includes(secret), `a secret leaked: ${secret.slice(0, 3)}…`);
  }
  for (const id of gladys.fake.devices.flatMap((d) => d.features.map((f) => f.external_id))) {
    const value = JSON.stringify(gladys.fake.lastState(id) ?? null);
    assert.ok(SECRETS.every((s) => !value.includes(s)));
  }
}

test('without an address, the status asks for it and nothing is requested', async (t) => {
  const server = fakeCharger();
  const { gladys } = await setup(t, { config: {}, server });
  assert.equal(server.requests.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /adresse IP/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /IP address/);
  assert.equal(server.requests.length, 0);
});

test('a user name without a password: asked for both, nothing requested', async (t) => {
  const server = fakeCharger();
  const { gladys } = await setup(t, { config: { host: HOST, username: USER }, server });
  assert.equal(server.requests.length, 0);
  assert.match(message(gladys).fr, /à la fois le nom d'utilisateur et le mot de passe/);
});

test('one read: the device, its features, then its states', async (t) => {
  const ctx = await setup(t);
  const { gladys, server, advance } = ctx;
  assert.deepEqual(server.paths().slice(0, 3), ['GET /config', 'GET /status', 'GET /override']);
  assert.ok(server.requests.every((r) => r.port === 80 && !r.headers.Authorization));
  assert.ok(
    server.requests.every((r) => !('User-Agent' in r.headers)),
    'no User-Agent',
  );
  const device = deviceOf(gladys);
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, 'OpenEVSE 90AB');
  assert.equal(device.model, 'openevse_wifi_v1');
  assert.deepEqual(device.params, [
    { name: 'serial_number', value: SERIAL },
    { name: 'firmware', value: '5.1.2' },
    { name: 'controller_firmware', value: '8.2.2' },
  ]);
  const roles = device.features.map((f) => [
    f.external_id.slice(DEVICE.length + 1),
    f.category,
    f.type,
    f.unit,
    f.read_only,
  ]);
  assert.deepEqual(roles, [
    ['status', 'text', 'text', undefined, true],
    ['connector-status', 'charging-station', 'connector-status', undefined, true],
    ['charging-state', 'charging-station', 'charging-state', undefined, true],
    ['plugged', 'electrical-vehicle-charge', 'plugged', undefined, true],
    ['power', 'energy-sensor', 'power', 'watt', true],
    ['current', 'energy-sensor', 'current', 'ampere', true],
    ['voltage', 'energy-sensor', 'voltage', 'volt', true],
    ['pilot', 'electrical-vehicle-charge', 'target-current', 'ampere', true],
    [
      'session-energy',
      'electrical-vehicle-charge',
      'last-charge-energy-added',
      'kilowatt-hour',
      true,
    ],
    ['total-energy', 'energy-sensor', 'index', 'kilowatt-hour', true],
    ['temperature', 'device-temperature-sensor', 'decimal', 'celsius', true],
    ['override', 'text', 'text', undefined, true],
    ['error', 'unknown', 'binary', undefined, true],
    ['start-charge', 'button', 'push', undefined, false],
    ['pause-charge', 'button', 'push', undefined, false],
    ['set-current', 'text', 'select', undefined, false],
  ]);
  assert.ok(
    device.features.every((f) => f.category !== 'switch'),
    'never a switch',
  );
  const select = device.features.at(-1);
  assert.deepEqual(
    [select.supported_options[0].value, select.supported_options.at(-1).value],
    ['6', '16'],
    'the default ceiling is 16 A',
  );

  assert.equal(last(gladys, 'status'), 'En charge');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.OCCUPIED);
  assert.equal(last(gladys, 'charging-state'), CHARGING_STATE.CHARGING);
  assert.equal(last(gladys, 'plugged'), 1);
  assert.equal(last(gladys, 'power'), 3680);
  assert.equal(last(gladys, 'current'), 16);
  assert.equal(last(gladys, 'voltage'), 230);
  assert.equal(last(gladys, 'pilot'), 16);
  assert.equal(last(gladys, 'session-energy'), 4.5);
  assert.equal(last(gladys, 'temperature'), 31.2);
  assert.equal(last(gladys, 'override'), 'Aucun (la borne décide)');
  assert.equal(last(gladys, 'error'), 0);
  assert.equal(last(gladys, 'total-energy'), undefined, 'the index waits for the next read');
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'total-energy'), 1234.567);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).fr, /OpenEVSE 90AB : En charge, 3680 W, 16 A proposés/);
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: DEVICE,
    transport: DEVICE_TRANSPORTS.LOCAL,
  });
  assertNoSecret(ctx);
});

test('with a user name and a password: Basic auth on every request, never shown', async (t) => {
  const server = fakeCharger({ auth: { user: USER, password: PASSWORD } });
  const ctx = await setup(t, {
    server,
    config: { host: HOST, username: USER, password: PASSWORD },
  });
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.ok(server.requests.every((r) => r.headers.Authorization.startsWith('Basic ')));
  assertNoSecret(ctx);
});

test('credentials asked for or refused: blocked, kept in /data, tried 15 min then 1 h later', async (t) => {
  const store = memoryStore();
  const server = fakeCharger({ auth: { user: USER, password: 'other' } });
  const logs = [];
  const ctx = await setup(t, {
    server,
    store,
    logs,
    config: { host: HOST, username: USER, password: PASSWORD },
  });
  const { gladys, advance } = ctx;
  assert.equal(server.requests.length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /refusé le nom d'utilisateur et le mot de passe/);
  assert.ok(store.data.block.until > NOW);
  await advance(14 * MINUTE, 30 * SECOND);
  assert.equal(server.requests.length, 1, 'no try during the block');
  await advance(MINUTE, 30 * SECOND);
  assert.equal(server.requests.length, 2);
  await advance(59 * MINUTE, MINUTE);
  assert.equal(server.requests.length, 2);
  await advance(2 * MINUTE, MINUTE);
  assert.equal(server.requests.length, 3);
  assertNoSecret(ctx);
});

test('a block survives a restart; new credentials lift it at once', async (t) => {
  const store = memoryStore({ block: { until: NOW + HOUR, failures: 2 } });
  const server = fakeCharger({ auth: { user: USER, password: PASSWORD } });
  const { gladys, app } = await setup(t, { server, store });
  assert.equal(server.requests.length, 0, 'never a request before the end of the block');
  assert.match(message(gladys).fr, /demande un nom d'utilisateur/);
  await app.configUpdated({ host: HOST, username: USER, password: PASSWORD });
  await settle();
  assert.equal(store.data.block, null);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('EVSE states: no vehicle, waiting, paused, faults, unknown', async (t) => {
  const { gladys, advance, charger } = await setup(t);
  const cases = [
    [
      { state: 1, vehicle: 0 },
      'Aucun véhicule',
      CONNECTOR_STATUS.AVAILABLE,
      CHARGING_STATE.IDLE,
      0,
    ],
    [{ state: 2, vehicle: 1 }, 'Véhicule branché, en attente', 1, CHARGING_STATE.EV_CONNECTED, 1],
    [
      { state: 254, vehicle: 1 },
      'Véhicule branché, charge en pause',
      1,
      CHARGING_STATE.PAUSED_BY_CHARGER,
      1,
    ],
    [{ state: 7, vehicle: 1 }, 'Défaut : pas de terre', CONNECTOR_STATUS.FAULTED, 4, 1],
  ];
  for (const [over, text, connector, charging, plugged] of cases) {
    charger.status = status(over);
    await advance(30 * SECOND);
    assert.equal(last(gladys, 'status'), text);
    assert.equal(last(gladys, 'connector-status'), connector, text);
    assert.equal(last(gladys, 'charging-state'), charging, text);
    assert.equal(last(gladys, 'plugged'), plugged, text);
  }
  assert.equal(last(gladys, 'error'), 1);
  charger.status = status({ state: 99 });
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'status'), 'État inconnu');
});

test('unreachable: offline states, badge, spaced new tries', async (t) => {
  const { gladys, server, advance, charger } = await setup(t);
  charger.down = true;
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'status'), 'Borne injoignable');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.UNAVAILABLE);
  assert.equal(last(gladys, 'power'), 3680, 'the last power is kept');
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  assert.match(message(gladys).en, /No answer from 192\.168\.1\.70/);
  const before = server.requests.length;
  await advance(29 * SECOND);
  assert.equal(server.requests.length, before, 'never sooner than the interval');
  await advance(SECOND);
  assert.equal(server.requests.length, before + 1);
});

test('an override that fails never blocks the status', async (t) => {
  const server = fakeCharger();
  server.charger.statuses['GET /override'] = 500;
  const { gladys } = await setup(t, { server });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(last(gladys, 'status'), 'En charge');
  assert.equal(last(gladys, 'override'), undefined);
});

test('an old firmware without a serial: refused, explained', async (t) => {
  const server = fakeCharger({ config: config({ wifi_serial: undefined, version: '3.3.1' }) });
  const { gladys } = await setup(t, { server });
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  assert.match(message(gladys).fr, /firmware WiFi OpenEVSE 4\.0/);
});

test('429: a pause on every path but the pause of the charge, kept in /data', async (t) => {
  const server = fakeCharger();
  const store = memoryStore();
  const { gladys, app, advance, charger, press } = await setup(t, {
    server,
    store,
    config: ALLOWED,
  });
  charger.statuses['/status'] = 429;
  charger.headers = { 'retry-after': '600' };
  await advance(30 * SECOND);
  assert.equal(store.data.pause.reason, '429');
  delete charger.statuses['/status'];
  const before = server.requests.length;
  await app.connected({ ...ALLOWED });
  await advance(5 * MINUTE, 30 * SECOND);
  assert.equal(server.requests.length, before, 'no read during the pause');
  let ack = await press('set-current', '10');
  assert.equal(ack.success, false);
  assert.match(ack.error, /ralentir/);
  assert.match(message(gladys).fr, /HTTP 429/);
  ack = await press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.paths().slice(before), ['POST /override'], 'one request, no read');
  assert.deepEqual(server.posts(), [{ state: 'disabled' }]);
});

test('5xx: a pause kept in /data, never shorter than the interval', async (t) => {
  const server = fakeCharger();
  const store = memoryStore();
  const { advance, charger } = await setup(t, { server, store });
  charger.statuses['/status'] = 503;
  await advance(30 * SECOND);
  assert.equal(store.data.pause.reason, '5xx');
  assert.ok(store.data.pause.until >= NOW + 60 * SECOND);
});

test('commands are refused while not allowed, and nothing is sent', async (t) => {
  const { server, press } = await setup(t);
  for (const [role, value] of [
    ['start-charge', 1],
    ['pause-charge', 1],
    ['set-current', '10'],
  ]) {
    const ack = await press(role, value);
    assert.equal(ack.success, false, role);
    assert.match(ack.error, /Autoriser les commandes/);
  }
  assert.deepEqual(server.posts(), []);
});

test('pause: one POST, no read, never limited to one a minute', async (t) => {
  const { server, press, gladys, advance } = await setup(t, { config: ALLOWED });
  const before = server.requests.length;
  let ack = await press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.paths()[before], 'POST /override');
  assert.deepEqual(server.posts(), [{ state: 'disabled' }]);
  await advance(20 * SECOND);
  assert.equal(last(gladys, 'override'), 'Charge en pause');
  assert.equal(last(gladys, 'status'), 'Véhicule branché, charge en pause');
  ack = await press('pause-charge');
  assert.equal(ack.success, true);
  assert.equal(server.posts().length, 2, 'a pause is always sent');
});

test('start: refused without a vehicle or on a fault; sent with the fields in force', async (t) => {
  const { server, press, charger } = await setup(t, { config: ALLOWED });
  charger.status = status({ state: 1, vehicle: 0 });
  let ack = await press('start-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Aucun véhicule/);
  charger.status = status({ state: 6, vehicle: 1 });
  ack = await press('start-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /fuite à la terre/);
  charger.status = status({ state: 254, vehicle: 1 });
  charger.override = { state: 'disabled', charge_current: 10, auto_release: true };
  ack = await press('start-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.posts(), [{ charge_current: 10, auto_release: true, state: 'active' }]);
});

test('start and current refused on a firmware older than they need', async (t) => {
  const server = fakeCharger({ config: config({ version: '4.0.1' }) });
  const { press, gladys } = await setup(t, { server, config: ALLOWED });
  assert.match(message(gladys).fr, /antérieur à 4\.1\.2/);
  const ack = await press('set-current', '10');
  assert.equal(ack.success, false);
  assert.match(ack.error, /4\.1\.2/);
  server.charger.status = status({ state: 254, vehicle: 1 });
  assert.equal((await press('start-charge')).success, true, 'start needs 4.0.1 only');
  assert.deepEqual(server.posts(), [{ state: 'active' }]);
});

test('current: strict value, bounds, the pause kept, one change a minute', async (t) => {
  const { server, press, charger, advance } = await setup(t, { config: ALLOWED });
  for (const value of [null, '', ' ', true, 12.5, '1e1', '81']) {
    const ack = await press('set-current', value, 200);
    assert.equal(ack.success, false, JSON.stringify(value));
  }
  let ack = await press('set-current', '20');
  assert.match(ack.error, /entre 6 et 16 A/);
  charger.override = { state: 'disabled', auto_release: true };
  ack = await press('set-current', '10');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    server.posts(),
    [{ auto_release: true, state: 'disabled', charge_current: 10 }],
    'a pause stays a pause',
  );
  ack = await press('set-current', '12');
  assert.equal(ack.success, false);
  assert.match(ack.error, /moins d'une minute/);
  ack = await press('pause-charge');
  assert.equal(ack.success, true, 'a pause is never held back by the minute');
  await advance(60 * SECOND);
  ack = await press('set-current', '8');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.posts().at(-1), { state: 'disabled', charge_current: 8 });
});

test('a pause is never held back by a command in flight: sent at once, then again', async (t) => {
  const { server, gladys, advance, charger, target } = await setup(t, { config: ALLOWED });
  charger.postPlan = (index) => (index === 0 ? { applyAfter: 2_000, answerAfter: 2_500 } : {});
  const current = gladys.fake.setValue(...target('set-current'), '10');
  await advance(800, 100);
  const pause = gladys.fake.setValue(...target('pause-charge'), 1);
  await advance(5 * SECOND, 100);
  assert.equal((await pause).success, true, (await pause).error);
  assert.equal((await current).success, true);
  assert.deepEqual(server.posts(), [
    { charge_current: 10 },
    { state: 'disabled' },
    { state: 'disabled' },
  ]);
  assert.equal(charger.override.state, 'disabled', 'the pause wins');
});

test('a start not sent yet gives way to a pause arrived meanwhile', async (t) => {
  const { server, gladys, advance, charger, target } = await setup(t, { config: ALLOWED });
  charger.status = status({ state: 254, vehicle: 1 });
  charger.delays['GET /status'] = 600;
  const start = gladys.fake.setValue(...target('start-charge'), 1);
  await advance(200, 100);
  const pause = gladys.fake.setValue(...target('pause-charge'), 1);
  await advance(5 * SECOND, 100);
  assert.equal((await pause).success, true);
  const ack = await start;
  assert.equal(ack.success, false);
  assert.match(ack.error, /pause de cette borne est arrivée/);
  assert.deepEqual(server.posts(), [{ state: 'disabled' }]);
});

test('a silent charger: "sent, without confirmation", never "not sent"', async (t) => {
  const { press, charger } = await setup(t, { config: ALLOWED });
  charger.postPlan = () => ({ answerAfter: 10 * SECOND });
  const ack = await press('set-current', '10');
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée, sans confirmation/);
});

test('a start unconfirmed that lands after a pause: the pause is sent again', async (t) => {
  const { server, press, charger, advance, logs } = await setup(t, { config: ALLOWED });
  charger.status = status({ state: 254, vehicle: 1 });
  charger.postPlan = (index) =>
    index === 0 ? { applyAfter: 30 * SECOND, answerAfter: 10 * SECOND } : {};
  let ack = await press('start-charge');
  assert.match(ack.error, /envoyée, sans confirmation/);
  ack = await press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  await advance(60 * SECOND);
  assert.deepEqual(server.posts(), [
    { state: 'active' },
    { state: 'disabled' },
    { state: 'disabled' },
  ]);
  assert.equal(charger.override.state, 'disabled', 'the pause wins');
  assert.ok(logs.some((l) => /pause sent again/.test(l)));
});

test('an answer not understood: sent, without confirmation', async (t) => {
  const { press, charger } = await setup(t, { config: ALLOWED });
  charger.postAnswer = { msg: 'failure!' };
  const ack = await press('pause-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée, sans confirmation/);
});

test('a fresh read that fails refuses a start, unsent', async (t) => {
  const { server, press, charger } = await setup(t, { config: ALLOWED });
  charger.statuses['GET /status'] = 500;
  const ack = await press('start-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /n'a pas pu être relu/);
  assert.deepEqual(server.posts(), []);
});

test('a reconnection to Gladys sends the status and the device again', async (t) => {
  const { gladys, app } = await setup(t);
  const calls = [];
  for (const name of ['publishDiscoveredDevices', 'setConnectionStatus']) {
    const original = gladys[name].bind(gladys);
    gladys[name] = (...args) => {
      calls.push(name);
      return original(...args);
    };
  }
  await app.connected({ ...CONFIG });
  assert.deepEqual(calls.sort(), ['publishDiscoveredDevices', 'setConnectionStatus']);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('the energy index: never 0, a jump held until accepted in two clicks', async (t) => {
  const store = memoryStore();
  const { gladys, advance, charger, logs } = await setup(t, { store });
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'total-energy'), 1234.567);
  charger.status = status({ total_energy: 0, watthour: 0 });
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'total-energy'), 1234.567, '0 is never published');
  charger.status = status({ total_energy: 9999 });
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'total-energy'), 1234.567, 'a jump is held');
  assert.equal(store.data.index.held.direction, 'up');
  assert.match(message(gladys).fr, /Index d'énergie retenu : saut de 1234,567 à 9999 kWh/);
  await advance(10 * MINUTE, 30 * SECOND);
  assert.equal(last(gladys, 'total-energy'), 1234.567, 'never confirmed by time');
  let ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD_INDEX);
  assert.match(ack.data.message.fr, /Rien n'est encore accepté/);
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'total-energy'), 1234.567, 'one click accepts nothing');
  ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD_INDEX);
  assert.match(ack.data.message.fr, /Accepté : le saut/);
  await advance(SECOND);
  assert.equal(last(gladys, 'total-energy'), 9999);
  assert.ok(logs.some((l) => /accepted by the user/.test(l)));
  ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD_INDEX);
  assert.match(ack.data.message.fr, /rien à accepter/);
});

test('the energy index: a drop held across a restart, a second click too late refused', async (t) => {
  const store = memoryStore();
  const { gladys, app, advance, charger } = await setup(t, { store });
  await advance(30 * SECOND);
  charger.status = status({ total_energy: 3 });
  await advance(30 * SECOND);
  assert.equal(store.data.index.held.direction, 'down');
  await app.start({ ...CONFIG });
  await settle();
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'total-energy'), 1234.567, 'still held after a restart');
  let ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD_INDEX);
  assert.match(ack.data.message.fr, /une baisse/);
  await advance(3 * MINUTE, 30 * SECOND);
  ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD_INDEX);
  assert.match(ack.data.message.fr, /Rien n'est encore accepté/, 'too late: a first click again');
});
