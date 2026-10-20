// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container): the end of a pause (429, or a 5xx), the block after the user
// name and password refused (so a restart never asks the charger again before
// its time, never loops on refused credentials), and the energy index guard
// (its reference and the value it holds back, so a jump or a drop never
// reaches Gladys after a restart). Bounded when read back: a pause never more
// than 6 h away, a block never more than the longest new-try delay.
// NO SECRET: neither the user name, nor the password, nor anything derived
// from them, nor any field of the charger's `/config`. The file is readable by
// the container user only (0600).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/openevse-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const longestBlock = TIMINGS.authBackoff.at(-1);
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** The guard state kept as is (src/guard.js validates it again), its feature id checked. */
function indexOf(raw) {
  const index = object(raw);
  if (typeof index.featureId !== 'string' || index.featureId.length > 300) {
    return null;
  }
  const point = (p) =>
    p && Number.isFinite(p.value) && Number.isFinite(p.at) ? { value: p.value, at: p.at } : null;
  const held = object(index.held);
  return {
    featureId: index.featureId,
    last: point(index.last),
    held:
      (held.direction === 'up' || held.direction === 'down') &&
      [held.from, held.to, held.threshold, held.at].every(Number.isFinite)
        ? {
            direction: held.direction,
            from: held.from,
            to: held.to,
            threshold: held.threshold,
            at: held.at,
          }
        : null,
  };
}

/**
 * The persisted state, repaired and bounded: `{ pause: { until, reason } |
 * null, block: { until, failures } | null, index: { featureId, last, held } |
 * null }`.
 */
export function normalizeMemory(raw, now) {
  const data = object(raw);
  const pause = object(data.pause);
  const block = object(data.block);
  const failures = Number.isInteger(block.failures) && block.failures > 0 ? block.failures : 1;
  return {
    pause:
      Number.isFinite(pause.until) && pause.until > now
        ? {
            until: Math.min(pause.until, now + TIMINGS.rateLimitMax),
            reason: pause.reason === '5xx' ? '5xx' : '429',
          }
        : null,
    block: Number.isFinite(block.until)
      ? {
          // An expired block is kept (its count spaces the next tries) but no longer waits.
          until: Math.min(block.until, now + longestBlock),
          failures: Math.min(failures, 100),
        }
      : null,
    index: indexOf(data.index),
  };
}
