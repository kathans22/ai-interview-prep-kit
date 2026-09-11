/**
 * api.test.js — the HTTP surface, over real HTTP.
 *
 * Decides: that the stage's three exit checks hold, permanently —
 *   1. logged out, every kit endpoint returns 401
 *   2. a kit created by user A is invisible to user B
 *   3. a PATCH with a stale revision returns 409, not a silent overwrite
 *
 * Does NOT decide: anything requiring MongoDB or Gemini. The app takes its store and its
 * model provider as injected collaborators, so the entire surface — sessions, ownership,
 * conflicts, rate limits — runs in-process against a Map and a fake provider. A suite
 * that needed a database and an API key is a suite that stops being run, and these are
 * the assertions least affordable to stop running.
 *
 * Requests go through a real listening server and real `fetch`, not a mocked Express.
 * Cookies, status codes and headers are exactly what a browser would see; a mock would
 * let a bug in cookie attributes or CORS pass unnoticed.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/http/app.js';
import { mountAuthRoutes } from '../src/http/authRoutes.js';
import { mountKitRoutes } from '../src/http/kitRoutes.js';
import { mountEditRoutes } from '../src/http/editRoutes.js';
import { mountRegenerateRoutes } from '../src/http/regenerateRoutes.js';
import { mountPracticeRoutes } from '../src/http/practiceRoutes.js';
import { mountProgressRoutes } from '../src/http/progressRoutes.js';
import { sessionMiddleware, SESSION_COOKIE, encodeSession } from '../src/auth/session.js';
import { createMemoryStore } from '../src/store/memoryStore.js';
import { createRateLimit, byUser } from '../src/http/rateLimit.js';
import { createJobRunner } from '../src/jobs/buildJob.js';

const SECRET = 'a'.repeat(64);

const CONFIG = {
  env: 'test',
  isProduction: false,
  sessionSecret: SECRET,
  server: { port: 0, webOrigin: 'http://localhost:5173' },
  budgets: { idempotencyWindowMs: 900_000, maxLlmCallsPerKit: 12 },
};

const JD =
  'Senior Frontend Engineer — Acme Logistics. Requirements: 5+ years with React and TypeScript. Comfortable mentoring junior engineers.';

let server;
let base;
let store;
let jobs;

/** A cookie-keeping client, one per simulated browser. */
function client() {
  let cookie = null;
  return {
    setCookie(value) {
      cookie = value;
    },
    async call(path, options = {}) {
      const headers = { 'content-type': 'application/json', ...(options.headers ?? {}) };
      if (cookie) headers.cookie = cookie;
      const response = await fetch(base + path, { ...options, headers });
      const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await response.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: response.status, body, headers: response.headers };
    },
    signUp(email, password = 'a long enough password') {
      return this.call('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
    },
  };
}

/** A complete, valid kit, written straight into the store. */
function seedKit() {
  const question = (id, requirementId, category, prompt) => ({
    id,
    requirement_ids: [requirementId],
    category,
    prompt,
    answer_outline: 'what a strong answer contains',
    difficulty: 2,
    origin: 'generated',
    pinned: false,
    updatedAt: '2026-09-11T00:00:00.000Z',
  });

  return {
    source: {
      company: 'Acme Logistics',
      company_url: 'http://localhost:8099/acme/',
      role: 'Senior Frontend Engineer',
      location: '',
      jd_chars: JD.length,
      researched_at: '2026-09-11T00:00:00.000Z',
      pages_used: [],
    },
    company_brief: {
      summary: 'Acme builds routing software.',
      what_they_do: 'Dispatch software.',
      sources: [],
      provenance: {
        summary: { origin: 'generated', pinned: false, updatedAt: '2026-09-11T00:00:00.000Z' },
        what_they_do: { origin: 'generated', pinned: false, updatedAt: '2026-09-11T00:00:00.000Z' },
      },
    },
    role: {
      title: 'Senior Frontend Engineer',
      seniority: 'senior',
      responsibilities: [],
      requirements: [
        { id: 'r1', text: '5+ years with React', kind: 'technical', priority: 'must' },
        { id: 'r2', text: 'Mentoring juniors', kind: 'behavioural', priority: 'must' },
      ],
    },
    questions: [
      question('q1', 'r1', 'technical', 'original technical'),
      question('q2', 'r2', 'behavioural', 'original behavioural'),
    ],
    flashcards: [],
    schedule: {
      days_available: 1,
      days: [
        {
          day: 1,
          focus: 'Technical depth',
          question_ids: ['q1', 'q2'],
          minutes: 40,
          origin: 'generated',
          pinned: false,
          updatedAt: '2026-09-11T00:00:00.000Z',
        },
      ],
    },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
  };
}

