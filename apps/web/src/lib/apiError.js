/**
 * apiError.js — what a failure IS on the client.
 *
 * Decides: the shape every failure reaching the UI has — a `code` to branch on, a
 * `message` written for a person, and the recovery data some codes carry.
 *
 * Does NOT decide: how a failure is produced (that is `api.js`, the only place that
 * translates an HTTP response into one of these) or how it is displayed (that is the
 * toast surface and `ErrorState`).
 *
 * WHY A TYPE RATHER THAN THE RAW BODY. The server's contract is
 * `{ error: { code, message } }` and a component must never branch on prose — a
 * `STALE_REVISION` is recoverable and "Something went wrong" is not, and the two are
 * distinguishable only by code. Giving the client one error type means every screen has
 * one error path, and a `catch` block can ask a question instead of parsing a string.
 *
 * THE CODES THE CLIENT INVENTS. Three failures never reach us as a coded body, because
 * no body arrives at all. They are given codes here so the UI has nothing special to
 * handle:
 *   - NETWORK_UNAVAILABLE — fetch itself rejected: offline, DNS, the server is down.
 *   - UNEXPECTED_RESPONSE — a 2xx that was not JSON. Usually a proxy or a dev server
 *     returning an HTML error page, which would otherwise surface as a JSON parse crash
 *     inside a component.
 *   - REQUEST_CANCELLED — an aborted request. Not a fault: a component unmounted or the
 *     user typed again. Screens must be able to ignore exactly this one.
 *   - REVISION_UNKNOWN — a write was attempted on a kit this client has never read, so
 *     there is no revision to send. Raised before the request leaves, because the
 *     server would reject it anyway and a coded local failure says why.
 *   - SERVER_UNREACHABLE — a response arrived, but from something in front of the API
 *     rather than the API itself: a 502/503/504 with no coded body, which is what a
 *     proxy returns when nothing is listening behind it. Distinct from
 *     NETWORK_UNAVAILABLE, where no response arrived at all, and distinct from a real
 *     503 from our own server — that one carries a code and keeps it.
 */

/** Codes the client raises itself, for failures that arrive with no coded body. */
export const CLIENT_ERROR_CODES = Object.freeze({
  NETWORK_UNAVAILABLE: 'NETWORK_UNAVAILABLE',
  UNEXPECTED_RESPONSE: 'UNEXPECTED_RESPONSE',
  REQUEST_CANCELLED: 'REQUEST_CANCELLED',
  REVISION_UNKNOWN: 'REVISION_UNKNOWN',
  SERVER_UNREACHABLE: 'SERVER_UNREACHABLE',
});

export class AppError extends Error {
  /**
   * @param {object} init
   * @param {string} init.code        the server's code, or one of CLIENT_ERROR_CODES
   * @param {string} init.message     written to be shown to a person
   * @param {number|null} [init.status] HTTP status, null when there was no response
   * @param {object|null} [init.details] field-level errors, when the server sent them
   * @param {number|null} [init.currentRevision] on STALE_REVISION: what the server holds
   * @param {number|null} [init.expectedRevision] on STALE_REVISION: what we sent
   * @param {object|null} [init.kit]  on STALE_REVISION: the CURRENT kit, to reapply onto
   */
  constructor({
    code,
    message,
    status = null,
    details = null,
    currentRevision = null,
    expectedRevision = null,
    kit = null,
  }) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.currentRevision = currentRevision;
    this.expectedRevision = expectedRevision;
    this.kit = kit;
  }
}

/** Was the visitor's session missing, expired or invalid? */
export function isAuthFailure(error) {
  return (
    error?.code === 'NOT_AUTHENTICATED' ||
    error?.code === 'SESSION_EXPIRED' ||
    error?.code === 'SESSION_INVALID'
  );
}

/**
 * Did a write lose a race? The current kit travels with this error, so a caller can
 * reapply its change onto fresh state instead of reloading and losing the edit.
 */
export function isStaleRevision(error) {
  return error?.code === 'STALE_REVISION';
}

/** Was this an abort rather than a fault? Screens should swallow exactly this. */
export function isCancelled(error) {
  return error?.code === CLIENT_ERROR_CODES.REQUEST_CANCELLED;
}

/** Is retrying the same request plausibly useful? */
export function isRetryable(error) {
  if (error?.code === CLIENT_ERROR_CODES.NETWORK_UNAVAILABLE) return true;
  if (error?.code === CLIENT_ERROR_CODES.SERVER_UNREACHABLE) return true;
  return typeof error?.status === 'number' && error.status >= 500;
}
