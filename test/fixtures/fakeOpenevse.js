// -----------------------------------------------------------------------------
// A fake OpenEVSE charger behind the transport the integration is given: the
// answers shaped like python-openevse-http's test fixtures (made up, never
// captured from a real charger), optional Basic auth, and the POST of the
// override, which changes the charger like it is expected to. Records every
// request. No network. Delays use setTimeout, so the mocked clock drives them.
// -----------------------------------------------------------------------------

import { ChargerError, ERROR_KINDS } from '../../src/openevse/http.js';

export const HOST = '192.168.1.70';
export const USER = 'admin';
export const PASSWORD = 'correct horse';
export const SERIAL = '1234567890ab';
export const NOW = Date.UTC(2026, 9, 20, 18, 0, 0);

/** `/config`: firmware 5.1.2, 6 to 32 A, and the secrets a real one holds (never read). */
export const config = (over = {}) => ({
  firmware: '8.2.2',
  protocol: '-',
  wifi_serial: '1234567890AB',
  version: '5.1.2',
  buildenv: 'openevse_wifi_v1',
  service: 2,
  max_current_soft: 32,
  min_current_hard: 6,
  max_current_hard: 32,
  ssid: 'home-wifi',
  pass: 'wifi-secret-123',
  www_username: USER,
  www_password: 'web-secret-456',
  mqtt_pass: 'mqtt-secret-789',
  emoncms_apikey: 'emon-secret-000',
  hostname: 'openevse-7b2c',
  ...over,
});

/** `/status`: charging at 16 A, 230 V, 3680 W, 4.5 kWh this session, 1234.567 kWh in all. */
export const status = (over = {}) => ({
  mode: 'STA',
  amp: 16,
  voltage: 230,
  power: 3680,
  pilot: 16,
  max_current: 32,
  temp: 312,
  temp1: false,
  temp2: 305,
  temp4: 402,
  state: 3,
  status: 'active',
  vehicle: 1,
  manual_override: 0,
  session_energy: 4500,
  total_energy: 1234.567,
  watthour: 1234567,
  wattsec: 16_200_000,
  config_version: 6,
  override_version: 4,
  ...over,
});

const answer = (status, body = '', headers = {}) => ({
  status,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const basic = (user, password) =>
  `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;

/**
 * The charger. The test may set: `down` (nothing answers), `silent`
 * (connected, no answer), `delays` / `statuses` (by path or method),
 * `auth` (`{ user, password }`: Basic auth asked), `applies` (false: the POST
 * changes nothing), `bodies` (raw answer by path), `headers` (of an error
 * answer), `postPlan(index)` -> `{ applyAfter, answerAfter }`, `postAnswer`.
 */
export function fakeCharger(over = {}) {
  const charger = {
    config: config(),
    status: status(),
    /** The override in force; null: none (GET answers 404). */
    override: null,
    auth: undefined,
    delays: {},
    statuses: {},
    bodies: {},
    headers: {},
    applies: true,
    postAnswer: { msg: 'OK' },
    ...over,
  };
  /** The override applied: the EVSE state follows it (charging / sleeping). */
  const apply = (body) => {
    charger.override = body;
    if (body.state === 'disabled') {
      charger.status.state = 254;
      charger.status.amp = 0;
      charger.status.power = 0;
    } else if (body.state === 'active' && charger.status.vehicle === 1) {
      charger.status.state = 3;
    }
    if (body.charge_current > 0) {
      charger.status.pilot = body.charge_current;
    }
  };
  const server = {
    charger,
    /** { host, port, method, path, headers, body, timeoutMs } */
    requests: [],
    paths: () => server.requests.map((r) => `${r.method} ${r.path}`),
    posts: () => server.requests.filter((r) => r.method === 'POST').map((r) => JSON.parse(r.body)),
    async transport(request) {
      const { method, path, headers = {}, body, timeoutMs } = request;
      server.requests.push(request);
      if (charger.down) {
        throw new ChargerError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
      }
      if (
        charger.auth &&
        headers.Authorization !== basic(charger.auth.user, charger.auth.password)
      ) {
        return answer(401, 'Unauthorized');
      }
      if (method === 'POST' && charger.postPlan) {
        // The POST lands on the charger at applyAfter, whether or when it is answered.
        const index = server.posts().length - 1;
        const { applyAfter = 0, answerAfter = 0 } = charger.postPlan(index) ?? {};
        const value = JSON.parse(body);
        if (applyAfter > 0) {
          setTimeout(() => apply(value), applyAfter);
        } else {
          apply(value);
        }
        if (answerAfter >= timeoutMs) {
          await wait(timeoutMs);
          throw new ChargerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
        }
        if (answerAfter) {
          await wait(answerAfter);
        }
        return answer(200, charger.postAnswer);
      }
      const delay = charger.delays[`${method} ${path}`] ?? charger.delays[method] ?? 0;
      if (charger.silent || delay >= timeoutMs) {
        await wait(timeoutMs);
        throw new ChargerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
      }
      if (delay) {
        await wait(delay);
      }
      const forced = charger.statuses[`${method} ${path}`] ?? charger.statuses[path];
      if (forced) {
        return answer(forced, 'error wifi-secret-123', charger.headers);
      }
      if (method === 'POST' && path === '/override') {
        if (charger.applies) {
          apply(JSON.parse(body));
        }
        return answer(200, charger.postAnswer);
      }
      if (charger.bodies[path] !== undefined) {
        return answer(200, charger.bodies[path]);
      }
      if (path === '/config') return answer(200, charger.config);
      if (path === '/status') return answer(200, charger.status);
      if (path === '/override') {
        return charger.override ? answer(200, charger.override) : answer(404, { msg: 'Not found' });
      }
      return answer(404, '');
    },
  };
  return server;
}

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
