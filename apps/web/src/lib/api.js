/**
 * api.js — the only place this client talks to the server.
 *
 * Decides: how a request is sent (always with credentials), how a response becomes
 * either data or a thrown `AppError`, and where the kit revision ledger is kept
 * current.
 *
 * Does NOT decide: what any screen does with the result, when to retry, or what a
 * failure looks like on screen. It also decides nothing about the kit itself — no
 * validation, no coverage, no scheduling. Those rules live in `packages/core` and run on
 * the server; restating any of them here would create a second copy that drifts, which
 * is the defect invariant 7 exists to prevent.
 *
 * CREDENTIALS ON EVERY REQUEST. The session is an HttpOnly signed cookie, so the browser
 * will not attach it unless asked — and `fetch` defaults to `same-origin`, which is
 * quietly correct in development (Vite proxies `/api`) and quietly wrong the day the API
 * is served from another origin. `include` is set once, here, rather than remembered at
 * fourteen call sites.
 *
 * ONE TRANSLATION. Every failure leaves this module as an `AppError` carrying the
 * server's `code`. That is what lets a component `catch` and ask a question — is this a
 * stale revision, is my session gone — instead of matching on prose. A fetch that
 * rejects, a 2xx that is not JSON and an abort are given client codes for the same
 * reason: a screen should have one error path, not one for coded failures and another
 * for the network being off.
 *
 * NO SSE HERE. `GET /api/kits/:id/progress` is an event stream, and `EventSource` is not
 * `fetch`: it cannot reuse this function's response handling, and its failure mode is a
 * silent reconnect rather than a rejected promise. Wrapping it here would mean one
 * function with two unrelated error paths. It belongs with the page that consumes it,
 * alongside the `?since=N` poll below — which exists because a proxy that buffers an
 * event stream turns the whole build into a blank page.
 */

import { AppError, CLIENT_ERROR_CODES } from './apiError.js';
import { kitRevisions } from './kitRevisions.js';

/** Same-origin by default: Vite proxies `/api` in development, and a deploy serves both. */
const BASE = import.meta.env?.VITE_API_BASE ?? '';

/**
 * Send one request and return its parsed body, or throw an `AppError`.
 *
 * @param {string} path      an `/api/...` path
 * @param {object} [options]
 * @param {string} [options.method]  defaults to GET
 * @param {object} [options.body]    serialised as JSON when present
 * @param {AbortSignal} [options.signal]
 */
export async function request(path, { method = 'GET', body, signal } = {}) {
  let response;

  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      // The cookie is the credential. See the header comment.
      credentials: 'include',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    // fetch rejects for exactly two reasons worth telling apart: the caller aborted, or
    // the request never reached a server.
    if (cause?.name === 'AbortError') {
      throw new AppError({
        code: CLIENT_ERROR_CODES.REQUEST_CANCELLED,
        message: 'That request was cancelled.',
      });
    }
    throw new AppError({
      code: CLIENT_ERROR_CODES.NETWORK_UNAVAILABLE,
      message: 'Could not reach the server. Check your connection and try again.',
    });
  }

  const payload = await readJson(response);

  if (!response.ok) throw toAppError(response, payload);

  // Any response that carries a revision updates the ledger — including the listing,
  // where each row has its own. One writer, so nothing else has to remember to.
  recordRevisions(payload);

  return payload;
}

/**
 * Parse the body, tolerating the responses that carry none.
 *
 * A 204 and a 200 with an empty body are both legitimate here. A 2xx that is not JSON is
 * not, and is reported as such rather than crashing inside a component: in development it
 * usually means the Vite proxy answered instead of the API.
 */
async function readJson(response) {
  const text = await response.text();
  if (text === '') return null;

  try {
    return JSON.parse(text);
  } catch {
    if (response.ok) {
      throw new AppError({
        code: CLIENT_ERROR_CODES.UNEXPECTED_RESPONSE,
        message: 'The server returned something this app could not read.',
        status: response.status,
      });
    }
    // A failure that is also unparseable: keep the status, which is all we know.
    return null;
  }
}

/**
 * Turn a failed response into an `AppError`.
 *
 * The server's contract is `{ error: { code, message } }` and the recovery fields ride
 * along on the codes that have them. `STALE_REVISION` is the one that matters: it
 * carries the current revision AND the current kit, so a caller can reapply its change
 * onto fresh state. Recording that revision here is what stops the next write repeating
 * the same 409.
 */
function toAppError(response, payload) {
  const error = payload?.error ?? {};

  // No coded body at all. Something answered, but it was not this API — a proxy with
  // nothing behind it, or a gateway timing out. Falling through to the generic branch
  // would put "The server returned 502." in front of a person, which is accurate and
  // impossible to act on; this says what to do instead.
  if (typeof error.code !== 'string') return uncodedFailure(response);

  const appError = new AppError({
    code: error.code,
    message:
      typeof error.message === 'string' && error.message !== ''
        ? error.message
        : `The server returned ${response.status}.`,
    status: response.status,
    details: error.details ?? null,
    currentRevision: Number.isInteger(error.currentRevision) ? error.currentRevision : null,
    expectedRevision: Number.isInteger(error.expectedRevision) ? error.expectedRevision : null,
    kit: error.kit ?? null,
  });

  if (appError.currentRevision !== null) {
    const kitId = idFrom(response.url) ?? error.kit?.id;
    if (kitId) kitRevisions.record(kitId, appError.currentRevision);
  }

  return appError;
}

