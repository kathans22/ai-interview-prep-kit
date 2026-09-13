// score.test.js — the answer-scoring endpoint, over real HTTP against the memory store.
//
// Decides: that scoring is authenticated, owned, validated, recorded in the practice log
// with the missed requirement ids, and that a failed score touches nothing.
//
// Does NOT decide: how an answer is judged (core's `scoreAnswer`, covered by its own
// tests). Here the model is a fake that scores by a fixed script; the assertions are
// about the route's behaviour around it.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/http/app.js';
import { mountAuthRoutes } from '../src/http/authRoutes.js';
import { mountKitRoutes } from '../src/http/kitRoutes.js';
import { mountEditRoutes } from '../src/http/editRoutes.js';
import { mountPracticeRoutes } from '../src/http/practiceRoutes.js';
import { mountScoreRoutes } from '../src/http/scoreRoutes.js';
import { sessionMiddleware } from '../src/auth/session.js';
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
/** Every model request the fake provider saw, in order. */
const modelCalls = [];
/** When set, model calls fail with this code until cleared — retry will not save them. */
let failCallsWith = null;

const failWith = (code) => { failCallsWith = code; };
const clearFailure = () => { failCallsWith = null; };

let client;
let kitId;

function makeClient() {
  let cookie = null;
  return {
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
      return { status: response.status, body };
    },
    signUp(email, password = 'a long enough password') {
      return this.call('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
    },
  };
}

/** A complete, valid kit with one question covering r1 and r2. */
function seedKit() {
  return {
    source: {
      company: 'Acme Logistics',
      company_url: '',
      role: 'Senior Frontend Engineer',
      location: '',
      jd_chars: JD.length,
      researched_at: '2026-09-13T00:00:00.000Z',
      pages_used: [],
    },
    company_brief: { summary: 'Acme builds routing software.', what_they_do: 'Dispatch software.', sources: [] },
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
      {
        id: 'q1',
        requirement_ids: ['r1', 'r2'],
        category: 'technical',
        prompt: 'How do you keep a React codebase fast?',
        answer_outline: 'Memoisation, code splitting, and measuring before optimising.',
        difficulty: 2,
        origin: 'generated',
        pinned: false,
        updatedAt: '2026-09-13T00:00:00.000Z',
      },
      {
        id: 'q2',
        requirement_ids: ['r1'],
        category: 'technical',
        prompt: 'What does the memo hook actually memoise?',
        answer_outline: 'Referential equality between renders, and when it is worth it.',
        difficulty: 1,
        origin: 'generated',
        pinned: false,
        updatedAt: '2026-09-13T00:00:00.000Z',
      },
    ],
    flashcards: [],
    schedule: {
      days_available: 1,
      days: [
        {
          day: 1,
          focus: 'Technical depth',
          question_ids: ['q1'],
          minutes: 40,
          origin: 'generated',
          pinned: false,
          updatedAt: '2026-09-13T00:00:00.000Z',
        },
      ],
    },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
  };
}

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

  // Scores by script: one hit, one miss, score 3 — unless told to fail.
  const provider = {
    name: 'fake',
    model: 'fake',
    async complete(request) {
      modelCalls.push({ ...request, systemInstruction: String(request.systemInstruction ?? '') });
      if (failCallsWith) {
        const error = new Error('the model refused');
        error.code = failCallsWith;
        throw error;
      }
      return {
        data: {
          hits: [{ point: 'Memoisation', explanation: 'Named it directly.' }],
          misses: [{ point: 'Measuring before optimising', explanation: 'Never mentioned a profiler.' }],
          improvement: 'Open the profiler first and attach numbers to the slow render.',
          score: 3,
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
    mountAuthRoutes(instance, { rateLimit: createRateLimit({ limit: 50, windowMs: 60_000 }) });
    mountKitRoutes(instance, {
      startJob: (job) => jobs.start(job),
      rateLimit: createRateLimit({ limit: 50, windowMs: 60_000, keyBy: byUser }),
    });
    mountEditRoutes(instance);
    mountPracticeRoutes(instance);
    mountScoreRoutes(instance);
  });
  app.finalise();

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  client = makeClient();
  await client.signUp('scorer@example.com');
  kitId = await giveKitTo('scorer@example.com');
});

after(async () => {
  server?.close();
});

const SCORE_BODY = { answer: 'I would memoise the heavy components and split the bundle.' };
const scorePath = (kitId, questionId = 'q1') => `/api/kits/${kitId}/questions/${questionId}/score`;


test('signed out, scoring returns 401 and the model is never called', async () => {
  const calls = modelCalls.length;
  const anon = makeClient();
  const response = await anon.call(scorePath(kitId), { method: 'POST', body: JSON.stringify(SCORE_BODY) });
  assert.equal(response.status, 401);
  assert.equal(modelCalls.length, calls, 'a score nobody is allowed to ask for costs nothing');
});

