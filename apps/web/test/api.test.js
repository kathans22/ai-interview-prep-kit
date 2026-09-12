/**
 * api.test.js — the client's error translation and revision ledger.
 *
 * These two are worth testing precisely because they fail quietly. A mapping that drops
 * the `code` leaves every screen with prose it cannot branch on, and a ledger that keeps
 * a stale number turns every second edit into a 409 the user cannot explain. Neither
 * shows up as a crash.
 *
 * `fetch` is stubbed rather than mocked through a library: the project runs `node:test`
 * with zero test dependencies and that does not change for the client. The hooks are not
 * tested here — they need a renderer, which would be a dependency. They are verified in
 * a real browser instead.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { auth, kits, request } from '../src/lib/api.js';
import { AppError, CLIENT_ERROR_CODES, isStaleRevision, isAuthFailure, isRetryable } from '../src/lib/apiError.js';
import { kitRevisions, createKitRevisions } from '../src/lib/kitRevisions.js';

/** A fetch stub that answers with one canned response and records what it was called with. */
function stubFetch({ status = 200, body = null, text = null, url = 'http://localhost/api/x', reject = null }) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    if (reject) throw reject;
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      text: async () => (text !== null ? text : body === null ? '' : JSON.stringify(body)),
    };
  };
  return calls;
}

test('every request carries credentials, so the session cookie is actually sent', async () => {
  const calls = stubFetch({ body: { ok: true } });

  await request('/api/health');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.credentials, 'include');
});

test('a coded failure becomes an AppError carrying the code, message and status', async () => {
  stubFetch({
    status: 409,
    body: { error: { code: 'EMAIL_TAKEN', message: 'An account with that email already exists. Sign in instead.' } },
  });

  const error = await auth.register('a@b.com', 'password123').then(
    () => null,
    (thrown) => thrown
  );

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'EMAIL_TAKEN');
  assert.equal(error.status, 409);
  assert.match(error.message, /already exists/);
});

test('a 500 keeps the generic code the server chose and does not invent detail', async () => {
  stubFetch({
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Something failed on our side. The failure has been logged.' } },
  });

  const error = await request('/api/kits').catch((thrown) => thrown);

  assert.equal(error.code, 'INTERNAL_ERROR');
  assert.ok(isRetryable(error), 'a 5xx is worth retrying');
});

test('a rejected fetch is a coded network failure, not an unhandled throw', async () => {
  stubFetch({ reject: new TypeError('fetch failed') });

  const error = await request('/api/health').catch((thrown) => thrown);

  assert.equal(error.code, CLIENT_ERROR_CODES.NETWORK_UNAVAILABLE);
  assert.equal(error.status, null);
  assert.ok(isRetryable(error));
});

test('an abort is reported as cancelled, which screens are meant to swallow', async () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  stubFetch({ reject: abort });

  const error = await request('/api/health').catch((thrown) => thrown);

  assert.equal(error.code, CLIENT_ERROR_CODES.REQUEST_CANCELLED);
});

test('a 2xx that is not JSON is reported rather than crashing inside a component', async () => {
  stubFetch({ status: 200, text: '<!doctype html><title>proxy</title>' });

  const error = await request('/api/health').catch((thrown) => thrown);

  assert.equal(error.code, CLIENT_ERROR_CODES.UNEXPECTED_RESPONSE);
  assert.equal(error.status, 200);
});

test('an empty body is a valid answer, not a parse failure', async () => {
  stubFetch({ status: 200, text: '' });

  assert.equal(await request('/api/health'), null);
});

test('auth failures are recognisable by predicate, not by reading the message', async () => {
  stubFetch({ status: 401, body: { error: { code: 'SESSION_EXPIRED', message: 'Your session expired.' } } });

  const error = await auth.me().catch((thrown) => thrown);

  assert.ok(isAuthFailure(error));
  assert.ok(!isStaleRevision(error));
});

test('a proxy 502 with no coded body is reported as unreachable, with something to do about it', async () => {
  // What a dev-server proxy actually returns when the API is not running: an HTML body
  // and a gateway status. The old behaviour put "The server returned 502." on screen.
  stubFetch({ status: 502, text: '<html><body>Bad Gateway</body></html>' });

  const error = await auth.login('a@b.com', 'password123').catch((thrown) => thrown);

  assert.equal(error.code, CLIENT_ERROR_CODES.SERVER_UNREACHABLE);
  assert.equal(error.status, 502);
  assert.match(error.message, /not responding/);
  assert.doesNotMatch(error.message, /502/, 'a status number is not an instruction');
  assert.ok(isRetryable(error));
});

