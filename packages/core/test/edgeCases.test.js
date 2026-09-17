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
import net from 'node:net';

import { startFixtureServer } from '../../../fixtures/serve.js';
import { buildKit } from '../orchestrator/buildKit.js';
import { createUnboundedGovernor } from '../orchestrator/timeGovernor.js';
import { createUrlGuard, URL_SKIP_REASONS } from '../retrieval/urlGuard.js';
import { createPageFetcher } from '../retrieval/fetchPage.js';
import { createRobotsChecker } from '../retrieval/robots.js';
import { createNoopSearchProvider } from '../retrieval/searchPublicDiscussion.js';
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
function deps({ lookup, timeoutMs = 300 } = {}) {
  const guard = createUrlGuard({ allowPrivateHosts: true, ...(lookup ? { lookup } : {}) });
  const fetcher = createPageFetcher({ guard, timeoutMs, retries: 1, retryDelayMs: 10 });
  return {
    provider: createFixtureProvider(),
    fetcher,
    robots: createRobotsChecker({ fetcher, userAgent: 'ai-interview-prep-kit/1.0' }),
    searchProvider: createNoopSearchProvider(),
    governor: createUnboundedGovernor(),
  };
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
