/**
 * orchestrator.test.js — the full pipeline, and the stage's exit check.
 *
 * Decides: that a seeded coverage gap is closed by the SECOND pass and that
 * coverage.passes reads 2; that every failure degrades rather than aborting; that the
 * governor drops only what it may; and that a resume skips work instead of repeating it.
 *
 * Does NOT decide: anything requiring Gemini. Every call is served by the fake provider,
 * so the suite costs nothing against a daily ceiling of twenty requests.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startFixtureServer } from '../../../fixtures/serve.js';
import { buildKit, BuildFailedError } from '../orchestrator/buildKit.js';
import { MAX_COVERAGE_PASSES } from '../orchestrator/coverageLoop.js';
import { createTimeGovernor, createUnboundedGovernor } from '../orchestrator/timeGovernor.js';
import {
  createMemoryCheckpointStore,
  toCheckpoint,
  fromCheckpoint,
  completedSteps,
} from '../orchestrator/checkpoints.js';
import { assembleKit } from '../orchestrator/assemble.js';
import { STEPS, STATUS } from '../orchestrator/steps.js';
import { createUrlGuard } from '../retrieval/urlGuard.js';
import { createPageFetcher } from '../retrieval/fetchPage.js';
import { createRobotsChecker } from '../retrieval/robots.js';
import { createNoopSearchProvider } from '../retrieval/searchPublicDiscussion.js';
import { createSourceLedger } from '../retrieval/sourceLedger.js';
import { createFakeProvider } from '../llm/fakeProvider.js';
import { createBudget } from '../llm/budget.js';
import { validateKit } from '../contracts/validateKit.js';
import { verifySchedule, SCHEDULE_VIOLATIONS } from '../deterministic/verifySchedule.js';
import { findGaps } from '../deterministic/coverage.js';

let server;
let fetcher;
let robots;

before(async () => {
  server = await startFixtureServer({ port: 0 });
  const guard = createUrlGuard({ allowPrivateHosts: true });
  fetcher = createPageFetcher({ guard, timeoutMs: 1500, retries: 1, retryDelayMs: 20 });
  robots = createRobotsChecker({ fetcher, userAgent: 'ai-interview-prep-kit/1.0' });
});

after(async () => {
  await server?.close();
});

const JD = [
  'Senior Backend Engineer — Kestrel Payments (London / remote)',
  '',
  'Requirements:',
  '• 8+ years building backend services',
  '• Deep expertise in Go',
  '• Postgres at scale, including partitioning',
  '• Rigorous approach to idempotency under retry',
].join('\n');

const REQUIREMENTS = [
  { text: '8+ years building backend services', kind: 'technical', priority: 'must', evidence: '8+ years building backend services' },
  { text: 'Deep expertise in Go', kind: 'technical', priority: 'must', evidence: 'Deep expertise in Go' },
  { text: 'Postgres at scale, including partitioning', kind: 'technical', priority: 'must', evidence: 'Postgres at scale, including partitioning' },
  { text: 'Rigorous approach to idempotency under retry', kind: 'technical', priority: 'must', evidence: 'Rigorous approach to idempotency under retry' },
];

const ROLE_PROFILE = {
  title: 'Senior Backend Engineer',
  seniority: 'senior',
  company: 'Kestrel Payments',
  location: 'London / remote',
  responsibilities: ['Own the double-entry ledger service'],
};

/**
 * Build a provider whose question calls drop `skipId` ONLY when it arrives batched with
 * other requirements.
 *
 * That is the real failure this stands in for: a requirement lost past a per-call batch
 * cap, or in a partially-failed category call. Asked about alone — as the gap-fill pass
 * does — it is answered. Sabotaging the gap-fill too would test nothing, because a gap
 * nobody can close is not a gap the loop is supposed to close.
 */