/** Create a ready kit owned by `email`. */
async function giveKitTo(email) {
  const user = await store.users.findByEmail(email);
  const record = await store.kits.create({
    userId: user.id,
    input: { jd: JD, company_url: '', days: 1 },
    jdHash: `hash-${Math.random()}`,
    status: 'ready',
  });
  await store.kits.write({ kitId: record.id, set: { kit: seedKit() } });
  return String(record.id);
}

before(async () => {
  store = createMemoryStore();

  // A provider that returns one replacement question per requirement it is shown.
  const provider = {
    name: 'fake',
    model: 'fake',
    async complete(request) {
      const ids = [...String(request.contents).matchAll(/id: (r\d+)/g)].map((match) => match[1]);
      return {
        data: {
          questions: ids.map((id) => ({
            requirement_id: id,
            prompt: `REGENERATED for ${id}`,
            answer_outline: 'notes',
            difficulty: 3,
          })),
        },
        raw: null,
        text: '',
      };
    },
    async countTokens() {
      return 10;
    },
  };

  const app = createApp({ store, config: CONFIG, deps: { provider }, log: () => {} });
  app.use(sessionMiddleware());

  jobs = createJobRunner({
    store,
    build: async () => ({ kit: seedKit(), notes: [] }),
  });

  app.mountRoutes((instance) => {
    mountAuthRoutes(instance, {
      rateLimit: createRateLimit({ limit: 50, windowMs: 60_000 }),
    });
    mountKitRoutes(instance, {
      startJob: (job) => jobs.start(job),
      rateLimit: createRateLimit({ limit: 50, windowMs: 60_000, keyBy: byUser }),
    });
    mountProgressRoutes(instance, { jobs });
    mountEditRoutes(instance);
    mountRegenerateRoutes(instance);
    mountPracticeRoutes(instance);
  });
  app.finalise();

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
});

// ===========================================================================
// EXIT CHECK 1 — logged out, every kit endpoint is 401
// ===========================================================================

