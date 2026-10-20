import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  OpenEvseClient,
  atLeast,
  parseConfig,
  parseOverride,
  parseStatus,
  retryAfterOf,
  serialOf,
  versionOf,
} from '../src/openevse/client.js';
import { ERROR_KINDS, request } from '../src/openevse/http.js';
import { normalizeMemory } from '../src/store.js';
import { config, status } from './fixtures/fakeOpenevse.js';

test('config: identity, versions and bounds only, never a secret', () => {
  const c = parseConfig(config());
  assert.deepEqual(c, {
    serial: '1234567890ab',
    firmware: '5.1.2',
    version: [5, 1, 2],
    controller: '8.2.2',
    model: 'openevse_wifi_v1',
    minHard: 6,
    maxHard: 32,
  });
  assert.ok(!JSON.stringify(c).includes('secret'));
  assert.equal(parseConfig(config({ wifi_serial: '../etc' })).serial, undefined);
  assert.equal(parseConfig(config({ max_current_hard: '32' })).maxHard, undefined);
});

test('status: units, fallbacks, and hostile values', () => {
  const s = parseStatus(status());
  assert.equal(s.state, 'charging');
  assert.equal(s.sessionEnergy, 4.5);
  assert.equal(s.totalEnergy, 1234.567);
  assert.equal(s.temperature, 31.2);
  const old = parseStatus({
    state: 254,
    amp: 10,
    voltage: 240,
    wattsec: 3_600_000,
    watthour: 5000,
    temp: false,
    temp1: 250,
  });
  assert.equal(old.state, 'sleeping');
  assert.equal(old.power, 2400, 'V × A without a power');
  assert.equal(old.sessionEnergy, 1);
  assert.equal(old.totalEnergy, 5);
  assert.equal(old.temperature, 25);
  const bad = parseStatus(
    JSON.parse(
      '{"__proto__": {"state": 3}, "state": "3", "vehicle": 2, "amp": -1, "total_energy": "9"}',
    ),
  );
  assert.equal(bad.state, 'unknown');
  assert.equal(bad.vehicle, undefined);
  assert.equal(bad.current, undefined);
  assert.equal(bad.totalEnergy, undefined);
  for (const value of [null, [], 'text', 12]) {
    assert.throws(
      () => parseStatus(value),
      (err) => err.kind === ERROR_KINDS.PROTOCOL,
    );
  }
});

test('override: the fields kept with their exact type', () => {
  assert.deepEqual(
    parseOverride({ state: 'active', charge_current: 0, auto_release: true, extra: 1 }),
    {
      state: 'active',
      chargeCurrent: undefined,
      fields: { charge_current: 0, auto_release: true },
    },
  );
  assert.equal(parseOverride({ state: 'weird', charge_current: '10' }).state, 'none');
  assert.equal(parseOverride({}).fields.charge_current, undefined);
});

test('versions', () => {
  assert.deepEqual(versionOf('v4.1.2'), [4, 1, 2]);
  assert.deepEqual(versionOf('5.1.0.dev3'), [5, 1, 0]);
  assert.equal(versionOf('master_abc'), undefined);
  assert.ok(atLeast([4, 1, 2], [4, 1, 2]));
  assert.ok(atLeast([5, 0, 0], [4, 1, 2]));
  assert.ok(!atLeast([4, 1, 1], [4, 1, 2]));
  assert.ok(!atLeast(undefined, [4, 0, 1]));
  assert.equal(serialOf('1234567890AB'), '1234567890ab');
  assert.equal(serialOf('12:34'), undefined);
});

test('Retry-After in seconds or as a date', () => {
  assert.equal(retryAfterOf('120'), 120_000);
  assert.equal(retryAfterOf(new Date(10_000).toUTCString(), 0), 10_000);
  assert.equal(retryAfterOf('soon'), undefined);
});

test('statuses: 401 auth, 429 rate limited, others http; the body never kept', async () => {
  for (const [code, kind] of [
    [401, ERROR_KINDS.AUTH],
    [403, ERROR_KINDS.HTTP],
    [429, ERROR_KINDS.RATE_LIMITED],
    [500, ERROR_KINDS.HTTP],
  ]) {
    const client = new OpenEvseClient({
      transport: async () => ({ status: code, headers: {}, body: 'secret-echo' }),
    });
    await assert.rejects(
      client.get({ host: 'h', port: 80 }, undefined, '/status', { timeoutMs: 100 }),
      (err) => err.kind === kind && !err.message.includes('secret-echo'),
    );
  }
  const none = new OpenEvseClient({
    transport: async () => ({ status: 404, headers: {}, body: '{"msg":"Not found"}' }),
  });
  assert.equal(
    (await none.override({ host: 'h', port: 80 }, undefined, { timeoutMs: 100 })).state,
    'none',
  );
});

test('a command too late is never sent; a 2xx not understood is a protocol error', async () => {
  let calls = 0;
  let body = '{"msg":"OK"}';
  const client = new OpenEvseClient({
    transport: async () => {
      calls += 1;
      return { status: 200, headers: {}, body };
    },
    now: () => 1_000,
  });
  const address = { host: 'h', port: 80 };
  await assert.rejects(
    client.setOverride(address, undefined, { state: 'active' }, { startBy: 999, timeoutMs: 100 }),
    (err) => err.kind === ERROR_KINDS.LATE,
  );
  assert.equal(calls, 0);
  await client.setOverride(
    address,
    undefined,
    { state: 'active' },
    { startBy: 2_000, timeoutMs: 100 },
  );
  body = '{"msg":"failure!"}';
  await assert.rejects(
    client.setOverride(address, undefined, { state: 'active' }, { startBy: 2_000, timeoutMs: 100 }),
    (err) => err.kind === ERROR_KINDS.PROTOCOL,
  );
});

test('the real transport against a loopback server: Basic auth, body, size bound', async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === '/big') {
      res.end('x'.repeat(70 * 1024));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ state: 3 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = { host: '127.0.0.1', port: server.address().port };
  const client = new OpenEvseClient({ transport: request });
  const data = await client.get(address, { user: 'u', password: 'p' }, '/status', {
    timeoutMs: 2000,
  });
  assert.equal(data.state, 3);
  assert.equal(seen[0].authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.equal(seen[0]['user-agent'], undefined, 'no User-Agent');
  await assert.rejects(
    client.get(address, undefined, '/big', { timeoutMs: 2000 }),
    (err) => err.kind === ERROR_KINDS.PROTOCOL,
  );
  server.close();
  await assert.rejects(
    request({ ...address, path: '/', timeoutMs: 500 }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE,
  );
});

test('the memory in /data is repaired and bounded, and holds no secret', () => {
  const now = 1_000_000;
  const memory = normalizeMemory(
    {
      pause: { until: now + 999 * 3_600_000, reason: 'x' },
      block: { until: now + 999 * 3_600_000, failures: 3, password: 'leak' },
      index: {
        featureId: 'f',
        last: { value: 5, at: 1 },
        held: { direction: 'sideways' },
        x: 'leak',
      },
    },
    now,
  );
  assert.equal(memory.pause.until, now + 6 * 3_600_000);
  assert.equal(memory.pause.reason, '429');
  assert.equal(memory.block.until, now + 6 * 3_600_000);
  assert.deepEqual(memory.index, { featureId: 'f', last: { value: 5, at: 1 }, held: null });
  assert.ok(!JSON.stringify(memory).includes('leak'));
  assert.deepEqual(normalizeMemory('garbage', now), { pause: null, block: null, index: null });
});