function providerDropping(skipId, extra = {}) {
  const answer = (label) => (request) => {
    const ids = [...String(request.contents).matchAll(/id: (r\d+)/g)].map((match) => match[1]);
    const batched = ids.length > 1;
    return {
      questions: ids
        .filter((id) => !(batched && id === skipId))
        .map((id, index) => ({
          requirement_id: id,
          prompt: `${label} question for ${id}`,
          answer_outline: 'mechanism, trade-off, failure mode',
          difficulty: (index % 3) + 1,
        })),
    };
  };

  return createFakeProvider({
    fallback: { questions: [] },
    responses: {
      'extract-requirements': { requirements: REQUIREMENTS },
      'extract-role-profile': ROLE_PROFILE,
      'hiring-page': { chosen_url: `${server.origin}/acme/handbook/how-we-hire`, confidence: 5, reason: 'stages' },
      'company-brief': {
        summary: 'Kestrel processes card payments for around 4,000 UK merchants, and this team owns the ledger.',
        what_they_do: 'Card payment processing for UK merchants.',
        grounded: 'yes',
      },
      'hiring-process': {
        has_process: 'yes',
        stages: [
          { name: 'Take-home', kind: 'take-home', order: 1, focus: 'close to our work' },
          { name: 'Systems design', kind: 'system-design', order: 2, focus: 'under load' },
        ],
        assessed: ['idempotency'],
        notes: '',
      },
      flashcards: { flashcards: [{ requirement_id: 'r1', front: 'Idempotency key?', back: 'A client-supplied token that makes a retry a no-op.' }] },
      'questions:technical': answer('technical'),
      'questions:behavioural': answer('behavioural'),
      'questions:system-design': answer('system-design'),
      'questions:company-fit': answer('company-fit'),
      ...extra,
    },
  });
}

/** A provider that covers everything, for tests not about gaps. */
function healthyProvider() {
  return providerDropping('__none__');
}

function baseDeps(provider, overrides = {}) {
  return {
    provider,
    fetcher,
    robots,
    searchProvider: createNoopSearchProvider(),
    governor: createUnboundedGovernor(),
    ...overrides,
  };
}

// ===========================================================================
// EXIT CHECK
// ===========================================================================

test('EXIT CHECK: the second pass closes a seeded gap and coverage.passes reads 2', async () => {
  const provider = providerDropping('r3');
  const events = [];

  const result = await buildKit(
    { jd: JD, company_url: `${server.origin}/acme/`, days: 4 },
    baseDeps(provider),
    { onProgress: (step, status, detail) => events.push({ step, status, detail }) }
  );

  // The gap existed on pass 1 and was gone on pass 2.
  const coverageEvents = events.filter((event) => event.step === STEPS.COVERAGE);
  assert.equal(coverageEvents[0].detail.uncoveredMust, 1, 'pass 1 must report the seeded gap');
  assert.equal(coverageEvents[1].detail.uncoveredMust, 0, 'pass 2 must report it closed');

  // The kit records what actually happened.
  assert.equal(result.kit.coverage.passes, 2, 'passes must read 2 — the passes that ran');
  assert.deepEqual(result.kit.coverage.uncovered_requirement_ids, []);

  // r3 genuinely has a question now, confirmed by the deterministic checker rather than
  // by trusting the loop's own opinion of itself.
  assert.ok(result.kit.questions.some((question) => question.requirement_ids.includes('r3')));
  assert.deepEqual(findGaps(result.kit.role.requirements, result.kit.questions).uncovered_must_ids, []);

  // And exactly one gap-fill call was needed.
  assert.equal(result.budget.breakdown[STEPS.GAP_FILL], 1);
  assert.equal(validateKit(result.kit).valid, true);
});

test('the coverage loop never exceeds its pass cap', async () => {
  // Nothing can close this gap: the provider refuses r3 in every shape of call.
  const stubborn = createFakeProvider({
    fallback: { questions: [] },
    responses: {
      'extract-requirements': { requirements: REQUIREMENTS },
      'extract-role-profile': ROLE_PROFILE,
      'company-brief': { summary: '', what_they_do: '', grounded: 'no' },
      flashcards: { flashcards: [] },
      'questions:technical': (request) => ({
        questions: [...String(request.contents).matchAll(/id: (r\d+)/g)]
          .map((match) => match[1])
          .filter((id) => id !== 'r3')
          .map((id) => ({ requirement_id: id, prompt: `q ${id}`, answer_outline: 'o', difficulty: 2 })),
      }),
    },
  });

  const result = await buildKit({ jd: JD, company_url: '', days: 3 }, baseDeps(stubborn), {});

  assert.ok(result.kit.coverage.passes <= MAX_COVERAGE_PASSES);
  assert.deepEqual(result.kit.coverage.uncovered_requirement_ids, ['r3'], 'the survivor is reported, not hidden');
  assert.ok(
    result.kit.run_notes.some((note) => /must-priority gap/.test(note)),
    'and the kit says so in its own notes'
  );
});