test('EXIT CHECK: signed out, every kit endpoint returns 401', async () => {
  const anon = client();

  const endpoints = [
    ['POST', '/api/kits', { jd: JD, days: 3 }],
    ['GET', '/api/kits', null],
    ['GET', '/api/kits/anything', null],
    ['GET', '/api/kits/anything/progress', null],
    ['GET', '/api/kits/anything/progress/poll', null],
    ['PATCH', '/api/kits/anything', { revision: 0, ops: [{ type: 'pin', id: 'q1' }] }],
    ['POST', '/api/kits/anything/regenerate', { section: 'questions', category: 'technical', revision: 0 }],
    ['POST', '/api/kits/anything/undo-regenerate', { section: 'questions', revision: 0 }],
    ['POST', '/api/kits/anything/practice', { questionId: 'q1', confidence: 3 }],
    ['GET', '/api/kits/anything/practice', null],
    ['DELETE', '/api/kits/anything', null],
  ];

  for (const [method, path, body] of endpoints) {
    const response = await anon.call(path, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    assert.equal(response.status, 401, `${method} ${path} should be 401 when signed out`);
    assert.equal(
      response.body.error.code,
      'NOT_AUTHENTICATED',
      `${method} ${path} should say why, so the client can route to a login`
    );
  }
});

test('a forged or expired cookie is refused with its own code', async () => {
  const forged = client();
  forged.setCookie(`${SESSION_COOKIE}=someone.9999999999999.notarealsignature`);
  const tampered = await forged.call('/api/kits');
  assert.equal(tampered.status, 401);
  assert.equal(tampered.body.error.code, 'SESSION_INVALID');

  const stale = client();
  stale.setCookie(
    `${SESSION_COOKIE}=${encodeSession({ userId: 'u1', expiresAt: Date.now() - 1000, secret: SECRET })}`
  );
  const expired = await stale.call('/api/kits');
  assert.equal(expired.status, 401);
  // Distinct from NOT_AUTHENTICATED: "your session expired" and "you never signed in"
  // send a user to different places.
  assert.equal(expired.body.error.code, 'SESSION_EXPIRED');
});

// ===========================================================================
// EXIT CHECK 2 — one user's kit is invisible to another
// ===========================================================================

test("EXIT CHECK: a kit created by user A is invisible to user B", async () => {
  const alice = client();
  const bob = client();
  await alice.signUp('isolation-alice@example.com');
  await bob.signUp('isolation-bob@example.com');

  const kitId = await giveKitTo('isolation-alice@example.com');

  assert.equal((await alice.call(`/api/kits/${kitId}`)).status, 200, 'alice can read her own kit');

  const attempts = [
    ['GET', `/api/kits/${kitId}`, null],
    ['GET', `/api/kits/${kitId}/progress/poll`, null],
    ['PATCH', `/api/kits/${kitId}`, { revision: 1, ops: [{ type: 'pin', id: 'q1' }] }],
    ['POST', `/api/kits/${kitId}/regenerate`, { section: 'questions', category: 'technical', revision: 1 }],
    ['POST', `/api/kits/${kitId}/practice`, { questionId: 'q1', confidence: 3 }],
    ['DELETE', `/api/kits/${kitId}`, null],
  ];

  for (const [method, path, body] of attempts) {
    const response = await bob.call(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 404, `bob should get 404 from ${method} ${path}`);
    assert.equal(response.body.error.code, 'KIT_NOT_FOUND');
  }

  // Alice's kit survived every one of those attempts.
  const after = await alice.call(`/api/kits/${kitId}`);
  assert.equal(after.status, 200);
  assert.equal(after.body.kit.questions.length, 2);
});

test("someone else's kit is indistinguishable from one that never existed", async () => {
  const alice = client();
  const bob = client();
  await alice.signUp('oracle-alice@example.com');
  await bob.signUp('oracle-bob@example.com');

  const realKit = await giveKitTo('oracle-alice@example.com');

  const hers = await bob.call(`/api/kits/${realKit}`);
  const imaginary = await bob.call('/api/kits/k_definitely_not_real');

  // Any difference here — status, code, or message — turns an id into an oracle that
  // tells an attacker which kits exist and how many the service holds.
  assert.equal(hers.status, imaginary.status);
  assert.deepEqual(hers.body, imaginary.body);
});

test("a user's listing contains only their own kits", async () => {
  const alice = client();
  const bob = client();
  await alice.signUp('list-alice@example.com');
  await bob.signUp('list-bob@example.com');

  await giveKitTo('list-alice@example.com');
  await giveKitTo('list-alice@example.com');
  await giveKitTo('list-bob@example.com');

  assert.equal((await alice.call('/api/kits')).body.kits.length, 2);
  assert.equal((await bob.call('/api/kits')).body.kits.length, 1);
});

// ===========================================================================
// EXIT CHECK 3 — a stale PATCH is a 409, never a silent overwrite
// ===========================================================================

test('EXIT CHECK: a PATCH with a stale revision returns 409, not a silent overwrite', async () => {
  const alice = client();
  await alice.signUp('conflict@example.com');
  const kitId = await giveKitTo('conflict@example.com');

  const initial = await alice.call(`/api/kits/${kitId}`);
  const staleRevision = initial.body.revision;

  // First edit lands.
  const first = await alice.call(`/api/kits/${kitId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      revision: staleRevision,
      ops: [{ type: 'edit-question', id: 'q1', prompt: 'THE FIRST EDIT' }],
    }),
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.revision, staleRevision + 1);

  // A second client still holding the old revision — the regeneration-lands-mid-edit
  // case the brief names.
  const second = await alice.call(`/api/kits/${kitId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      revision: staleRevision,
      ops: [{ type: 'edit-question', id: 'q1', prompt: 'THE SECOND EDIT' }],
    }),
  });

  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'STALE_REVISION');
  assert.equal(second.body.error.currentRevision, staleRevision + 1);
  assert.equal(second.body.error.expectedRevision, staleRevision);

  // The brief requires the CURRENT KIT in the conflict body, not just the revision:
  // with a number alone the client must fire a second request before it can recover,
  // and a client that does not know to do that drops the user's edit.
  assert.ok(second.body.error.kit, 'the 409 must carry the current kit');
  assert.equal(
    second.body.error.kit.questions.find((entry) => entry.id === 'q1').prompt,
    'THE FIRST EDIT',
    'and it must be the CURRENT kit, not the stale copy the client already had'
  );

  // The first edit is intact. This is the assertion that matters: a 409 that still
  // wrote would be worse than no check at all, because it would look safe.
  const current = await alice.call(`/api/kits/${kitId}`);
  assert.equal(current.body.kit.questions.find((entry) => entry.id === 'q1').prompt, 'THE FIRST EDIT');
});

