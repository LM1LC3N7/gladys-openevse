import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialsKey, normalizeConfig, parseAddress } from '../src/config.js';

test('addresses: IPv4, host names, ports, pasted URLs', () => {
  assert.deepEqual(parseAddress('192.168.1.70'), { host: '192.168.1.70', port: 80 });
  assert.deepEqual(parseAddress('http://OpenEVSE-7B2C.local:8080/status'), {
    host: 'openevse-7b2c.local',
    port: 8080,
  });
  for (const bad of ['', '999.1.1.1', 'a b', 'host:0', 'host:70000', '-bad.local']) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
});

test('the commands are off unless exactly true', () => {
  for (const value of [undefined, false, 'false', 1, 'yes', 'TRUE']) {
    assert.equal(normalizeConfig({ allow_commands: value }).allowCommands, false, String(value));
  }
  assert.equal(normalizeConfig({ allow_commands: true }).allowCommands, true);
  assert.equal(normalizeConfig({ allow_commands: 'true' }).allowCommands, true);
});

test('credentials: both or neither; never a colon in the user name', () => {
  assert.equal(normalizeConfig({}).auth, undefined);
  assert.equal(normalizeConfig({}).badAuth, undefined);
  assert.deepEqual(normalizeConfig({ username: ' admin ', password: 'pw' }).auth, {
    user: 'admin',
    password: 'pw',
  });
  assert.equal(normalizeConfig({ username: 'admin' }).badAuth, 'incomplete');
  assert.equal(normalizeConfig({ password: 'pw' }).badAuth, 'incomplete');
  assert.equal(normalizeConfig({ username: 'a:b', password: 'pw' }).badAuth, 'invalid');
  assert.equal(normalizeConfig({ username: 'admin', password: 'mot de passé' }).badAuth, 'invalid');
  assert.notEqual(
    credentialsKey(normalizeConfig({ username: 'a', password: 'b' })),
    credentialsKey(normalizeConfig({ username: 'a', password: 'c' })),
  );
});

test('the ceiling and the interval are bounded', () => {
  assert.equal(normalizeConfig({}).maxCurrent, 16);
  assert.equal(normalizeConfig({ max_current: 200 }).maxCurrent, 80);
  assert.equal(normalizeConfig({ max_current: 2 }).maxCurrent, 6);
  assert.equal(normalizeConfig({ max_current: '' }).maxCurrent, 16);
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 10);
  assert.equal(normalizeConfig({ poll_interval: 'x' }).pollInterval, 30);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
});
