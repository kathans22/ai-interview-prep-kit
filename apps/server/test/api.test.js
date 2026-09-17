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
import { mountScoreRoutes } from '../src/http/scoreRoutes.js';
import { LlmError, LLM_ERROR_CODES } from '@aipk/core/llm/provider.js';
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

/** Every scoring request the fake provider saw, so a test can check what was sent. */
const scoreCalls = [];

/** Every build the job runner started, in order — how a test proves one did NOT start. */
const builds = [];

/** marker -> { opened, open }: a build whose posting contains the marker waits for open(). */
const buildGates = new Map();

function gateBuild(marker) {
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  buildGates.set(marker, { opened, open });
  return open;
}

before(async () => {
  store = createMemoryStore();

  // A provider that returns one replacement question per requirement it is shown.
  const provider = {
    name: 'fake',
    model: 'fake',
    async complete(request) {
      // Scoring a typed answer: a requirement is "hit" when the answer mentions its id,
      // which lets each test choose its verdicts. BLOCK_ME simulates a safety block.
      if (request.step === 'answer-score') {
        scoreCalls.push(request);
        const [criteria = '', answerBlock = ''] = String(request.contents).split('<<<UNTRUSTED_DATA_BEGIN>>>').slice(1);
        if (answerBlock.includes('BLOCK_ME')) {
          // A typed, non-retryable error, as a real provider raises. A plain Error with a
          // code is treated by the retry layer as an unknown transport fault — retried
          // with backoff and reported as LLM_UNAVAILABLE, which is right for an unknown.
          throw new LlmError(LLM_ERROR_CODES.CONTENT_BLOCKED, 'Simulated safety block.', {
            step: request.step,
            retryable: false,
          });
        }
        const scoped = [...criteria.matchAll(/id: (r\d+)/g)].map((match) => match[1]);
        return {
          data: {
            requirements: scoped.map((id) => ({
              requirement_id: id,
              verdict: answerBlock.includes(id) ? 'hit' : 'missed',
              reason: 'test verdict',
            })),
            outline_points: [],
            improvement: 'Name the measurable outcome of what you did.',
          },
          raw: null,
          text: '',
        };
      }
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
    build: async (input) => {
      builds.push(input);
      // A posting naming a gate waits for the test to open it, so a build can be caught
      // genuinely in flight rather than hoped to be.
      const gate = [...buildGates.keys()].find((marker) => input.jd.includes(marker));
      if (gate) await buildGates.get(gate).opened;
      // A posting carrying this marker fails outright, as a build with no model would.
      if (input.jd.includes('FAIL_THIS_BUILD')) throw new Error('simulated total build failure');
      return { kit: seedKit(), notes: [] };
    },
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
    mountScoreRoutes(instance);
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
    ['POST', '/api/kits/batch', { cases: [{ id: 'a', jd: JD, days: 3 }] }],
    ['GET', '/api/kits', null],
    ['GET', '/api/kits/anything', null],
    ['GET', '/api/kits/anything/progress', null],
    ['GET', '/api/kits/anything/progress/poll', null],
    ['PATCH', '/api/kits/anything', { revision: 0, ops: [{ type: 'pin', id: 'q1' }] }],
    ['POST', '/api/kits/anything/regenerate', { section: 'questions', category: 'technical', revision: 0 }],
    ['POST', '/api/kits/anything/undo-regenerate', { section: 'questions', revision: 0 }],
    ['POST', '/api/kits/anything/resume', null],
    ['POST', '/api/kits/anything/practice', { questionId: 'q1', confidence: 3 }],
    ['GET', '/api/kits/anything/practice', null],
    ['POST', '/api/kits/anything/questions/q1/score', { answer: 'an answer long enough to be scored' }],
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
    ['POST', `/api/kits/${kitId}/resume`, null],
    ['POST', `/api/kits/${kitId}/practice`, { questionId: 'q1', confidence: 3 }],
    ['POST', `/api/kits/${kitId}/questions/q1/score`, { answer: 'an answer long enough to be scored' }],
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

test('a stale edit aimed at a question deleted since is a 409 with the current kit, not a 400', async () => {
  // Found by the builder's conflict check: the operations used to be judged before the
  // revision, so an edit to a question another tab had deleted came back "No question
  // with id" — a 400 the client rolls back on — instead of the conflict it really was.
  const alice = client();
  await alice.signUp('stale-deleted@example.com');
  const kitId = await giveKitTo('stale-deleted@example.com');
  const staleRevision = (await alice.call(`/api/kits/${kitId}`)).body.revision;

  const deleted = await alice.call(`/api/kits/${kitId}`, {
    method: 'PATCH',
    body: JSON.stringify({ revision: staleRevision, ops: [{ type: 'delete-question', id: 'q2' }] }),
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));

  const late = await alice.call(`/api/kits/${kitId}`, {
    method: 'PATCH',
    body: JSON.stringify({ revision: staleRevision, ops: [{ type: 'edit-question', id: 'q2', prompt: 'too late' }] }),
  });

  assert.equal(late.status, 409, JSON.stringify(late.body));
  assert.equal(late.body.error.code, 'STALE_REVISION');
  assert.equal(late.body.error.currentRevision, staleRevision + 1);
  assert.ok(late.body.error.kit, 'the conflict carries the kit to reapply onto');
  assert.equal(late.body.error.kit.questions.some((entry) => entry.id === 'q2'), false, 'and it is the current kit');

  // With the current revision, the same operation is judged — and refused — as before.
  const judged = await alice.call(`/api/kits/${kitId}`, {
    method: 'PATCH',
    body: JSON.stringify({ revision: staleRevision + 1, ops: [{ type: 'edit-question', id: 'q2', prompt: 'too late' }] }),
  });
  assert.equal(judged.status, 400);
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

/** PATCH a kit at its current revision and return the response. */
async function patchKit(who, kitId, ops) {
  const current = await who.call(`/api/kits/${kitId}`);
  return who.call(`/api/kits/${kitId}`, {
    method: 'PATCH',
    body: JSON.stringify({ revision: current.body.revision, ops }),
  });
}

/** A generated flashcard, as `stampKit` leaves one. */
const generatedCard = (id, requirementId) => ({
  id,
  front: `front of ${id}`,
  back: `back of ${id}`,
  requirement_ids: [requirementId],
  origin: 'generated',
  pinned: false,
  updatedAt: '2026-09-11T00:00:00.000Z',
});

test('a generated flashcard can be edited, and editing marks it edited', async () => {
  // Without this a regeneration could overwrite a card a person had improved.
  const alice = client();
  await alice.signUp('card-edit@example.com');
  const kitId = await giveKitTo('card-edit@example.com');
  await store.kits.write({ kitId, set: { 'kit.flashcards': [generatedCard('f1', 'r1')] } });

  const response = await patchKit(alice, kitId, [{ type: 'edit-flashcard', id: 'f1', front: '  MY FRONT  ' }]);

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const card = response.body.kit.flashcards.find((entry) => entry.id === 'f1');
  assert.equal(card.front, 'MY FRONT', 'trimmed');
  assert.equal(card.back, 'back of f1', 'the face not sent is left alone');
  assert.equal(card.origin, 'edited');
});

test('a flashcard added by hand is manual, and stays manual when edited', async () => {
  const alice = client();
  await alice.signUp('card-add@example.com');
  const kitId = await giveKitTo('card-add@example.com');

  const added = await patchKit(alice, kitId, [
    { type: 'add-flashcard', front: 'What is a closure?', back: 'A function plus its scope.', requirement_ids: ['r1'] },
  ]);
  assert.equal(added.status, 200, JSON.stringify(added.body));

  const card = added.body.kit.flashcards.at(-1);
  assert.match(card.id, /^f\d+$/);
  assert.equal(card.origin, 'manual');

  // Editing your own card must not relabel it as the model's work, corrected.
  const edited = await patchKit(alice, kitId, [{ type: 'edit-flashcard', id: card.id, back: 'Revised.' }]);
  assert.equal(edited.body.kit.flashcards.find((entry) => entry.id === card.id).origin, 'manual');
});

test('adding a flashcard for a requirement that does not exist is refused and writes nothing', async () => {
  const alice = client();
  await alice.signUp('card-bad-req@example.com');
  const kitId = await giveKitTo('card-bad-req@example.com');

  const response = await patchKit(alice, kitId, [
    { type: 'add-flashcard', front: 'x', back: 'y', requirement_ids: ['r99'] },
  ]);

  assert.equal(response.status, 400);
  assert.equal((await store.kits.findById(kitId)).kit.flashcards.length, 0);
});

test('a flashcard can be deleted, and an unknown one is a 400', async () => {
  const alice = client();
  await alice.signUp('card-delete@example.com');
  const kitId = await giveKitTo('card-delete@example.com');
  await store.kits.write({ kitId, set: { 'kit.flashcards': [generatedCard('f1', 'r1'), generatedCard('f2', 'r2')] } });

  const deleted = await patchKit(alice, kitId, [{ type: 'delete-flashcard', id: 'f1' }]);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(
    deleted.body.kit.flashcards.map((entry) => entry.id),
    ['f2']
  );

  const missing = await patchKit(alice, kitId, [{ type: 'delete-flashcard', id: 'f1' }]);
  assert.equal(missing.status, 400);
});

test('pin works on a flashcard as well as a question, resolved by the id prefix', async () => {
  const alice = client();
  await alice.signUp('card-pin@example.com');
  const kitId = await giveKitTo('card-pin@example.com');
  await store.kits.write({ kitId, set: { 'kit.flashcards': [generatedCard('f1', 'r1')] } });

  const pinned = await patchKit(alice, kitId, [
    { type: 'pin', id: 'f1' },
    { type: 'pin', id: 'q1' },
  ]);
  assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
  assert.equal(pinned.body.kit.flashcards.find((entry) => entry.id === 'f1').pinned, true);
  assert.equal(pinned.body.kit.questions.find((entry) => entry.id === 'q1').pinned, true);

  const unpinned = await patchKit(alice, kitId, [{ type: 'pin', id: 'f1', pinned: false }]);
  assert.equal(unpinned.body.kit.flashcards.find((entry) => entry.id === 'f1').pinned, false);

  const missing = await patchKit(alice, kitId, [{ type: 'pin', id: 'f9' }]);
  assert.equal(missing.status, 400);
});

/** A generated question, as `stampKit` leaves one. */
const generatedQuestion = (id, requirementId, category) => ({
  id,
  requirement_ids: [requirementId],
  category,
  prompt: `prompt of ${id}`,
  answer_outline: 'what a strong answer contains',
  difficulty: 2,
  origin: 'generated',
  pinned: false,
  updatedAt: '2026-09-11T00:00:00.000Z',
});

test('reordering a category moves only that category, and marks nothing edited', async () => {
  const alice = client();
  await alice.signUp('reorder@example.com');
  const kitId = await giveKitTo('reorder@example.com');
  await store.kits.write({
    kitId,
    set: {
      'kit.questions': [
        generatedQuestion('q1', 'r1', 'technical'),
        generatedQuestion('q2', 'r2', 'behavioural'),
        generatedQuestion('q3', 'r1', 'technical'),
        generatedQuestion('q4', 'r1', 'technical'),
      ],
    },
  });

  const response = await patchKit(alice, kitId, [
    { type: 'reorder-questions', category: 'technical', question_ids: ['q4', 'q1', 'q3'] },
  ]);

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(
    response.body.kit.questions.map((entry) => entry.id),
    ['q4', 'q2', 'q1', 'q3'],
    'the technical slots are refilled in the new order; the behavioural question keeps its slot'
  );
  // Order is arrangement, not content: nothing becomes protected from regeneration.
  assert.ok(response.body.kit.questions.every((entry) => entry.origin === 'generated'));
});

test('a reorder that does not list every question in the category exactly once is refused', async () => {
  const alice = client();
  await alice.signUp('reorder-bad@example.com');
  const kitId = await giveKitTo('reorder-bad@example.com');
  await store.kits.write({
    kitId,
    set: {
      'kit.questions': [
        generatedQuestion('q1', 'r1', 'technical'),
        generatedQuestion('q2', 'r2', 'behavioural'),
        generatedQuestion('q3', 'r1', 'technical'),
      ],
    },
  });

  for (const question_ids of [['q1'], ['q1', 'q1'], ['q1', 'q2'], ['q3', 'q1', 'q9']]) {
    const response = await patchKit(alice, kitId, [{ type: 'reorder-questions', category: 'technical', question_ids }]);
    assert.equal(response.status, 400, `expected a 400 for ${JSON.stringify(question_ids)}`);
  }

  const unknownCategory = await patchKit(alice, kitId, [
    { type: 'reorder-questions', category: 'trivia', question_ids: [] },
  ]);
  assert.equal(unknownCategory.status, 400);

  assert.deepEqual(
    (await store.kits.findById(kitId)).kit.questions.map((entry) => entry.id),
    ['q1', 'q2', 'q3'],
    'nothing was written'
  );
});

test('a drag across categories is one batch: move the question, then order its new category', async () => {
  const alice = client();
  await alice.signUp('reorder-move@example.com');
  const kitId = await giveKitTo('reorder-move@example.com');

  const response = await patchKit(alice, kitId, [
    { type: 'move-category', id: 'q2', category: 'technical' },
    { type: 'reorder-questions', category: 'technical', question_ids: ['q2', 'q1'] },
  ]);

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(
    response.body.kit.questions.map((entry) => [entry.id, entry.category]),
    [
      ['q2', 'technical'],
      ['q1', 'technical'],
    ]
  );
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
// EDGE CASE 7 — same description and company twice → idempotent, returns the existing kit
// ===========================================================================

/**
 * One account for every edge 7 test. Each posting carries its own marker, so the tests
 * cannot find each other's kits — and sign-up is rate limited per client, so five more
 * accounts would push later tests in this file over the limit.
 */
let edge7Account = null;
function edge7User() {
  edge7Account ??= (async () => {
    const user = client();
    await user.signUp('edge7@example.com');
    return user;
  })();
  return edge7Account;
}

test('edge 7: the same description and company, resubmitted once the kit is ready, returns that kit', async () => {
  const alice = await edge7User();

  const body = JSON.stringify({ jd: `${JD} edge7-ready`, company_url: 'https://kestrel.example/careers', days: 5 });
  const first = await alice.call('/api/kits', { method: 'POST', body });
  assert.equal(first.status, 202);
  await jobs.drain();

  const ready = await alice.call(`/api/kits/${first.body.kitId}`);
  assert.equal(ready.body.status, 'ready');
  const buildsBefore = builds.length;

  const second = await alice.call('/api/kits', { method: 'POST', body });

  assert.equal(second.status, 200, 'nothing new was accepted');
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.kitId, first.body.kitId, 'the existing kit is returned');
  assert.equal(second.body.status, 'ready', 'and the client is told it can open it now');
  assert.equal(second.body.reason, 'DUPLICATE_READY');
  assert.match(second.body.message, /already built/i);

  await jobs.drain();
  assert.equal(builds.length, buildsBefore, 'no second build ran, so no quota was spent twice');

  const reopened = await alice.call(`/api/kits/${second.body.kitId}`);
  assert.deepEqual(reopened.body.kit, ready.body.kit, 'it is the same kit, unchanged');
});

test('edge 7: a resubmission while the first is still building points at the build in flight', async () => {
  const alice = await edge7User();

  const open = gateBuild('edge7-inflight');
  const body = JSON.stringify({ jd: `${JD} edge7-inflight`, company_url: 'https://kestrel.example/', days: 5 });

  const first = await alice.call('/api/kits', { method: 'POST', body });
  assert.equal(first.status, 202);
  assert.notEqual((await alice.call(`/api/kits/${first.body.kitId}`)).body.status, 'ready', 'the build is held open');

  // The double click: the same submission again while the first is still being built.
  const second = await alice.call('/api/kits', { method: 'POST', body });
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.kitId, first.body.kitId, 'pointed at the build already running');
  assert.equal(second.body.reason, 'DUPLICATE_IN_FLIGHT');

  open();
  await jobs.drain();
  assert.equal((await alice.call(`/api/kits/${first.body.kitId}`)).body.status, 'ready');
  assert.equal(builds.filter((input) => input.jd.includes('edge7-inflight')).length, 1, 'one build for two clicks');
});

test('edge 7: differences that do not change the submission still find the existing kit', async () => {
  const alice = await edge7User();

  const jd = `${JD}\nedge7-cosmetic\n\nApply by Friday.`;
  const first = await alice.call('/api/kits', {
    method: 'POST',
    body: JSON.stringify({ jd, company_url: 'https://kestrel.example/careers', days: 5 }),
  });
  assert.equal(first.status, 202);
  await jobs.drain();

  // Windows line endings, trailing spaces, extra blank lines, surrounding whitespace, a
  // shouted hostname and a fragment: the same posting and the same company.
  const cosmetic = {
    jd: `  ${JD}   \r\nedge7-cosmetic  \r\n\r\n\r\n\r\nApply by Friday.\r\n  `,
    company_url: '  HTTPS://Kestrel.Example/careers#open-roles ',
    days: 5,
  };
  const again = await alice.call('/api/kits', { method: 'POST', body: JSON.stringify(cosmetic) });

  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.kitId, first.body.kitId);
});

test('edge 7: a different company, day count or description is a different kit', async () => {
  const alice = await edge7User();

  const submission = { jd: `${JD} edge7-different`, company_url: 'https://kestrel.example/', days: 5 };
  const original = await alice.call('/api/kits', { method: 'POST', body: JSON.stringify(submission) });
  assert.equal(original.status, 202);

  const variants = [
    { ...submission, company_url: 'https://heron.example/' },
    { ...submission, company_url: '' },
    { ...submission, days: 6 },
    { ...submission, jd: `${submission.jd} Also: on-call one week in six.` },
  ];
  const ids = new Set([original.body.kitId]);
  for (const variant of variants) {
    const response = await alice.call('/api/kits', { method: 'POST', body: JSON.stringify(variant) });
    assert.equal(response.status, 202, `${JSON.stringify(variant).slice(-60)} is a new submission`);
    assert.equal(response.body.duplicate, false);
    ids.add(response.body.kitId);
  }
  assert.equal(ids.size, variants.length + 1, 'every one got its own kit');

  await jobs.drain();
});

test('edge 7: a failed kit is not returned — resubmitting builds again', async () => {
  const alice = await edge7User();

  const body = JSON.stringify({ jd: `${JD} edge7-failed FAIL_THIS_BUILD`, company_url: 'https://kestrel.example/', days: 5 });
  const first = await alice.call('/api/kits', { method: 'POST', body });
  await jobs.drain();
  assert.equal((await alice.call(`/api/kits/${first.body.kitId}`)).body.status, 'failed');

  const retry = await alice.call('/api/kits', { method: 'POST', body });
  assert.equal(retry.status, 202, 'yesterday\'s transient failure must not block a retry');
  assert.equal(retry.body.duplicate, false);
  assert.notEqual(retry.body.kitId, first.body.kitId);

  await jobs.drain();
  assert.equal(builds.filter((input) => input.jd.includes('edge7-failed')).length, 2);
});

// ===========================================================================
// POST /api/kits/batch — named in Stage 9's brief, missing until it was audited
// ===========================================================================

function batchCase(id, days, extra = '') {
  return {
    id,
    jd: `${JD} Case ${id}.${extra}`,
    company_url: '',
    days,
  };
}

test('a batch creates one kit per case, each with its own days', async () => {
  const alice = client();
  await alice.signUp('batch@example.com');

  const response = await alice.call('/api/kits/batch', {
    method: 'POST',
    body: JSON.stringify({
      cases: [batchCase('one', 2), batchCase('two', 5), batchCase('three', 1)],
    }),
  });

  assert.equal(response.status, 202);
  assert.equal(response.body.accepted, 3);
  assert.equal(response.body.duplicates, 0);

  // Keyed by the id the CALLER gave, in input order — otherwise a client cannot tell
  // which of its cases produced which kit.
  assert.deepEqual(response.body.kits.map((entry) => entry.id), ['one', 'two', 'three']);
  assert.ok(response.body.kits.every((entry) => entry.kitId && entry.status === 'queued'));

  await jobs.drain();

  const listed = await alice.call('/api/kits');
  assert.equal(listed.body.kits.length, 3);
  // Each case's OWN days reached its kit. One default applied to all three would pass
  // every validator and be wrong for two of them.
  assert.deepEqual(listed.body.kits.map((kit) => kit.days).sort(), [1, 2, 5]);
});

test('a batch reports every case, including the ones that were duplicates', async () => {
  const alice = client();
  await alice.signUp('batch-dup@example.com');

  const cases = [batchCase('a', 2), batchCase('b', 3)];
  await alice.call('/api/kits/batch', { method: 'POST', body: JSON.stringify({ cases }) });
  await jobs.drain();

  // The same file again, plus one genuinely new case.
  const second = await alice.call('/api/kits/batch', {
    method: 'POST',
    body: JSON.stringify({ cases: [...cases, batchCase('c', 4)] }),
  });

  assert.equal(second.status, 202, 'something was still accepted, so 202');
  assert.equal(second.body.accepted, 1);
  assert.equal(second.body.duplicates, 2);
  assert.deepEqual(
    second.body.kits.map((entry) => entry.duplicate),
    [true, true, false]
  );

  await jobs.drain();
});

test('a batch of nothing but duplicates is a 200, not a 202', async () => {
  const alice = client();
  await alice.signUp('batch-alldup@example.com');

  const cases = [batchCase('x', 2)];
  await alice.call('/api/kits/batch', { method: 'POST', body: JSON.stringify({ cases }) });
  await jobs.drain();

  const again = await alice.call('/api/kits/batch', { method: 'POST', body: JSON.stringify({ cases }) });

  // Nothing was accepted for processing, which is the same distinction single creation
  // makes between 202 and 200.
  assert.equal(again.status, 200);
  assert.equal(again.body.accepted, 0);
  assert.match(again.body.message, /already built/i);
});

test('a batch reports every fault at once, and is capped for quota', async () => {
  const alice = client();
  await alice.signUp('batch-bad@example.com');

  const bad = await alice.call('/api/kits/batch', {
    method: 'POST',
    body: JSON.stringify({
      cases: [
        { id: 'ok', jd: JD, days: 3 },
        { id: '', jd: 'too short', days: 0 },
        { id: 'ok', jd: JD, days: 2 },
      ],
    }),
  });

  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_FAILED');
  const fields = bad.body.error.details.fields.map((entry) => entry.field);
  // Every fault in every case, at once. One error per submission would take as many
  // round trips as the file has typos.
  assert.ok(fields.some((field) => field.includes('[1].id')), 'missing id');
  assert.ok(fields.some((field) => field.includes('[1].jd')), 'short jd');
  assert.ok(fields.some((field) => field.includes('[1].days')), 'bad days');
  assert.ok(fields.some((field) => field.includes('[2].id')), 'duplicate id');

  // The cap is a quota guard: each kit costs up to twelve calls against twenty a day.
  const tooMany = await alice.call('/api/kits/batch', {
    method: 'POST',
    body: JSON.stringify({ cases: Array.from({ length: 9 }, (_, i) => batchCase(`n${i}`, 2)) }),
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error.message, /at most 5 cases/i);
});

test('a bare array is accepted as well as { cases: [...] }', async () => {
  const alice = client();
  await alice.signUp('batch-bare@example.com');

  const response = await alice.call('/api/kits/batch', {
    method: 'POST',
    body: JSON.stringify([batchCase('bare', 2)]),
  });

  assert.equal(response.status, 202);
  assert.equal(response.body.accepted, 1);
  await jobs.drain();
});

// ===========================================================================
// POST /api/kits/:id/resume — also named in the brief, also missing
// ===========================================================================

test('a failed kit can be resumed, and says it is starting over without a checkpoint', async () => {
  const alice = client();
  await alice.signUp('resume@example.com');

  const user = await store.users.findByEmail('resume@example.com');
  const record = await store.kits.create({
    userId: user.id,
    input: { jd: JD, company_url: '', days: 2 },
    jdHash: 'resume-hash',
    status: 'queued',
  });
  await store.kits.write({
    kitId: record.id,
    set: { status: 'failed', error: { code: 'LLM_UNAVAILABLE', message: 'the model was down', at: new Date() } },
  });

  const response = await alice.call(`/api/kits/${record.id}/resume`, { method: 'POST' });

  assert.equal(response.status, 202);
  assert.equal(response.body.status, 'queued');
  assert.equal(response.body.resumedFrom, 'the beginning');
  // Said plainly, because a rebuild and a resume cost very different amounts of a
  // twenty-a-day quota.
  assert.match(response.body.message, /no checkpoint/i);

  await jobs.drain();

  const after = await alice.call(`/api/kits/${record.id}`);
  // The old failure was cleared when it was requeued — leaving it would show the
  // previous error for the whole of the retry, which reads as "still broken".
  assert.equal(after.body.error, null);
});

test('a kit with a checkpoint resumes from it', async () => {
  const alice = client();
  await alice.signUp('resume-cp@example.com');

  const user = await store.users.findByEmail('resume-cp@example.com');
  const record = await store.kits.create({
    userId: user.id,
    input: { jd: JD, company_url: '', days: 2 },
    jdHash: 'resume-cp-hash',
    status: 'running',
  });
  await store.kits.write({
    kitId: record.id,
    set: { checkpoint: { version: 1, kitId: String(record.id), state: {}, input: {} } },
  });

  const response = await alice.call(`/api/kits/${record.id}/resume`, { method: 'POST' });

  assert.equal(response.status, 202);
  assert.equal(response.body.resumedFrom, 'checkpoint');
  await jobs.drain();
});

test('fresh:true ignores the checkpoint, discards it, and says so', async () => {
  // Without this flag the endpoint has ONE behaviour that depends on hidden state, so a
  // client cannot offer "continue" and "start over" as distinct actions — only one
  // button whose effect it explains afterwards.
  const alice = client();
  await alice.signUp('resume-fresh@example.com');

  const user = await store.users.findByEmail('resume-fresh@example.com');
  const record = await store.kits.create({
    userId: user.id,
    input: { jd: JD, company_url: '', days: 2 },
    jdHash: 'resume-fresh-hash',
    status: 'running',
  });
  await store.kits.write({
    kitId: record.id,
    set: { checkpoint: { version: 1, kitId: String(record.id), state: {}, input: {} } },
  });

  // Sanity: the same kit WOULD have resumed from the checkpoint.
  assert.equal((await alice.call(`/api/kits/${record.id}`)).body.hasCheckpoint, true);

  const response = await alice.call(`/api/kits/${record.id}/resume`, {
    method: 'POST',
    body: JSON.stringify({ fresh: true }),
  });

  assert.equal(response.status, 202, JSON.stringify(response.body));
  assert.equal(response.body.resumedFrom, 'the beginning');
  assert.match(response.body.message, /as asked/);

  // The checkpoint is gone, so an ordinary resume afterwards cannot silently pick up the
  // one the user just abandoned.
  await jobs.drain();
  assert.equal((await store.kits.findById(record.id)).checkpoint, null);
});

test('fresh must be a boolean — a string is refused, not coerced', async () => {
  // Coercing would make `fresh: "false"` start a rebuild.
  const alice = client();
  await alice.signUp('resume-coerce@example.com');

  const user = await store.users.findByEmail('resume-coerce@example.com');
  const record = await store.kits.create({
    userId: user.id,
    input: { jd: JD, company_url: '', days: 2 },
    jdHash: 'resume-coerce-hash',
    status: 'running',
  });

  const response = await alice.call(`/api/kits/${record.id}/resume`, {
    method: 'POST',
    body: JSON.stringify({ fresh: 'false' }),
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VALIDATION_FAILED');
  assert.equal((await store.kits.findById(record.id)).status, 'running', 'nothing was requeued');
});

test('the kit read says WHETHER there is a checkpoint, never the checkpoint itself', async () => {
  const alice = client();
  await alice.signUp('has-cp@example.com');

  const kitId = await giveKitTo('has-cp@example.com');
  const before = await alice.call(`/api/kits/${kitId}`);
  assert.equal(before.body.hasCheckpoint, false);
  assert.equal(before.body.checkpoint, undefined, 'it holds every expensive output — megabytes');

  await store.kits.write({
    kitId,
    set: { checkpoint: { version: 1, kitId: String(kitId), state: {}, input: {} } },
  });

  const after = await alice.call(`/api/kits/${kitId}`);
  assert.equal(after.body.hasCheckpoint, true);
  assert.equal(after.body.checkpoint, undefined);
});

test('a finished or unstarted kit cannot be resumed', async () => {
  const alice = client();
  await alice.signUp('resume-bad@example.com');

  const ready = await giveKitTo('resume-bad@example.com');
  const finished = await alice.call(`/api/kits/${ready}/resume`, { method: 'POST' });
  assert.equal(finished.status, 409);
  // Resuming a finished kit would rebuild something the user already has and spend a
  // fresh twelve calls doing it.
  assert.equal(finished.body.error.code, 'KIT_ALREADY_READY');

  const user = await store.users.findByEmail('resume-bad@example.com');
  const queued = await store.kits.create({
    userId: user.id,
    input: { jd: JD, company_url: '', days: 2 },
    jdHash: 'queued-hash',
    status: 'queued',
  });
  const notStarted = await alice.call(`/api/kits/${queued.id}/resume`, { method: 'POST' });
  assert.equal(notStarted.status, 409);
  assert.equal(notStarted.body.error.code, 'KIT_NOT_STARTED');
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

test('a flashcard is rated on its own four-point scale, and summarised per card', async () => {
  const alice = client();
  await alice.signUp('card-practice@example.com');
  const kitId = await giveKitTo('card-practice@example.com');
  await store.kits.write({ kitId, set: { 'kit.flashcards': [generatedCard('f1', 'r1'), generatedCard('f2', 'r2')] } });
  const rate = (body) => alice.call(`/api/kits/${kitId}/practice`, { method: 'POST', body: JSON.stringify(body) });

  const first = await rate({ cardId: 'f1', confidence: 1 });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.recorded.cardId, 'f1');
  assert.equal(first.body.recorded.questionId, undefined, 'a card rating is not also a question rating');

  const second = await rate({ cardId: 'f1', confidence: 4 });
  assert.deepEqual(
    [second.body.card.attempts, second.body.card.first, second.body.card.latest],
    [2, 1, 4],
    'again first, then easy: the trend is kept, not overwritten'
  );
  assert.ok(second.body.card.lastAt);

  const log = await alice.call(`/api/kits/${kitId}/practice`);
  assert.equal(log.body.total, 2);
  assert.deepEqual(log.body.cards.map((card) => [card.id, card.attempts, card.latest]), [['f1', 2, 4]]);
  assert.deepEqual(log.body.questions, []);
});

test('a card rating outside again..easy, for a missing card, or about two things at once is refused', async () => {
  const alice = client();
  await alice.signUp('card-practice-bad@example.com');
  const kitId = await giveKitTo('card-practice-bad@example.com');
  await store.kits.write({ kitId, set: { 'kit.flashcards': [generatedCard('f1', 'r1')] } });
  const rate = (body) => alice.call(`/api/kits/${kitId}/practice`, { method: 'POST', body: JSON.stringify(body) });

  for (const [body, why] of [
    [{ cardId: 'f1', confidence: 5 }, 'five is not one of the four card answers'],
    [{ cardId: 'f1', confidence: 0 }, 'below again'],
    [{ cardId: 'f1', confidence: 2.5 }, 'not a whole answer'],
    [{ cardId: 'f9', confidence: 2 }, 'no such card in this kit'],
    [{ cardId: 'f1', questionId: 'q1', confidence: 2 }, 'a rating is about one thing'],
    [{ confidence: 2 }, 'about nothing'],
  ]) {
    const response = await rate(body);
    assert.equal(response.status, 400, `${why}: ${JSON.stringify(response.body)}`);
  }

  assert.equal((await store.kits.findById(kitId)).practice.length, 0, 'nothing was written');

  // The question scale is untouched: 5 is still a valid question rating.
  assert.equal((await rate({ questionId: 'q1', confidence: 5 })).status, 201);
});

test('the practice read serves the deck least confident first, unseen cards in the middle', async () => {
  const alice = client();
  await alice.signUp('practice-deck@example.com');
  const kitId = await giveKitTo('practice-deck@example.com');
  await store.kits.write({
    kitId,
    set: { 'kit.flashcards': [generatedCard('f1', 'r1'), generatedCard('f2', 'r2'), generatedCard('f3', 'r1')] },
  });
  const rate = (body) => alice.call(`/api/kits/${kitId}/practice`, { method: 'POST', body: JSON.stringify(body) });

  // Before any rating the deck is simply the kit's order.
  const fresh = await alice.call(`/api/kits/${kitId}/practice`);
  assert.deepEqual(fresh.body.deck.map((card) => card.id), ['f1', 'f2', 'f3']);
  assert.ok(fresh.body.deck.every((card) => card.seen === false));

  await rate({ cardId: 'f1', confidence: 4 }); // easy
  await rate({ cardId: 'f2', confidence: 1 }); // again

  const next = await alice.call(`/api/kits/${kitId}/practice`);
  assert.deepEqual(
    next.body.deck.map((card) => [card.id, card.seen, card.latest]),
    [
      ['f2', true, 1],
      ['f3', false, null],
      ['f1', true, 4],
    ],
    'again first, the unseen card next, easy last'
  );
});

test('a requirement a scored answer missed pulls its cards forward, and a later hit lets them go back', async () => {
  const alice = client();
  await alice.signUp('practice-weak@example.com');
  const kitId = await giveKitTo('practice-weak@example.com');
  await store.kits.write({ kitId, set: { 'kit.flashcards': [generatedCard('f1', 'r1'), generatedCard('f2', 'r2')] } });
  const deckOf = async () => (await alice.call(`/api/kits/${kitId}/practice`)).body;
  const score = (answer) =>
    alice.call(`/api/kits/${kitId}/questions/q2/score`, { method: 'POST', body: JSON.stringify({ answer }) });

  let practice = await deckOf();
  assert.deepEqual(practice.deck.map((card) => card.id), ['f1', 'f2']);
  assert.deepEqual(practice.weakRequirements, []);

  // q2 covers r2; an answer that does not mention it misses it.
  assert.equal((await score('I would rather work alone and ship things quickly.')).status, 200);
  practice = await deckOf();
  assert.deepEqual(practice.weakRequirements, ['r2']);
  assert.deepEqual(
    practice.deck.map((card) => [card.id, card.weak]),
    [
      ['f2', true],
      ['f1', false],
    ],
    "r2's card comes first"
  );

  // A later answer that covers r2 clears the weak spot.
  assert.equal((await score('I mentored two juniors through weekly code review (r2).')).status, 200);
  practice = await deckOf();
  assert.deepEqual(practice.weakRequirements, []);
  assert.deepEqual(practice.deck.map((card) => card.id), ['f1', 'f2']);
});

// ===========================================================================
// Scoring a typed answer
// ===========================================================================

/** POST an answer to one question and return the response. */
function scoreAnswerFor(who, kitId, questionId, answer) {
  return who.call(`/api/kits/${kitId}/questions/${questionId}/score`, { method: 'POST', body: JSON.stringify({ answer }) });
}

test('a typed answer is scored against its question, and the verdict — not the answer — is recorded', async () => {
  const alice = client();
  await alice.signUp('score@example.com');
  const kitId = await giveKitTo('score@example.com');
  const before = (await alice.call(`/api/kits/${kitId}`)).body.revision;

  const answer = 'I built the dashboard in React and measured the render cost first (r1).';
  const response = await scoreAnswerFor(alice, kitId, 'q1', answer);

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.result.hitRequirementIds, ['r1']);
  assert.deepEqual(response.body.result.missedRequirementIds, []);
  assert.equal(response.body.result.improvement, 'Name the measurable outcome of what you did.');
  assert.equal(response.body.id, kitId);
  assert.equal(response.body.revision, before + 1, 'the new revision is returned so the client ledger follows it');
  assert.equal(response.body.budget.spent, 1);

  const stored = (await store.kits.findById(kitId)).scores;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].questionId, 'q1');
  assert.deepEqual(stored[0].verdicts, [{ requirementId: 'r1', verdict: 'hit' }]);
  assert.ok(!JSON.stringify(stored).includes('dashboard'), 'the typed answer itself is not stored');
});

test('only the requirements the question covers are sent to be scored against', async () => {
  const alice = client();
  await alice.signUp('score-scope@example.com');
  const kitId = await giveKitTo('score-scope@example.com');
  scoreCalls.length = 0;

  await scoreAnswerFor(alice, kitId, 'q1', 'An answer about React that mentions nothing else at all.');

  assert.equal(scoreCalls.length, 1);
  assert.ok(scoreCalls[0].contents.includes('5+ years with React'), "q1's requirement is sent");
  assert.ok(!scoreCalls[0].contents.includes('Mentoring juniors'), 'r2 belongs to q2 and is not');
});

test('a missed requirement is recorded as missed', async () => {
  const alice = client();
  await alice.signUp('score-miss@example.com');
  const kitId = await giveKitTo('score-miss@example.com');

  const response = await scoreAnswerFor(alice, kitId, 'q2', 'I prefer to work alone and ship quickly without reviews.');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.result.missedRequirementIds, ['r2']);
  assert.deepEqual((await store.kits.findById(kitId)).scores[0].missedRequirementIds, ['r2']);
});

test('an answer that cannot be scored is refused before any call, and nothing is recorded', async () => {
  const alice = client();
  await alice.signUp('score-bad@example.com');
  const kitId = await giveKitTo('score-bad@example.com');
  scoreCalls.length = 0;

  const short = await scoreAnswerFor(alice, kitId, 'q1', 'too short');
  assert.equal(short.status, 400);
  assert.equal(short.body.error.code, 'GENERATION_BAD_INPUT');
  assert.equal(short.body.error.details.reason, 'ANSWER_TOO_SHORT');
  assert.ok(!short.body.error.message.startsWith('answer-score'), 'the message is written for a person');

  const missing = await alice.call(`/api/kits/${kitId}/questions/q1/score`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'VALIDATION_FAILED');

  const unknown = await scoreAnswerFor(alice, kitId, 'q99', 'An answer long enough to be scored for sure.');
  assert.equal(unknown.status, 404);

  assert.equal(scoreCalls.length, 0, 'no model call was made for any of them');
  assert.equal((await store.kits.findById(kitId)).scores.length, 0);
});

test('a scoring call that fails records nothing and says why, without leaking its cause', async () => {
  const alice = client();
  await alice.signUp('score-fail@example.com');
  const kitId = await giveKitTo('score-fail@example.com');

  const response = await scoreAnswerFor(alice, kitId, 'q1', 'BLOCK_ME — an answer the provider refuses to read.');
  assert.equal(response.status, 422, JSON.stringify(response.body));
  assert.equal(response.body.error.code, 'LLM_CONTENT_BLOCKED');
  assert.equal(response.body.error.details, undefined, 'the underlying error stays in the log');
  assert.equal((await store.kits.findById(kitId)).scores.length, 0, 'a failure is not evidence of a weak area');
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
