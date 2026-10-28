// The guard of src/guard.js: the rules of gladys-p1-monitor's approved
// IndexGuard, with the highest power as a parameter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INDEX_MAX_KW } from '../src/constants.js';
import { IndexGuard } from '../src/guard.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const T0 = 1_000_000_000;

test('0 never; the first value taken; a plausible rise taken', () => {
  const g = new IndexGuard(undefined, undefined, T0, INDEX_MAX_KW);
  assert.equal(g.accept(0, T0), false);
  assert.equal(g.accept(100, T0), true);
  assert.equal(g.accept(110, T0 + HOUR), true, '10 kWh in an hour fits 25 kW');
  assert.equal(g.accept(110, T0 + 2 * HOUR), true, 'unchanged');
  assert.equal(g.last.at, T0 + HOUR, 'an unchanged value does not move the date');
});

test('a jump and a drop are held, never confirmed by time nor repetition', () => {
  const g = new IndexGuard({ value: 100, at: T0 }, undefined, T0, INDEX_MAX_KW);
  assert.equal(g.accept(200, T0 + 60_000), false);
  assert.equal(g.held.direction, 'up');
  for (let i = 1; i <= 50; i += 1) {
    assert.equal(g.accept(200, T0 + i * HOUR), false, 'still held');
  }
  const d = new IndexGuard({ value: 100, at: T0 }, undefined, T0, INDEX_MAX_KW);
  assert.equal(d.accept(3, T0 + 60_000), false);
  assert.equal(d.held.direction, 'down');
});

test('the acceptance is bounded to what was shown', () => {
  const g = new IndexGuard({ value: 100, at: T0 }, undefined, T0, INDEX_MAX_KW);
  g.accept(200, T0 + 60_000);
  assert.deepEqual(g.acceptHeld(), { direction: 'up', from: 100, to: 200 });
  assert.equal(g.accept(5000, T0 + 120_000), false, 'far above what was accepted');
  g.acceptHeld();
  assert.equal(g.accept(5000, T0 + 120_000), true);
});

test('maxKw is a checked parameter; the guard keeps the approved rules', () => {
  assert.throws(() => new IndexGuard(undefined, undefined, T0, 0), RangeError);
  assert.throws(() => new IndexGuard(undefined, undefined, T0, Number.NaN), RangeError);
  const source = readFileSync(new URL('../src/guard.js', import.meta.url), 'utf8');
  assert.match(source, /The IndexGuard of gladys-p1-monitor/);
  assert.equal(INDEX_MAX_KW, 25);
});

test('index guard: an accepted drop is the floor, a lower value later is held', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 }, undefined, 0, 100);
  assert.equal(guard.accept(12, MINUTE), false);
  assert.ok(guard.acceptHeld());
  assert.equal(guard.accept(5, 2 * MINUTE), false, 'never 5 kWh without a click');
  assert.equal(guard.held.to, 5);
  assert.equal(guard.last.value, 1000);
  // The value accepted comes back: it follows, from the floor accepted.
  assert.equal(guard.accept(12.1, 3 * MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: readings under an accepted floor for hours never widen the acceptance', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 }, undefined, 0, 100);
  assert.equal(guard.accept(12, MINUTE), false);
  assert.ok(guard.acceptHeld());
  let t = 2 * MINUTE;
  for (; t < 15 * 60 * MINUTE; t += MINUTE) assert.equal(guard.accept(5, t), false);
  assert.equal(guard.accept(212, t), false, '212 kWh after 15 h under the floor: held');
  assert.equal(guard.held.to, 212);
  // A value above the acceptance dropped it: 12.1 needs a new acceptance.
  assert.equal(guard.accept(12.1, t + MINUTE), false);
  assert.equal(guard.held.direction, 'down');
});