test('an uncovered must degrades the kit; it does not fail the build', async () => {
  const stubborn = providerDropping('r2', {
    // Refuse r2 even when asked alone, so it can never be covered.
    'questions:technical': (request) => ({
      questions: [...String(request.contents).matchAll(/id: (r\d+)/g)]
        .map((match) => match[1])
        .filter((id) => id !== 'r2')
        .map((id) => ({ requirement_id: id, prompt: `q ${id}`, answer_outline: 'o', difficulty: 2 })),
    }),
  });

  const events = [];
  const result = await buildKit({ jd: JD, company_url: '', days: 3 }, baseDeps(stubborn), {
    onProgress: (step, status, detail) => events.push({ step, status, detail }),
  });

  assert.ok(result.kit, 'a kit with an honest gap must still be returned');
  assert.deepEqual(result.kit.coverage.uncovered_requirement_ids, ['r2']);
  assert.equal(validateKit(result.kit).valid, true, 'and must still satisfy the contract');

  // The only scheduling violation is the coverage gap itself, which is exempt.
  assert.deepEqual(
    result.validation.schedule.violations.map((violation) => violation.code),
    [SCHEDULE_VIOLATIONS.MUST_HAS_NO_QUESTION]
  );
  const validateEvent = events.find((event) => event.step === STEPS.VALIDATE && event.status === STATUS.DEGRADED);
  assert.ok(validateEvent, 'validation should report degraded, not done');
});

// ===========================================================================
// Degradation
// ===========================================================================

test('an unreachable company site still produces a valid kit', async () => {
  const result = await buildKit(
    { jd: JD, company_url: `${server.origin}/does-not-exist/`, days: 3 },
    baseDeps(healthyProvider()),
    {}
  );

  assert.equal(validateKit(result.kit).valid, true);
  assert.deepEqual(result.kit.source.pages_used, [], 'nothing was retrieved');
  assert.equal(result.kit.role.requirements.length, 4, 'but the requirements survived');
  assert.match(result.kit.company_brief.summary, /could not be read/);
  assert.ok(result.kit.run_notes.some((note) => /yielded no readable pages/.test(note)));
});

test('the broken fixture site degrades with its skips recorded', async () => {
  const ledger = createSourceLedger();
  const result = await buildKit(
    { jd: JD, company_url: `${server.origin}/broken/`, days: 3 },
    baseDeps(healthyProvider(), { ledger }),
    {}
  );

  assert.equal(validateKit(result.kit).valid, true);
  assert.ok(ledger.report().skipped > 0, 'the failures were recorded');
  assert.ok(result.kit.questions.length > 0);
});

test('a failed category call leaves its requirements to the coverage pass', async () => {
  const provider = providerDropping('__none__', {
    // The behavioural call is blocked outright.
    'questions:behavioural': () => {
      throw Object.assign(new Error('blocked'), { code: 'LLM_CONTENT_BLOCKED' });
    },
  });

  const result = await buildKit({ jd: JD, company_url: '', days: 3 }, baseDeps(provider), {});

  assert.equal(validateKit(result.kit).valid, true);
  assert.ok(result.kit.questions.length > 0, 'the other categories still produced questions');
});

test('no requirements is the one fatal failure', async () => {
  const empty = createFakeProvider({ responses: { 'extract-requirements': { requirements: [] } } });

  await assert.rejects(
    buildKit({ jd: JD, company_url: '', days: 3 }, baseDeps(empty), {}),
    (error) => {
      assert.ok(error instanceof BuildFailedError);
      assert.equal(error.code, 'BUILD_NO_REQUIREMENTS');
      return true;
    }
  );
});

