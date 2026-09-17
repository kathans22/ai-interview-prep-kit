/**
 * edgeCases.test.js — the brief's edge case list, each row run through a whole build.
 *
 * Decides: that every listed edge case ends in the outcome the brief names, judged on the
 * KIT a person would receive. The layers below have their own tests (a 404 in retrieval, a
 * repair in the LLM layer); those prove a function behaves. These prove the behaviour
 * survives the orchestrator and reaches what the candidate reads.
 *
 * Does NOT decide: anything requiring Gemini or the internet. The company sites are the
 * local fixture server, DNS is injected, and every model call is the offline fixture
 * provider or the fake one. `npm test` from a clean clone runs this with no network.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { startFixtureServer } from '../../../fixtures/serve.js';
import { buildKit, BuildFailedError } from '../orchestrator/buildKit.js';
import { createUnboundedGovernor } from '../orchestrator/timeGovernor.js';
import { STEPS, STATUS } from '../orchestrator/steps.js';
import { createUrlGuard, URL_SKIP_REASONS } from '../retrieval/urlGuard.js';
import { createPageFetcher } from '../retrieval/fetchPage.js';
import { createRobotsChecker } from '../retrieval/robots.js';
import { createNoopSearchProvider, SEARCH_REASONS } from '../retrieval/searchPublicDiscussion.js';
import { HIRING_PAGE_REASONS } from '../retrieval/findHiringPage.js';
import { createSourceLedger } from '../retrieval/sourceLedger.js';
import { createFixtureProvider } from '../llm/offlineProvider.js';
import { createGeminiProvider, LLM_ERROR_CODES } from '../llm/provider.js';
import { fakeResponse } from '../llm/fakeProvider.js';
import { validateKit } from '../contracts/validateKit.js';
import { verifySchedule } from '../deterministic/verifySchedule.js';
import { findGaps } from '../deterministic/coverage.js';

let server;

before(async () => {
  server = await startFixtureServer({ port: 0 });
});

after(async () => {
  await server?.close();
});

const JD = [
  'Senior Backend Engineer — Kestrel Payments (London / remote)',
  '',
  'Kestrel processes card payments for UK merchants, and this team owns the ledger service',
  'that every settlement passes through. You will design, build and operate it with us.',
  '',
  'Requirements:',
  '• 8+ years building backend services',
  '• Deep expertise in Go',
  '• Postgres at scale, including partitioning',
  '• Rigorous approach to idempotency under retry',
  '• Mentoring engineers through code review',
].join('\n');

/** What the kit tells a candidate when the company's own pages could not be read. */
const UNREAD_BRIEF = /company website could not be read/i;

/**
 * Dependencies for one build. The fetcher is short-fused so the hanging route costs well
 * under a second, and DNS is injectable so an unresolvable host needs no resolver.
 */
function deps({ lookup, timeoutMs = 300, ...overrides } = {}) {
  const guard = createUrlGuard({ allowPrivateHosts: true, ...(lookup ? { lookup } : {}) });
  const fetcher = createPageFetcher({ guard, timeoutMs, retries: 1, retryDelayMs: 10 });
  return {
    provider: createFixtureProvider(),
    fetcher,
    robots: createRobotsChecker({ fetcher, userAgent: 'ai-interview-prep-kit/1.0' }),
    searchProvider: createNoopSearchProvider(),
    governor: createUnboundedGovernor(),
    ...overrides,
  };
}

/** The progress events one step emitted, in order. */
function eventsFor(result, step) {
  return result.events.filter((event) => event.step === step);
}

/** A port nothing is listening on: bind one, note it, release it. */
async function closedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** The assertions every unreadable-site row shares: a whole kit, honest about the gap. */
function assertKitSaysSiteUnread(result, companyUrl) {
  const { kit } = result;
  const verdict = validateKit(kit);
  assert.equal(verdict.valid, true, JSON.stringify(verdict.errors));

  // Produced: the job description alone still yields a full kit.
  assert.ok(kit.role.requirements.length >= 4, 'the requirements survived');
  assert.ok(kit.questions.length > 0, 'questions were still written');
  assert.ok(kit.schedule.days.length > 0, 'a schedule was still made');

  // Says so: in the brief a candidate reads, and in the notes naming the URL.
  assert.match(kit.company_brief.summary, UNREAD_BRIEF);
  assert.equal(kit.company_brief.what_they_do, '', 'nothing is invented about the company');
  assert.deepEqual(kit.company_brief.sources, []);
  assert.deepEqual(kit.source.pages_used, []);
  assert.ok(
    kit.run_notes.some((note) => note.includes(companyUrl) && /no readable pages/.test(note)),
    `run notes should name the unreadable site: ${JSON.stringify(kit.run_notes)}`
  );
}

