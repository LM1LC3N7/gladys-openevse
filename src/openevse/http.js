// -----------------------------------------------------------------------------
// One plain HTTP/1.1 exchange with the charger (node:http, no keep-alive, no
// redirect followed, bounded time and size). Every failure becomes a
// ChargerError whose kind says whether the request may have reached the
// charger: 'unreachable' (nothing accepted the connection: nothing was sent)
// or 'timeout' (connected, then silent or cut: it may have been received).
// The headers given (Authorization) are never logged. No User-Agent is set:
// node:http sends none, the charger is never told it talks to anything else.
// -----------------------------------------------------------------------------

import { request as httpRequest } from 'node:http';
import { LIMITS } from '../constants.js';

/** The kinds of failure the rest of the code tells apart. */
export const ERROR_KINDS = Object.freeze({
  /** Nothing accepted the connection. Nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Connected, then silent or cut: the request may have been received. */
  TIMEOUT: 'timeout',
  /** An HTTP status other than 2xx (`status` holds it). */
  HTTP: 'http',
  /** 401: the user name and password refused, or asked for (`status` holds it). */
  AUTH: 'auth',
  /** 429 (`retryAfter` in ms when the charger gave one). */
  RATE_LIMITED: 'rate_limited',
  /** Too large, not JSON, not the expected shape. */
  PROTOCOL: 'protocol',
  /** The time a command was given ran out before its request: nothing was sent. */
  LATE: 'late',
});

export class ChargerError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'ChargerError';
    this.kind = kind;
    for (const [key, value] of Object.entries(details)) {
      this[key] = value;
    }
  }
}

/**
 * @param {{ host: string, port: number, method?: string, path: string,
 *   headers?: object, body?: string, timeoutMs?: number }} options
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
export function request({
  host,
  port,
  method = 'GET',
  path,
  headers = {},
  body,
  timeoutMs = 5000,
}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
    let settled = false;
    let connected = false;
    const finish = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const failure = (err) =>
      connected
        ? new ChargerError(ERROR_KINDS.TIMEOUT, `Connection lost: ${err.code ?? 'error'}`)
        : new ChargerError(ERROR_KINDS.UNREACHABLE, `Unreachable: ${err.code ?? 'error'}`);
    const req = httpRequest(
      {
        host,
        port,
        method,
        path,
        agent: false,
        headers: {
          Connection: 'close',
          Accept: 'application/json',
          ...headers,
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > LIMITS.responseBytes) {
            req.destroy();
            finish(reject, new ChargerError(ERROR_KINDS.PROTOCOL, 'Answer too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(resolve, {
            status: res.statusCode ?? 0,
            headers: res.headers ?? {},
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', (err) => finish(reject, failure(err)));
      },
    );
    req.on('socket', (socket) => {
      if (socket.connecting) {
        socket.once('connect', () => {
          connected = true;
        });
      } else {
        connected = true;
      }
    });
    // A plain (ref'd) timer: the exchange keeps the process alive until it ends.
    const timer = setTimeout(() => {
      req.destroy();
      finish(
        reject,
        connected
          ? new ChargerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout')
          : new ChargerError(ERROR_KINDS.UNREACHABLE, 'Unreachable: timeout'),
      );
    }, timeoutMs);
    req.on('error', (err) => finish(reject, failure(err)));
    req.end(payload);
  });
}