/**
 * A failure that carried no coded body.
 *
 * The gateway statuses are the ones a reverse proxy or a dev-server proxy produces when
 * nothing is listening behind it, and they are the realistic case in development: the
 * API is simply not running. They get their own code so a screen can offer "try again"
 * rather than reporting an internal fault the server never claimed.
 *
 * Anything else uncoded keeps the status in the message, because at that point the
 * status is genuinely all that is known and inventing a friendlier sentence would hide
 * the one fact available.
 */
function uncodedFailure(response) {
  if (GATEWAY_STATUSES.has(response.status)) {
    return new AppError({
      code: CLIENT_ERROR_CODES.SERVER_UNREACHABLE,
      message: 'The server is not responding. It may be starting up — try again in a moment.',
      status: response.status,
    });
  }

  return new AppError({
    code: 'INTERNAL_ERROR',
    message: `The server returned ${response.status} with no explanation.`,
    status: response.status,
  });
}

/** Statuses that mean "nothing was listening behind the proxy", not "the API failed". */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/** Record every revision a payload carries, whatever shape it arrived in. */
function recordRevisions(payload) {
  if (!payload || typeof payload !== 'object') return;

  if (payload.id && Number.isInteger(payload.revision)) {
    kitRevisions.record(payload.id, payload.revision);
  }
  if (Array.isArray(payload.kits)) {
    for (const row of payload.kits) {
      if (row?.id && Number.isInteger(row.revision)) kitRevisions.record(row.id, row.revision);
    }
  }
}

/** Pull a kit id out of a request URL, for the 409 whose body may not repeat it. */
function idFrom(url) {
  const match = /\/api\/kits\/([^/?]+)/.exec(url ?? '');
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * The revision to send with a write.
 *
 * Read from the ledger rather than taken as an argument, so no screen can send a number
 * it happened to be holding since before the last regeneration. A kit that has never
 * been read has no revision, and saying so locally is better than a round trip to be
 * told the same thing.
 */
function revisionFor(kitId) {
  const revision = kitRevisions.get(kitId);
  if (revision === null) {
    throw new AppError({
      code: CLIENT_ERROR_CODES.REVISION_UNKNOWN,
      message: 'This kit has not been loaded yet, so it cannot be changed. Open it and try again.',
    });
  }
  return revision;
}

// --- auth -------------------------------------------------------------------

export const auth = {
  register: (email, password) => request('/api/auth/register', { method: 'POST', body: { email, password } }),
  login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password } }),

  /** Always succeeds server-side; clearing the ledger is the client's half. */
  async logout() {
    try {
      return await request('/api/auth/logout', { method: 'POST' });
    } finally {
      // Another account's revisions are not ours, and a signed-out tab holding them is
      // how a second sign-in sends the first one's numbers.
      kitRevisions.clear();
    }
  },

  me: (signal) => request('/api/auth/me', { signal }),
};

// --- kits -------------------------------------------------------------------

export const kits = {
  /** 202 with a kit id, or 200 when an identical submission is already in flight. */
  create: ({ jd, company_url, days }) =>
    request('/api/kits', { method: 'POST', body: { jd, company_url, days } }),

  batch: (cases) => request('/api/kits/batch', { method: 'POST', body: { cases } }),

  /**
   * Continue a kit, or deliberately start it over.
   *
   * `fresh: true` tells the server to ignore any checkpoint and discard it. Without the
   * flag the endpoint resumes when a checkpoint exists and starts over when it does not,
   * which is one behaviour dependent on hidden state — not two actions a person can
   * choose between.
   */
  resume: (id, { fresh = false } = {}) =>
    request(`/api/kits/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      body: { fresh },
    }),

  list: ({ limit, signal } = {}) =>
    request(`/api/kits${limit ? `?limit=${encodeURIComponent(limit)}` : ''}`, { signal }),

  get: (id, signal) => request(`/api/kits/${encodeURIComponent(id)}`, { signal }),

  async remove(id) {
    const result = await request(`/api/kits/${encodeURIComponent(id)}`, { method: 'DELETE' });
    // Forget the revision, so an id the server reissues cannot inherit a stale number.
    kitRevisions.forget(id);
    return result;
  },

  edit: (id, ops) =>
    request(`/api/kits/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { revision: revisionFor(id), ops },
    }),

  regenerate: (id, { section, category = null }) =>
    request(`/api/kits/${encodeURIComponent(id)}/regenerate`, {
      method: 'POST',
      body: { section, category, revision: revisionFor(id) },
    }),

  undoRegenerate: (id, section) =>
    request(`/api/kits/${encodeURIComponent(id)}/undo-regenerate`, {
      method: 'POST',
      body: { section, revision: revisionFor(id) },
    }),

  /** Progress without a stream, for the client whose proxy eats SSE. */
  progressSince: (id, since = 0, signal) =>
    request(`/api/kits/${encodeURIComponent(id)}/progress/poll?since=${encodeURIComponent(since)}`, { signal }),
};

// --- practice ---------------------------------------------------------------

export const practice = {
  /** Ratings take no revision: recording that you practised cannot conflict. */
  record: (id, { questionId, confidence, note = '' }) =>
    request(`/api/kits/${encodeURIComponent(id)}/practice`, {
      method: 'POST',
      body: { questionId, confidence, note },
    }),

  history: (id, signal) => request(`/api/kits/${encodeURIComponent(id)}/practice`, { signal }),
};

export const health = (signal) => request('/api/health', { signal });
