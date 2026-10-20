// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The user name
// and the password of the web interface are kept here in memory only: never
// logged, never written to /data, never put in a status or an error.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { CURRENT, DEFAULT_PORT, LIMITS, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  host: '',
  username: '',
  password: '',
  allow_commands: false,
  max_current: CURRENT.defaultCeiling,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The address of the charger typed by the user: an IPv4 address or a host
 * name (`openevse-7b2c.local`), with an optional port (a pasted URL is
 * reduced to its host and port).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A text typed in the form: printable ASCII without spaces at the ends, else ''. */
function ascii(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const text = value.trim();
  if (text.length < LIMITS.secretMin || text.length > LIMITS.secretMax) {
    return '';
  }
  return /^[\x20-\x7e]+$/.test(text) ? text : '';
}

const typed = (value) => typeof value === 'string' && value.trim() !== '';

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const host = String(c.host ?? '').trim();
  const address = parseAddress(host);
  // A user name never holds a colon (Basic auth joins the two with one).
  const username = ascii(c.username);
  const user = username.includes(':') ? '' : username;
  const password = ascii(c.password);
  const interval = Number(c.poll_interval);
  const ceiling = Number(c.max_current);
  return {
    address,
    /** The text typed when it is not an address (shown in the status, cut). */
    invalidHost: host !== '' && !address ? host.slice(0, 100) : undefined,
    /** Basic auth when both are given; none when both are empty. */
    auth: user && password ? { user, password } : undefined,
    /** Only one of the two given, or one refused (non-ASCII, too long, a colon). */
    badAuth:
      (typed(c.username) || typed(c.password)) && !(user && password)
        ? typed(c.username) && typed(c.password)
          ? 'invalid'
          : 'incomplete'
        : undefined,
    allowCommands: strictTrue(c.allow_commands),
    maxCurrent:
      Number.isFinite(ceiling) && String(c.max_current).trim() !== ''
        ? Math.min(CURRENT.max, Math.max(CURRENT.min, Math.floor(ceiling)))
        : CURRENT.defaultCeiling,
    pollInterval:
      Number.isFinite(interval) && String(c.poll_interval).trim() !== ''
        ? Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval)))
        : POLL_INTERVAL.default,
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** What identifies the credentials, to tell a change (never stored, never logged). */
export const credentialsKey = (config) =>
  config.auth ? JSON.stringify([config.auth.user, config.auth.password]) : '';