// ===========================================================================
// EDGE CASE 1 — company URL invalid, 404, or timing out → kit produced, brief says so
// ===========================================================================

test('edge 1: a malformed company URL still produces a kit whose brief says the site was not read', async () => {
  const companyUrl = 'not a url at all';
  const result = await buildKit({ jd: JD, company_url: companyUrl, days: 5 }, deps(), {});

  assertKitSaysSiteUnread(result, companyUrl);
  assert.equal(result.state.crawl.skipped[0].reason, URL_SKIP_REASONS.MALFORMED);
});

test('edge 1: a host that does not resolve still produces a kit whose brief says so', async () => {
  const companyUrl = 'https://kestrel-payments.invalid/';
  const lookup = async (hostname) => {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
  };
  const result = await buildKit({ jd: JD, company_url: companyUrl, days: 5 }, deps({ lookup }), {});

  assertKitSaysSiteUnread(result, companyUrl);
  assert.equal(result.state.crawl.skipped[0].reason, URL_SKIP_REASONS.DNS_FAILED);
});

test('edge 1: a company site returning 404 still produces a kit whose brief says so', async () => {
  const companyUrl = `${server.origin}/does-not-exist/`;
  const result = await buildKit({ jd: JD, company_url: companyUrl, days: 5 }, deps(), {});

  assertKitSaysSiteUnread(result, companyUrl);
  const [skip] = result.state.crawl.skipped;
  assert.equal(skip.status, 404);
  assert.match(skip.reason, /HTTP/);
});

test('edge 1: a company site that never answers times out and still produces a kit', async () => {
  const companyUrl = `${server.origin}/broken/slow`;
  const started = Date.now();
  const result = await buildKit({ jd: JD, company_url: companyUrl, days: 5 }, deps({ timeoutMs: 250 }), {});

  assertKitSaysSiteUnread(result, companyUrl);
  assert.match(result.state.crawl.skipped[0].reason, /TIMEOUT/);
  assert.ok(Date.now() - started < 5_000, 'the timeout bounded the wait; the build did not hang');
});

test('edge 1: a company site refusing connections still produces a kit whose brief says so', async () => {
  const companyUrl = `http://127.0.0.1:${await closedPort()}/`;
  const result = await buildKit({ jd: JD, company_url: companyUrl, days: 5 }, deps(), {});

  assertKitSaysSiteUnread(result, companyUrl);
  assert.equal(result.state.crawl.skipped.length > 0, true, 'the refusal was recorded as a skip');
});

// ===========================================================================
// EDGE CASE 2 — no discoverable hiring or about page → honest brief, NO_HIRING_PAGE_FOUND
// ===========================================================================

/**
 * A company site that is one page and nothing else: no about page, no careers link, no
 * navigation at all. The fixture server has no such site, so this serves one.
 */