test('our own coded 503 keeps its code — the gateway branch must not swallow it', async () => {
  stubFetch({
    status: 503,
    body: { error: { code: 'LLM_RATE_LIMITED', message: 'The model is rate limited. Try again shortly.' } },
  });

  const error = await request('/api/kits').catch((thrown) => thrown);

  assert.equal(error.code, 'LLM_RATE_LIMITED');
  assert.match(error.message, /rate limited/);
});

test('any other uncoded failure keeps the status, which is all that is known', async () => {
  stubFetch({ status: 418, text: 'nope' });

  const error = await request('/api/kits').catch((thrown) => thrown);

  assert.equal(error.code, 'INTERNAL_ERROR');
  assert.match(error.message, /418/);
});

// --- the revision ledger ----------------------------------------------------

test('the ledger keeps the newest revision and ignores a late, older response', () => {
  const ledger = createKitRevisions();

  ledger.record('kit-1', 4);
  ledger.record('kit-1', 7);
  ledger.record('kit-1', 5); // a slow GET landing after a fast PATCH

  assert.equal(ledger.get('kit-1'), 7);
});

test('the ledger refuses anything that is not an integer revision', () => {
  const ledger = createKitRevisions();

  ledger.record('kit-1', undefined);
  ledger.record('kit-1', '3');
  ledger.record('kit-1', 2.5);
  ledger.record(null, 3);

  assert.equal(ledger.get('kit-1'), null);
});

test('reading a kit records its revision, and a write sends that number back', async () => {
  kitRevisions.clear();
  stubFetch({ body: { id: 'kit-9', status: 'ready', revision: 3, kit: {} }, url: 'http://localhost/api/kits/kit-9' });

  await kits.get('kit-9');
  assert.equal(kitRevisions.get('kit-9'), 3);

  const calls = stubFetch({ body: { id: 'kit-9', revision: 4, applied: [], kit: {} } });
  await kits.edit('kit-9', [{ type: 'pin', id: 'q1' }]);

  assert.equal(JSON.parse(calls[0].init.body).revision, 3, 'the write sends the revision that was read');
  assert.equal(kitRevisions.get('kit-9'), 4, 'and the response moves the ledger on');
});

test('the listing records a revision per row', async () => {
  kitRevisions.clear();
  stubFetch({
    body: {
      kits: [
        { id: 'a', revision: 1 },
        { id: 'b', revision: 6 },
      ],
    },
  });

  await kits.list();

  assert.equal(kitRevisions.get('a'), 1);
  assert.equal(kitRevisions.get('b'), 6);
});

test('a refused write records the revision the server actually holds', async () => {
  kitRevisions.clear();
  kitRevisions.record('kit-5', 2);

  stubFetch({
    status: 409,
    url: 'http://localhost/api/kits/kit-5',
    body: {
      error: {
        code: 'STALE_REVISION',
        message: 'This kit changed since you loaded it.',
        currentRevision: 9,
        expectedRevision: 2,
        kit: { questions: [] },
      },
    },
  });

  const error = await kits.edit('kit-5', [{ type: 'pin', id: 'q1' }]).catch((thrown) => thrown);

  assert.ok(isStaleRevision(error));
  assert.equal(error.currentRevision, 9);
  assert.equal(error.expectedRevision, 2);
  assert.ok(error.kit, 'the current kit travels with the conflict so the edit can be reapplied');
  assert.equal(kitRevisions.get('kit-5'), 9, 'so the retry does not repeat the same 409');
});

test('a write on a kit that was never read fails locally, before spending a round trip', async () => {
  kitRevisions.clear();
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error('should not be reached');
  };

  const error = await Promise.resolve()
    .then(() => kits.edit('never-read', [{ type: 'pin', id: 'q1' }]))
    .catch((thrown) => thrown);

  assert.equal(error.code, CLIENT_ERROR_CODES.REVISION_UNKNOWN);
  assert.equal(fetched, false);
});

test('deleting a kit forgets its revision', async () => {
  kitRevisions.clear();
  kitRevisions.record('gone', 3);
  stubFetch({ body: { ok: true, id: 'gone' } });

  await kits.remove('gone');

  assert.equal(kitRevisions.get('gone'), null);
});

test('signing out clears the ledger, even when the request itself fails', async () => {
  kitRevisions.clear();
  kitRevisions.record('kit-1', 5);
  stubFetch({ reject: new TypeError('fetch failed') });

  await auth.logout().catch(() => {});

  assert.deepEqual(kitRevisions.snapshot(), {}, 'a signed-out tab must not keep another account numbers');
});