test('bad input is refused before any call is made', async () => {
  const provider = healthyProvider();

  await assert.rejects(buildKit({ jd: '', company_url: '', days: 3 }, baseDeps(provider), {}), /BUILD_NO_JD|required/);
  await assert.rejects(buildKit({ jd: JD, company_url: '', days: 0 }, baseDeps(provider), {}), /positive integer/);
  assert.equal(provider.callCount(), 0, 'a rejected input must not spend quota');
});

// ===========================================================================
// Budget and the time governor
// ===========================================================================

test('the whole pipeline stays inside the twelve-call budget', async () => {
  const budget = createBudget(12);
  const result = await buildKit(
    { jd: JD, company_url: `${server.origin}/acme/`, days: 5 },
    baseDeps(healthyProvider(), { budget }),
    {}
  );

  assert.ok(result.budget.spent <= 12, `spent ${result.budget.spent}: ${JSON.stringify(result.budget.breakdown)}`);
  assert.equal(validateKit(result.kit).valid, true);
});

test('an exhausted budget degrades instead of failing', async () => {
  // Enough for requirements and the role profile, and nothing else.
  const budget = createBudget(2);
  const result = await buildKit({ jd: JD, company_url: '', days: 3 }, baseDeps(healthyProvider(), { budget }), {});

  assert.equal(result.budget.remaining, 0);
  assert.equal(result.kit.role.requirements.length, 4, 'the expensive part that ran is kept');
  assert.equal(validateKit(result.kit).valid, true);
});

test('the governor drops flashcards but never the public discussion search', async () => {
  let clock = 0;
  const expired = createTimeGovernor({ softDeadlineMs: 1000, now: () => (clock += 5000) });

  const queries = [];
  const searchProvider = {
    name: 'probe',
    async search(query) {
      queries.push(query);
      return [];
    },
  };

  const events = [];
  const result = await buildKit(
    { jd: JD, company_url: '', days: 3 },
    baseDeps(healthyProvider(), { governor: expired, searchProvider }),
    { onProgress: (step, status, detail) => events.push({ step, status, detail }) }
  );

  assert.deepEqual(result.kit.flashcards, [], 'flashcards were dropped');
  assert.deepEqual(
    expired.skipped().map((entry) => entry.step),
    [STEPS.FLASHCARDS],
    'and they are the ONLY thing dropped'
  );

  assert.equal(queries.length, 1, 'the search still issued a real query');
  const searchDone = events.find(
    (event) => event.step === STEPS.PUBLIC_DISCUSSION && event.status !== STATUS.STARTED
  );
  assert.equal(searchDone.detail.attempted, true, 'attempted-and-empty scores; never-attempted does not');
  assert.equal(searchDone.detail.narrowed, true, 'and under pressure it narrowed rather than stopping');

  assert.equal(validateKit(result.kit).valid, true);
});

test('the governor refuses to skip any step that is not optional', () => {
  const governor = createTimeGovernor({ softDeadlineMs: 0, now: () => 1_000_000 });

  assert.equal(governor.mayRun(STEPS.FLASHCARDS), false);
  for (const step of [
    STEPS.REQUIREMENTS,
    STEPS.ROLE_PROFILE,
    STEPS.CRAWL,
    STEPS.HIRING_PAGE,
    STEPS.PUBLIC_DISCUSSION,
    STEPS.COMPANY_BRIEF,
    STEPS.QUESTIONS,
    STEPS.SCHEDULE,
  ]) {
    assert.equal(governor.mayRun(step), true, `${step} must never be skippable`);
  }
});

// ===========================================================================
// Assembly
// ===========================================================================