async function startOnePageSite() {
  const site = http.createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><head><title>Kestrel Payments</title></head><body>' +
          '<main><h1>Kestrel Payments</h1><p>Card acceptance for independent UK merchants. ' +
          'Settlement the next working day, and one flat fee on every transaction.</p></main>' +
          '</body></html>'
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${site.address().port}`,
    close: () => new Promise((resolve) => site.close(resolve)),
  };
}

/** Honest: grounded only in pages the crawl actually read, and silent on hiring. */
function assertHonestBriefWithoutHiringPage(result) {
  const { kit, state } = result;
  assert.equal(validateKit(kit).valid, true);

  const read = new Set(state.crawl.pages.map((page) => page.url));
  assert.ok(read.size > 0, 'the site itself was readable');
  assert.doesNotMatch(kit.company_brief.summary, UNREAD_BRIEF, 'the site was read, so the brief must not say otherwise');
  assert.ok(kit.company_brief.sources.length > 0, 'the brief cites what it read');
  for (const source of kit.company_brief.sources) {
    assert.ok(read.has(source), `the brief cites ${source}, which the crawl never read`);
  }

  // No hiring page means no hiring process: the step is skipped, and no model call is
  // spent inventing one.
  assert.equal(state.hiringPage, null);
  assert.equal(state.hiringProcess, null);
  const [skipped] = eventsFor(result, STEPS.HIRING_PROCESS);
  assert.equal(skipped.status, STATUS.SKIPPED);
  assert.equal(skipped.reason, 'NO_HIRING_PAGE');
  assert.equal(
    kit.questions.length > 0 && kit.schedule.days.length > 0,
    true,
    'the rest of the kit was built as normal'
  );
}

test('edge 2: a site with no hiring page gives an honest brief and records NO_HIRING_PAGE_FOUND', async () => {
  const provider = createFixtureProvider();
  const result = await buildKit(
    { jd: JD, company_url: `${server.origin}/nohire/`, days: 5 },
    deps({ provider }),
    {}
  );

  assertHonestBriefWithoutHiringPage(result);
  assert.equal(result.state.hiringPageReason, HIRING_PAGE_REASONS.NONE_FOUND);
  assert.equal(HIRING_PAGE_REASONS.NONE_FOUND, 'NO_HIRING_PAGE_FOUND');
  assert.ok(result.kit.run_notes.includes('No hiring page found (NO_HIRING_PAGE_FOUND).'));

  const [found] = eventsFor(result, STEPS.HIRING_PAGE).filter((event) => event.status !== STATUS.STARTED);
  assert.equal(found.status, STATUS.DEGRADED, 'a missing hiring page degrades; it is not a failure');
  assert.equal(found.url, null);
  assert.equal(
    provider.calls.some((call) => call.step === 'hiring-process'),
    false,
    'no call was spent reading a hiring process from a page that is not one'
  );
});

test('edge 2: a one-page site with no about or hiring page is still briefed from that page alone', async () => {
  const site = await startOnePageSite();
  try {
    const result = await buildKit({ jd: JD, company_url: `${site.origin}/`, days: 5 }, deps(), {});

    assertHonestBriefWithoutHiringPage(result);
    assert.deepEqual(result.kit.company_brief.sources, [`${site.origin}/`]);
    // The root page is the only candidate, and it is not a hiring page.
    assert.equal(result.state.hiringPageReason, HIRING_PAGE_REASONS.NONE_FOUND);
    assert.ok(result.kit.run_notes.some((note) => /No hiring page found/.test(note)));
  } finally {
    await site.close();
  }
});

// ===========================================================================
// EDGE CASE 4 — no public discussion found → recorded, not an error
// ===========================================================================

/** The search step's outcome, as the progress stream and the ledger recorded it. */
function searchOutcome(result) {
  return eventsFor(result, STEPS.PUBLIC_DISCUSSION).filter((event) => event.status !== STATUS.STARTED);
}

test('edge 4: a search that finds nothing is recorded as attempted and empty, not as an error', async () => {
  const ledger = createSourceLedger();
  const queries = [];
  const searchProvider = {
    name: 'empty',
    async search(query) {
      queries.push(query);
      return [];
    },
  };

  const result = await buildKit(
    { jd: JD, company_url: `${server.origin}/acme/`, days: 5 },
    deps({ searchProvider, ledger }),
    {}
  );

  assert.equal(validateKit(result.kit).valid, true);
  assert.equal(queries.length, 1, 'the search genuinely ran');
  assert.match(queries[0], /Kestrel Payments/);

  assert.equal(result.state.search.attempted, true);
  assert.equal(result.state.search.reason, SEARCH_REASONS.EMPTY);
  assert.equal(ledger.report().searchesAttempted, 1, 'the attempt is in the provenance record');

  const [outcome] = searchOutcome(result);
  assert.equal(outcome.status, STATUS.DEGRADED, 'recorded as a gap');
  assert.notEqual(outcome.status, STATUS.FAILED, 'never as a failure');
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.results, 0);
  assert.ok(result.kit.run_notes.includes('Public discussion search ran and found nothing (NO_PUBLIC_DISCUSSION_FOUND).'));
});

test('edge 4: a search provider that errors is recorded and the kit is still built', async () => {
  const ledger = createSourceLedger();
  const searchProvider = {
    name: 'down',
    async search() {
      throw new Error('search service unavailable');
    },
  };

  const result = await buildKit(
    { jd: JD, company_url: `${server.origin}/acme/`, days: 5 },
    deps({ searchProvider, ledger }),
    {}
  );

  assert.equal(validateKit(result.kit).valid, true);
  assert.equal(result.state.search.reason, SEARCH_REASONS.FAILED);
  assert.deepEqual(result.state.search.results, []);
  assert.equal(searchOutcome(result)[0].status, STATUS.DEGRADED);
  assert.ok(result.kit.run_notes.some((note) => note.includes(SEARCH_REASONS.FAILED)));
  assert.ok(result.kit.questions.length > 0);
});

// ===========================================================================
// EDGE CASE 3 — two-line stub JD → thin kit that says it is thin, no invented requirements
// ===========================================================================

const STUB_JD = 'Backend Engineer — Kestrel Payments\nMust know Go and Postgres.';

/**
 * A model that pads a thin posting — the failure this row exists to catch. It returns the
 * one requirement the stub supports and three a "typical backend role" would have, each
 * with a confident quote the posting does not contain. Every other step is the offline
 * provider, so the kit still assembles.
 */
function paddingProvider() {
  const offline = createFixtureProvider();
  const calls = [];
  return {
    name: 'padding',
    model: 'padding-offline',
    calls,
    callCount: () => calls.length,
    countTokens: async () => 100,
    async complete(request) {
      calls.push({ step: request.step, request });
      if (request.step !== 'extract-requirements') return offline.complete(request);
      return {
        data: {
          requirements: [
            { text: 'Go and Postgres', kind: 'technical', priority: 'must', evidence: 'Must know Go and Postgres.' },
            { text: '5+ years operating Kubernetes in production', kind: 'technical', priority: 'must', evidence: '5+ years operating Kubernetes in production' },
            { text: 'Experience with AWS', kind: 'technical', priority: 'must', evidence: 'Hands-on experience with AWS services' },
            { text: 'Strong communication skills', kind: 'behavioural', priority: 'nice', evidence: 'Excellent written and verbal communication' },
          ],
        },
        raw: null,
        text: '',
      };
    },
  };
}

/** What every thin kit must be: whole, labelled thin, and built only on what was written. */
function assertThinKitWithoutInvention(kit) {
  assert.equal(validateKit(kit).valid, true, JSON.stringify(validateKit(kit).errors));

  // Says it is thin — as a flag for code, and in words for a person.
  assert.equal(kit.thin_jd, true);
  assert.ok(
    kit.run_notes.some((note) => /below the 400-character threshold/.test(note) && /because the posting is short/.test(note)),
    `the kit should explain that it is thin: ${JSON.stringify(kit.run_notes)}`
  );

  // Nothing invented: every requirement quotes the stub, and nothing else refers to a
  // requirement the stub does not support.
  const normalisedStub = STUB_JD.toLowerCase();
  assert.ok(kit.role.requirements.length >= 1, 'the stub still yields what it does say');
  for (const requirement of kit.role.requirements) {
    assert.ok(
      normalisedStub.includes(requirement.evidence.toLowerCase().replace(/\.$/, '')),
      `"${requirement.text}" quotes "${requirement.evidence}", which the posting does not contain`
    );
  }
  const ids = new Set(kit.role.requirements.map((requirement) => requirement.id));
  for (const question of kit.questions) {
    for (const id of question.requirement_ids) assert.ok(ids.has(id), `question ${question.id} cites ${id}`);
  }
  for (const card of kit.flashcards) {
    for (const id of card.requirement_ids) assert.ok(ids.has(id), `flashcard ${card.id} cites ${id}`);
  }

  // Thin, not padded: the days that exist hold real questions, never filler.
  assert.equal(verifySchedule(kit).ok, true, JSON.stringify(verifySchedule(kit).violations));
  assert.deepEqual(findGaps(kit.role.requirements, kit.questions).uncovered_requirement_ids, []);
}

test('edge 3: a two-line stub posting yields a thin kit that says so', async () => {
  const result = await buildKit({ jd: STUB_JD, company_url: '', days: 7 }, deps(), {});

  assertThinKitWithoutInvention(result.kit);
  assert.ok(result.kit.role.requirements.length <= 2, 'two lines cannot support a long requirement list');
  assert.equal(result.kit.schedule.days.length, 7, 'the days asked for, each with real work');
});

test('edge 3: requirements a model pads a stub posting with are dropped, not kept', async () => {
  const provider = paddingProvider();
  const result = await buildKit({ jd: STUB_JD, company_url: '', days: 7 }, deps({ provider }), {});
  const { kit } = result;

  assertThinKitWithoutInvention(kit);
  assert.deepEqual(
    kit.role.requirements.map((requirement) => requirement.text),
    ['Go and Postgres'],
    'only the requirement the posting states survives'
  );

  // The padding is not silently discarded: the kit lists what was left out, and why.
  assert.deepEqual(
    kit.dropped_requirements.map((drop) => drop.text).sort(),
    ['5+ years operating Kubernetes in production', 'Experience with AWS', 'Strong communication skills']
  );
  assert.ok(kit.dropped_requirements.every((drop) => drop.reason === 'EVIDENCE_UNSUPPORTED'));
  assert.ok(kit.run_notes.some((note) => /3 requirement\(s\) were dropped/.test(note)));

  const questionText = kit.questions.map((question) => `${question.prompt} ${question.answer_outline}`).join('\n');
  assert.doesNotMatch(questionText, /kubernetes|aws|communication skills/i, 'no question is written about them either');
});

// ===========================================================================
// EDGE CASE 5 — invalid JSON or truncation → repair once, then typed failure
// ===========================================================================

/**
 * The REAL Gemini adapter over a scripted SDK client, for one step; the offline provider
 * for every other step.
 *
 * The fake provider throws pre-built errors, which proves what the pipeline does with an
 * error but not that bad output becomes that error. Here the bytes a model might send —
 * JSON cut off mid-array, or a MAX_TOKENS finish — go through `createGeminiProvider`'s own
 * parsing, so the whole path from response to kit is the production one.
 *
 * `script` is consumed one response per call to the scripted step: a string is sent as the
 * response text with finishReason STOP; `{ text, finishReason }` sets both; `null` means
 * "answer properly", using the offline provider's answer for that request.
 */
function scriptedStep(scriptedStepName, script) {
  const offline = createFixtureProvider();
  const sent = [];
  let pending = null;

  const client = {
    models: {
      async generateContent({ contents, config }) {
        sent.push({ systemInstruction: config.systemInstruction, contents });
        const entry = script.length > 0 ? script.shift() : null;
        if (entry === null) {
          const { data } = await offline.complete({ ...pending, contents, systemInstruction: config.systemInstruction });
          return fakeResponse(data);
        }
        const { text, finishReason = 'STOP' } = typeof entry === 'string' ? { text: entry } : entry;
        return fakeResponse(text, { finishReason });
      },
      async countTokens() {
        return { totalTokens: 100 };
      },
    },
  };
  const gemini = createGeminiProvider({ client, model: 'scripted-gemini' });

  return {
    name: 'scripted',
    model: 'scripted-gemini',
    sent,
    offlineCalls: () => offline.callCount(),
    countTokens: async () => 100,
    async complete(request) {
      if (request.step !== scriptedStepName) return offline.complete(request);
      pending = request;
      return gemini.complete(request);
    },
  };
}

/** JSON a model stopped writing halfway through an array. */
const CUT_OFF_JSON = '{"requirements": [{"text": "Deep expertise in Go", "kind": "technical", "priority": "must", "evid';

/** JSON that parses, from a response whose finishReason says it was truncated. */
const TRUNCATED_BUT_PARSEABLE = {
  text: JSON.stringify({
    requirements: [{ text: 'Deep expertise in Go', kind: 'technical', priority: 'must', evidence: 'Deep expertise in Go' }],
  }),
  finishReason: 'MAX_TOKENS',
};

test('edge 5: unparseable output is repaired once and the kit completes', async () => {
  const provider = scriptedStep('extract-requirements', [CUT_OFF_JSON, null]);
  const result = await buildKit({ jd: JD, company_url: '', days: 5 }, deps({ provider }), {});
  const untroubled = await buildKit({ jd: JD, company_url: '', days: 5 }, deps(), {});

  assert.equal(validateKit(result.kit).valid, true);
  assert.deepEqual(
    result.kit.role.requirements,
    untroubled.kit.role.requirements,
    'the repaired answer is used, exactly as if nothing had gone wrong'
  );
  assert.equal(provider.sent.length, 2, 'one attempt and exactly one repair');

  const [first, repair] = provider.sent;
  assert.doesNotMatch(first.systemInstruction, /PREVIOUS RESPONSE WAS REJECTED/);
  assert.match(repair.systemInstruction, /PREVIOUS RESPONSE WAS REJECTED/);
  assert.match(repair.systemInstruction, /not JSON/, 'the repair says what was wrong');
  assert.equal(repair.contents, first.contents, 'the repair asks about the same posting');
  assert.equal(result.budget.breakdown[STEPS.REQUIREMENTS], 2, 'the repair spent from the call budget');
});

test('edge 5: output that fails again after its repair is a typed failure, with no third attempt', async () => {
  const provider = scriptedStep('extract-requirements', [CUT_OFF_JSON, CUT_OFF_JSON, null]);

  await assert.rejects(buildKit({ jd: JD, company_url: '', days: 5 }, deps({ provider }), {}), (error) => {
    assert.ok(error instanceof BuildFailedError);
    assert.equal(error.code, LLM_ERROR_CODES.INVALID_OUTPUT);
    assert.equal(error.details.cause.details.repaired, true);
    assert.match(error.message, /failed twice/);
    return true;
  });
  assert.equal(provider.sent.length, 2, 'one attempt, one repair, then stop');
  assert.equal(provider.offlineCalls(), 0, 'nothing is built on requirements that do not exist');
});

test('edge 5: truncated output is a typed failure at once — asking again would truncate again', async () => {
  const provider = scriptedStep('extract-requirements', [TRUNCATED_BUT_PARSEABLE, null]);

  await assert.rejects(buildKit({ jd: JD, company_url: '', days: 5 }, deps({ provider }), {}), (error) => {
    assert.ok(error instanceof BuildFailedError);
    assert.equal(error.code, LLM_ERROR_CODES.INVALID_OUTPUT);
    assert.equal(error.details.cause.details.truncated, true);
    assert.match(error.message, /maxOutputTokens/);
    return true;
  });
  assert.equal(provider.sent.length, 1, 'no repair: the JSON parsed, but it may be missing items');
});

test('edge 5: a step that may degrade records its typed failure and the kit is still built', async () => {
  const provider = scriptedStep('company-brief', [CUT_OFF_JSON, CUT_OFF_JSON]);
  const result = await buildKit(
    { jd: JD, company_url: `${server.origin}/acme/`, days: 5 },
    deps({ provider }),
    {}
  );

  assert.equal(validateKit(result.kit).valid, true);
  assert.equal(provider.sent.length, 2, 'repaired once, then given up on');
  assert.match(result.kit.company_brief.summary, /could not be produced/);
  assert.equal(result.kit.company_brief.what_they_do, '', 'nothing was made up in its place');
  assert.ok(result.kit.run_notes.includes(`Company brief failed (${LLM_ERROR_CODES.INVALID_OUTPUT}).`));
});

test('edge 5: a truncated question call leaves its requirements to the coverage pass', async () => {
  const provider = scriptedStep('questions:technical', [{ text: '{"questions": []}', finishReason: 'MAX_TOKENS' }, null]);
  const result = await buildKit({ jd: JD, company_url: '', days: 5 }, deps({ provider }), {});
  const { kit, state } = result;

  assert.equal(validateKit(kit).valid, true);

  // Two technical calls, and the second is not a repair: truncation is never repaired.
  // It is the gap-fill pass asking about ONE requirement the truncated batch left bare.
  const [batch, gapFill] = provider.sent;
  assert.equal(provider.sent.length, 2);
  assert.doesNotMatch(gapFill.systemInstruction, /PREVIOUS RESPONSE WAS REJECTED/);
  const idsIn = (call) => new Set([...call.contents.matchAll(/\b(r\d+)\b/g)].map((match) => match[1]));
  assert.ok(idsIn(batch).size > 1, 'the truncated call was the category batch');
  assert.equal(idsIn(gapFill).size, 1, 'the follow-up is a single-requirement gap fill');

  assert.deepEqual(state.failedCategories, [{ category: 'technical', reason: LLM_ERROR_CODES.INVALID_OUTPUT }]);
  assert.ok(kit.run_notes.includes(`The technical question call failed (${LLM_ERROR_CODES.INVALID_OUTPUT}).`));
  assert.deepEqual(kit.coverage.uncovered_requirement_ids, [], 'the gap-fill pass covered what the failed call would have');
  assert.equal(kit.coverage.passes, 2);
});
