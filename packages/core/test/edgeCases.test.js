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
import { buildKit } from '../orchestrator/buildKit.js';
import { createUnboundedGovernor } from '../orchestrator/timeGovernor.js';
import { STEPS, STATUS } from '../orchestrator/steps.js';
import { createUrlGuard, URL_SKIP_REASONS } from '../retrieval/urlGuard.js';
import { createPageFetcher } from '../retrieval/fetchPage.js';
import { createRobotsChecker } from '../retrieval/robots.js';
import { createNoopSearchProvider, SEARCH_REASONS } from '../retrieval/searchPublicDiscussion.js';
import { HIRING_PAGE_REASONS } from '../retrieval/findHiringPage.js';
import { createSourceLedger } from '../retrieval/sourceLedger.js';
import { createFixtureProvider } from '../llm/offlineProvider.js';
import { validateKit } from '../contracts/validateKit.js';

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