test('an edit marks provenance, so a later regeneration cannot overwrite it', async () => {
  const alice = client();
  await alice.signUp('provenance@example.com');
  const kitId = await giveKitTo('provenance@example.com');

  let current = await alice.call(`/api/kits/${kitId}`);
  await alice.call(`/api/kits/${kitId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      revision: current.body.revision,
      ops: [{ type: 'edit-question', id: 'q1', prompt: 'MY EDIT' }],
    }),
  });

  current = await alice.call(`/api/kits/${kitId}`);
  assert.equal(current.body.kit.questions.find((entry) => entry.id === 'q1').origin, 'edited');

  const regenerated = await alice.call(`/api/kits/${kitId}/regenerate`, {
    method: 'POST',
    body: JSON.stringify({ section: 'questions', category: 'technical', revision: current.body.revision }),
  });

  assert.equal(regenerated.status, 200);
  assert.equal(
    regenerated.body.kit.questions.find((entry) => entry.id === 'q1').prompt,
    'MY EDIT',
    'a regeneration must not overwrite an edit'
  );
  assert.deepEqual(regenerated.body.report.kept, ['q1']);
});

test('undo restores the section, once', async () => {
  const alice = client();
  await alice.signUp('undo@example.com');
  const kitId = await giveKitTo('undo@example.com');

  let current = await alice.call(`/api/kits/${kitId}`);
  const originalPrompt = current.body.kit.questions.find((entry) => entry.id === 'q1').prompt;

  await alice.call(`/api/kits/${kitId}/regenerate`, {
    method: 'POST',
    body: JSON.stringify({ section: 'questions', category: 'technical', revision: current.body.revision }),
  });

  current = await alice.call(`/api/kits/${kitId}`);
  assert.equal(current.body.canUndo.questions, true);

  const undone = await alice.call(`/api/kits/${kitId}/undo-regenerate`, {
    method: 'POST',
    body: JSON.stringify({ section: 'questions', revision: current.body.revision }),
  });

  assert.equal(undone.status, 200);
  assert.equal(undone.body.kit.questions.find((entry) => entry.id === 'q1').prompt, originalPrompt);

  current = await alice.call(`/api/kits/${kitId}`);
  assert.equal(current.body.canUndo.questions, false, 'the snapshot is cleared as it is applied');

  const again = await alice.call(`/api/kits/${kitId}/undo-regenerate`, {
    method: 'POST',
    body: JSON.stringify({ section: 'questions', revision: current.body.revision }),
  });
  assert.equal(again.body.error.code, 'NOTHING_TO_UNDO');
});

// ===========================================================================
// Creation, idempotency, and the background job
// ===========================================================================

test('creating a kit returns immediately and the job fills it in', async () => {
  const alice = client();
  await alice.signUp('create@example.com');

  const created = await alice.call('/api/kits', {
    method: 'POST',
    body: JSON.stringify({ jd: JD, company_url: 'http://localhost:8099/acme/', days: 3 }),
  });

  // 202, not 201: the kit does not exist yet.
  assert.equal(created.status, 202);
  assert.equal(created.body.status, 'queued');
  assert.ok(created.body.kitId);

  await jobs.drain();

  const finished = await alice.call(`/api/kits/${created.body.kitId}`);
  assert.equal(finished.body.status, 'ready');
  assert.ok(finished.body.kit.questions.length > 0);

  // Progress was persisted, not only streamed, so a late reader still sees it.
  const poll = await alice.call(`/api/kits/${created.body.kitId}/progress/poll`);
  assert.equal(poll.body.done, true);
  assert.ok(poll.body.total > 0);
});

test('the same submission twice builds once', async () => {
  const alice = client();
  await alice.signUp('idempotent@example.com');

  const body = JSON.stringify({ jd: `${JD} unique-for-this-test`, company_url: '', days: 4 });
  const first = await alice.call('/api/kits', { method: 'POST', body });
  const second = await alice.call('/api/kits', { method: 'POST', body });

  assert.equal(first.status, 202);
  assert.equal(second.status, 200, 'nothing was accepted for processing the second time');
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.kitId, first.body.kitId);
  assert.match(second.body.message, /already built/i);

  await jobs.drain();
});

test('two users submitting the same posting each get their own kit', async () => {
  const alice = client();
  const bob = client();
  await alice.signUp('same-a@example.com');
  await bob.signUp('same-b@example.com');

  const body = JSON.stringify({ jd: `${JD} shared-posting`, company_url: '', days: 2 });
  const hers = await alice.call('/api/kits', { method: 'POST', body });
  const his = await bob.call('/api/kits', { method: 'POST', body });

  assert.equal(his.status, 202, 'idempotency is per user, never shared between them');
  assert.notEqual(his.body.kitId, hers.body.kitId);

  await jobs.drain();
});

// ===========================================================================
// Validation and error shape
// ===========================================================================

test('every error is { error: { code, message } }, and a 500 leaks nothing', async () => {
  const alice = client();
  await alice.signUp('errors@example.com');

  const bad = await alice.call('/api/kits', {
    method: 'POST',
    body: JSON.stringify({ jd: 'too short', days: '3' }),
  });

  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_FAILED');
  // Both faults, not just the first: a form that reports one error per submission
  // takes as many round trips as it has mistakes.
  assert.deepEqual(
    bad.body.error.details.fields.map((field) => field.field).sort(),
    ['days', 'jd']
  );

  // A malformed body is named by the parser layer, not left to surface as Express's
  // default HTML 400 — which a JSON client cannot read.
  const notJson = await alice.call('/api/kits', { method: 'POST', body: '{not json' });
  assert.equal(notJson.status, 400);
  assert.equal(notJson.body.error.code, 'VALIDATION_FAILED');
  assert.match(notJson.body.error.message, /not valid JSON/i);

  // An oversized body is refused by the cap rather than being buffered into memory.
  const huge = await alice.call('/api/kits', {
    method: 'POST',
    body: JSON.stringify({ jd: 'x'.repeat(600_000), days: 3 }),
  });
  assert.equal(huge.status, 413);
  assert.equal(huge.body.error.code, 'PAYLOAD_TOO_LARGE');

  // An unknown path is a JSON 404 in the same shape, not an HTML page.
  const missing = await alice.call('/api/nonsense');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});

test('a handler that throws becomes a 500 that says nothing about why', async () => {
  const exploding = createApp({
    store,
    config: CONFIG,
    deps: {},
    log: () => {},
  });
  exploding.mountRoutes((instance) => {
    instance.get('/api/boom', () => {
      throw new Error('connection string postgres://user:hunter2@10.0.0.4/prod refused');
    });
  });
  exploding.finalise();

  const listener = exploding.listen(0);
  await new Promise((resolve) => listener.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/boom`);
  const body = await response.json();
  listener.close();

  assert.equal(response.status, 500);
  // The message must not be echoed. An unexpected throw is the one case where the text
  // was written for a developer, and it routinely contains a path, a query, or a
  // credential — which is exactly what must not reach a browser.
  assert.doesNotMatch(JSON.stringify(body), /hunter2|10\.0\.0\.4|postgres/);
  assert.equal(body.error.code, 'INTERNAL_ERROR');
});