test('every source field is filled from its own origin', async () => {
  const result = await buildKit(
    { jd: JD, company_url: `${server.origin}/acme/`, days: 5 },
    baseDeps(healthyProvider()),
    {}
  );
  const { source } = result.kit;

  assert.equal(source.company, 'Kestrel Payments', 'from the role profile');
  assert.equal(source.company_url, `${server.origin}/acme/`, 'from the INPUT, not the crawl');
  assert.equal(source.role, 'Senior Backend Engineer', 'the advertised title, as a string');
  assert.equal(source.location, 'London / remote');
  assert.equal(source.jd_chars, JD.length, 'measured, not reported by a model');
  assert.match(source.researched_at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.ok(source.pages_used.length > 0, 'from the ledger');

  // source.role and the role object are different fields.
  assert.equal(typeof source.role, 'string');
  assert.equal(typeof result.kit.role, 'object');
  assert.equal(result.kit.role.title, source.role);
});

test('pages_used contains only URLs the ledger saw fetched', async () => {
  const ledger = createSourceLedger();
  const result = await buildKit(
    { jd: JD, company_url: `${server.origin}/broken/`, days: 3 },
    baseDeps(healthyProvider(), { ledger }),
    {}
  );

  for (const url of result.kit.source.pages_used) {
    assert.ok(ledger.wasFetched(url), `${url} is in pages_used but the ledger never saw it`);
  }
  assert.ok(
    !result.kit.source.pages_used.some((url) => url.includes('/broken/slow')),
    'a timed-out URL is not a source'
  );
});

test('assembleKit fills an empty run without inventing anything', () => {
  const ledger = createSourceLedger();
  const kit = assembleKit({
    input: { jd: 'short', company_url: 'http://x.test/', days: 2 },
    state: { roleProfile: {}, requirements: [], questions: [], coveragePasses: 0, notes: [] },
    schedule: { days_available: 2, days: [
      { day: 1, focus: 'No material extracted — see coverage notes', question_ids: [], minutes: 0 },
      { day: 2, focus: 'No material extracted — see coverage notes', question_ids: [], minutes: 0 },
    ] },
    ledger,
    researchedAt: '2026-09-11T00:00:00.000Z',
  });

  assert.equal(kit.source.company, '');
  assert.equal(kit.source.location, '', 'unknown is empty, never guessed');
  assert.equal(kit.source.jd_chars, 5);
  assert.equal(kit.source.researched_at, '2026-09-11T00:00:00.000Z');
  assert.equal(validateKit(kit).valid, true);
});

// ===========================================================================
// Resume
// ===========================================================================

test('a resume skips completed steps and re-fetches nothing', async () => {
  const store = createMemoryCheckpointStore();
  const input = { jd: JD, company_url: `${server.origin}/acme/`, days: 4, kitId: 'kit-resume' };

  let fetches = 0;
  const countingFetcher = createPageFetcher({
    guard: createUrlGuard({ allowPrivateHosts: true }),
    fetchImpl: async (url, options) => {
      fetches += 1;
      return globalThis.fetch(url, options);
    },
    timeoutMs: 1500,
    retries: 1,
    retryDelayMs: 20,
  });

  const first = healthyProvider();
  const run1 = await buildKit(input, baseDeps(first, { fetcher: countingFetcher, checkpointStore: store }), {});
  const firstFetches = fetches;

  assert.ok(first.callCount() > 1);
  assert.ok(firstFetches > 0);

  fetches = 0;
  const second = healthyProvider();
  const events = [];
  const run2 = await buildKit(
    { ...input, resumeFrom: 'kit-resume' },
    baseDeps(second, { fetcher: countingFetcher, checkpointStore: store }),
    { onProgress: (step, status, detail) => events.push({ step, status, detail }) }
  );

  assert.ok(second.callCount() < first.callCount(), 'a resume must cost fewer calls');
  assert.equal(fetches, 0, 'and no fetches at all — the page cache came back too');
  assert.ok(
    events.some((event) => event.detail.reason === 'RESUMED_FROM_CHECKPOINT'),
    'and it says which steps it skipped'
  );

  assert.deepEqual(run2.kit.role.requirements, run1.kit.role.requirements);
  assert.equal(validateKit(run2.kit).valid, true);
});

test('a checkpoint from a different posting is refused', async () => {
  const store = createMemoryCheckpointStore();
  const input = { jd: JD, company_url: '', days: 3, kitId: 'kit-mismatch' };

  await buildKit(input, baseDeps(healthyProvider(), { checkpointStore: store }), {});

  const provider = healthyProvider();
  const resumed = await buildKit(
    { ...input, jd: `${JD}\nAlso: Kubernetes.`, resumeFrom: 'kit-mismatch' },
    baseDeps(provider, { checkpointStore: store }),
    {}
  );

  assert.ok(
    resumed.notes.some((note) => /CHECKPOINT_INPUT_MISMATCH/.test(note)),
    'resuming onto another posting would mix two kits'
  );
  assert.ok(provider.callCount() > 1, 'so it rebuilt from scratch');
});

test('an unreadable checkpoint rebuilds instead of failing', async () => {
  const store = {
    async save() {},
    async load() {
      throw new Error('disk on fire');
    },
  };

  const result = await buildKit(
    { jd: JD, company_url: '', days: 3, kitId: 'kit-bad', resumeFrom: 'kit-bad' },
    baseDeps(healthyProvider(), { checkpointStore: store }),
    {}
  );

  assert.equal(validateKit(result.kit).valid, true);
  assert.ok(result.notes.some((note) => /Checkpoint not used/.test(note)));
});

test('a checkpoint save failure does not fail the build', async () => {
  const store = {
    async save() {
      throw new Error('read-only volume');
    },
    async load() {
      return null;
    },
  };

  const result = await buildKit({ jd: JD, company_url: '', days: 3, kitId: 'k' }, baseDeps(healthyProvider(), { checkpointStore: store }), {});

  assert.equal(validateKit(result.kit).valid, true);
  assert.ok(result.notes.some((note) => /Checkpoint save failed/.test(note)));
});

test('checkpoints persist what was expensive and nothing derived', () => {
  const record = toCheckpoint({
    kitId: 'k1',
    input: { jd: 'abc', company_url: 'http://x.test/', days: 3 },
    state: {
      requirements: [{ id: 'r1' }],
      roleProfile: { title: 'x' },
      questions: [{ id: 'q1' }],
      notes: ['a note'],
      coveragePasses: 2,
      uncovered: ['r9'],
    },
    cache: { toJSON: () => ({ version: 1, entries: [['http://x.test/', { ok: true }]] }) },
  });

  assert.ok('requirements' in record.state);
  assert.ok('questions' in record.state);
  assert.equal('coveragePasses' in record.state, false, 'a derived number must not be stored');
  assert.equal('uncovered' in record.state, false, 'nor a derived list');
  assert.equal(record.pageCache.entries.length, 1);

  const restored = fromCheckpoint(record, { jd: 'abc', company_url: 'http://x.test/', days: 3 });
  assert.equal(restored.ok, true);
  assert.deepEqual(completedSteps(record).sort(), [STEPS.QUESTIONS, STEPS.REQUIREMENTS, STEPS.ROLE_PROFILE].sort());
});

// ===========================================================================
// Both verifications
// ===========================================================================

test('a returned kit always satisfies validateKit AND verifySchedule', async () => {
  for (const days of [1, 3, 14]) {
    const result = await buildKit(
      { jd: JD, company_url: `${server.origin}/acme/`, days },
      baseDeps(healthyProvider()),
      {}
    );

    assert.equal(validateKit(result.kit).valid, true, `shape failed at ${days} days`);
    const semantics = verifySchedule(result.kit);
    const real = semantics.violations.filter((v) => v.code !== SCHEDULE_VIOLATIONS.MUST_HAS_NO_QUESTION);
    assert.deepEqual(real, [], `schedule failed at ${days} days`);
  }
});

test('progress events name a known step and a known status', async () => {
  const events = [];
  await buildKit({ jd: JD, company_url: '', days: 3 }, baseDeps(healthyProvider()), {
    onProgress: (step, status) => events.push({ step, status }),
  });

  const steps = new Set(Object.values(STEPS));
  const statuses = new Set(Object.values(STATUS));
  for (const event of events) {
    assert.ok(steps.has(event.step), `unknown step "${event.step}"`);
    assert.ok(statuses.has(event.status), `unknown status "${event.status}"`);
  }
  assert.ok(events.length > 10);
});

test('a throwing progress hook cannot break a build', async () => {
  const result = await buildKit({ jd: JD, company_url: '', days: 3 }, baseDeps(healthyProvider()), {
    onProgress: () => {
      throw new Error('the listener exploded');
    },
  });

  assert.equal(validateKit(result.kit).valid, true);
});