test('a typed answer is scored, and the model sees ONLY this question\'s outline and requirements', async () => {
  const calls = modelCalls.length;
  const response = await client.call(scorePath(kitId), { method: 'POST', body: JSON.stringify(SCORE_BODY) });

  assert.equal(response.status, 201);
  assert.equal(response.body.score, 3);
  assert.equal(response.body.hits.length, 1);
  assert.equal(response.body.misses.length, 1);
  assert.match(response.body.improvement, /profiler/);
  assert.deepEqual(response.body.weakRequirementIds, ['r1', 'r2']);

  const request = modelCalls[calls];
  // The kit's own words are the criteria; the answer travels inside the fence as data.
  assert.match(request.contents, /Memoisation, code splitting, and measuring before optimising/);
  assert.match(request.contents, /r1: 5\+ years with React \[must\]/);
  assert.match(request.contents, /r2: Mentoring juniors \[must\]/, 'both requirements the question covers are sent');
  assert.match(request.systemInstruction, /ONLY against the provided outline and requirement text/);
});

test('only the requirements the question covers are sent — not the whole role', async () => {
  const calls = modelCalls.length;
  const response = await client.call(scorePath(kitId, 'q2'), { method: 'POST', body: JSON.stringify(SCORE_BODY) });

  assert.equal(response.status, 201);
  const request = modelCalls[calls];
  assert.match(request.contents, /r1: 5\+ years with React \[must\]/);
  assert.ok(!request.contents.includes('r2: Mentoring juniors'), 'a requirement the question does not test is not criteria');
  assert.deepEqual(response.body.weakRequirementIds, ['r1']);
});

test('the score is recorded in the practice log as a question rating, with the missed requirements', async () => {
  const response = await client.call(scorePath(kitId), { method: 'POST', body: JSON.stringify(SCORE_BODY) });
  assert.equal(response.status, 201);

  const history = await client.call(`/api/kits/${kitId}/practice`);
  assert.equal(history.status, 200);
  const entry = history.body.entries.find((item) => item.questionId === 'q1' && item.note === 'Scored answer');
  assert.ok(entry, 'the scored answer sits in the practice log');
  assert.equal(entry.confidence, 3, 'the model score, on the same 1–5 scale as a question rating');
  assert.deepEqual(entry.missedRequirements, ['r1', 'r2']);
  // And it is summarised with the question ratings, weakest first — where the practice
  // screen already looks.
  const summary = history.body.questions.find((item) => item.id === 'q1');
  assert.ok(summary, 'the scored answer counts as practice on this question');
  assert.equal(summary.latest, 3);
});

test('an empty answer is refused before the model is called', async () => {
  const calls = modelCalls.length;
  const response = await client.call(scorePath(kitId), { method: 'POST', body: JSON.stringify({ answer: '   ' }) });
  assert.equal(response.status, 400);
  assert.match(response.body.error?.message ?? response.body.message ?? '', /answer/);
  assert.equal(modelCalls.length, calls);
});

test('an unknown question id is refused without a model call', async () => {
  const calls = modelCalls.length;
  const response = await client.call(scorePath(kitId, 'q999'), { method: 'POST', body: JSON.stringify(SCORE_BODY) });
  assert.equal(response.status, 400);
  assert.match(response.body.error?.message ?? '', /q999/);
  assert.equal(modelCalls.length, calls);
});

test('a kit that has not finished building cannot be scored', async () => {
  const other = makeClient();
  await other.signUp('early@example.com');
  const user = await store.users.findByEmail('early@example.com');
  const record = await store.kits.create({
    userId: user.id,
    input: { jd: JD, company_url: '', days: 1 },
    jdHash: `hash-early-${Math.random()}`,
    status: 'running',
  });
  const response = await other.call(scorePath(String(record.id)), { method: 'POST', body: JSON.stringify(SCORE_BODY) });
  assert.equal(response.status, 409);
  assert.match(response.body.error?.message ?? '', /not finished building/);
});

test('another user\'s kit is invisible to the scorer', async () => {
  const other = makeClient();
  await other.signUp('neighbour@example.com');
  const otherKitId = await giveKitTo('neighbour@example.com');

  const response = await client.call(scorePath(otherKitId), { method: 'POST', body: JSON.stringify(SCORE_BODY) });
  assert.equal(response.status, 404, 'scoring someone else\'s question would leak its outline');
});

test('a model failure is a coded error, the log is untouched, and the kit still stands', async () => {
  failWith('LLM_RATE_LIMITED');
  const before2 = await client.call(`/api/kits/${kitId}/practice`);
  const response = await client.call(scorePath(kitId), { method: 'POST', body: JSON.stringify(SCORE_BODY) });
  clearFailure();

  assert.equal(response.status, 503);
  assert.equal(response.body.error?.code, 'LLM_UNAVAILABLE', 'a rate-limit storm exhausts retries into a transport failure');
  assert.match(response.body.error?.message ?? '', /could not be scored/);

  const after2 = await client.call(`/api/kits/${kitId}/practice`);
  assert.equal(after2.body.total, before2.body.total, 'a failed score records nothing');
});