test('a kit that has not finished building cannot be edited', async () => {
  const alice = client();
  await alice.signUp('notready@example.com');

  const user = await store.users.findByEmail('notready@example.com');
  const record = await store.kits.create({
    userId: user.id,
    input: { jd: JD, company_url: '', days: 1 },
    jdHash: 'pending-hash',
    status: 'running',
  });

  const response = await alice.call(`/api/kits/${record.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ revision: 0, ops: [{ type: 'pin', id: 'q1' }] }),
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'KIT_NOT_READY');
});

test('an edit that would invalidate the kit is refused before it is stored', async () => {
  const alice = client();
  await alice.signUp('invalid@example.com');
  const kitId = await giveKitTo('invalid@example.com');

  const current = await alice.call(`/api/kits/${kitId}`);
  const response = await alice.call(`/api/kits/${kitId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      revision: current.body.revision,
      ops: [{ type: 'edit-question', id: 'q1', difficulty: 9 }],
    }),
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /invalid/i);

  // Nothing was written.
  const after = await alice.call(`/api/kits/${kitId}`);
  assert.equal(after.body.revision, current.body.revision);
  assert.equal(after.body.kit.questions.find((entry) => entry.id === 'q1').difficulty, 2);
});

test('practice ratings are recorded beside the kit, not inside it', async () => {
  const alice = client();
  await alice.signUp('practice@example.com');
  const kitId = await giveKitTo('practice@example.com');

  await alice.call(`/api/kits/${kitId}/practice`, {
    method: 'POST',
    body: JSON.stringify({ questionId: 'q1', confidence: 2, note: 'blanked' }),
  });
  const second = await alice.call(`/api/kits/${kitId}/practice`, {
    method: 'POST',
    body: JSON.stringify({ questionId: 'q1', confidence: 5 }),
  });

  assert.equal(second.status, 201);
  assert.equal(second.body.question.attempts, 2);
  assert.equal(second.body.question.first, 2);
  assert.equal(second.body.question.latest, 5);

  const log = await alice.call(`/api/kits/${kitId}/practice`);
  assert.equal(log.body.total, 2);

  // The kit itself is unchanged: a regeneration must never be able to delete a record
  // of what a person actually did.
  const kit = await alice.call(`/api/kits/${kitId}`);
  assert.equal(kit.body.kit.questions.find((entry) => entry.id === 'q1').prompt, 'original technical');
});

test('rate limiting refuses with a retry hint rather than failing opaquely', async () => {
  const limited = createRateLimit({ limit: 1, windowMs: 60_000, keyBy: () => 'fixed' });
  const calls = [];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const headers = {};
    // eslint-disable-next-line no-await-in-loop
    const error = await new Promise((resolve) => {
      limited({}, { setHeader: (key, value) => { headers[key] = value; } }, resolve);
    });
    calls.push({ blocked: Boolean(error), code: error?.code, retryAfter: headers['retry-after'] });
  }

  assert.equal(calls[0].blocked, false);
  assert.equal(calls[1].blocked, true);
  assert.equal(calls[1].code, 'RATE_LIMITED');
  assert.ok(Number(calls[1].retryAfter) > 0, 'a refusal must say when to come back');
});
