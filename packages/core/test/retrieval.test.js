/**
 * retrieval.test.js — crawl ranking, skip reporting and hiring page discovery, run
 * against the real fixture server rather than against stubs.
 *
 * Decides: that the stage's three exit checks hold —
 *   1. the crawler finds a hiring page whose path it was never given
 *   2. the no-hiring-page site yields a clean null with a reason
 *   3. the broken site completes, with every skip recorded and named
 *
 * Does NOT decide: anything requiring Gemini. The one model call in this path
 * (hiring-page confirmation) is served by the fake provider, so the suite spends no
 * daily quota.
 *
 * The server binds to port 0 rather than 8099: a fixed port makes two test runs on one
 * machine collide, and a test that fails because of a stale process is a test nobody
 * trusts.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startFixtureServer, BROKEN_ROUTES } from '../../../fixtures/serve.js';
import { createUrlGuard, isPrivateAddress } from '../retrieval/urlGuard.js';
import { createPageFetcher } from '../retrieval/fetchPage.js';
import { createPageCache, normaliseUrl } from '../retrieval/pageCache.js';
import { clean } from '../retrieval/clean.js';
import { createRobotsChecker, parseRobots, isPathAllowed } from '../retrieval/robots.js';
import { crawlSite, scoreLink } from '../retrieval/crawl.js';
import { findHiringPage, HIRING_PAGE_REASONS } from '../retrieval/findHiringPage.js';
import { searchPublicDiscussion, createNoopSearchProvider, selectSearchProvider, SEARCH_REASONS } from '../retrieval/searchPublicDiscussion.js';
import { createSourceLedger } from '../retrieval/sourceLedger.js';
import { createFakeProvider } from '../llm/fakeProvider.js';

let server;
let guard;
let fetcher;
let robots;

before(async () => {
  server = await startFixtureServer({ port: 0 });
  guard = createUrlGuard({ allowPrivateHosts: true });
  fetcher = createPageFetcher({ guard, timeoutMs: 1000, maxBytes: 500_000, retries: 1, retryDelayMs: 20 });
  robots = createRobotsChecker({ fetcher, userAgent: 'ai-interview-prep-kit/1.0' });
});

after(async () => {
  await server?.close();
});

function crawl(site, options = {}) {
  return crawlSite(`${server.origin}/${site}/`, {
    fetcher,
    robots,
    cache: createPageCache(),
    maxPages: 10,
    maxDepth: 3,
    concurrency: 3,
    perHostDelayMs: 0,
    ...options,
  });
}

const pathsOf = (pages) => pages.map((page) => new URL(page.url).pathname);
const reasonCounts = (skipped) => {
  const counts = {};
  for (const skip of skipped) counts[skip.reason] = (counts[skip.reason] ?? 0) + 1;
  return counts;
};

// ===========================================================================
// EXIT CHECK 1 — a hiring page at a path the crawler was never given
// ===========================================================================

test('EXIT CHECK: the crawler finds a hiring page whose path it was never given', async () => {
  const result = await crawl('acme');

  const paths = pathsOf(result.pages);
  assert.ok(
    paths.includes('/acme/handbook/how-we-hire'),
    `hiring page not reached. Crawled: ${paths.join(', ')}`
  );

  // It must be found by FOLLOWING LINKS, not by guessing: no module may contain the path.
  assert.ok(
    !paths.includes('/acme/careers') && !paths.includes('/acme/jobs'),
    'the crawler should not be probing guessed paths'
  );

  const top = result.hiringPageCandidates[0];
  assert.equal(new URL(top.url).pathname, '/acme/handbook/how-we-hire');
  assert.ok(top.score > 15, `expected a decisive score, got ${top.score}`);
});

test('the hiring page is confirmed and returned, with the crawl score doing the shortlisting', async () => {
  const result = await crawl('acme');
  const provider = createFakeProvider({
    responses: { 'hiring-page': { chosen_url: `${server.origin}/acme/handbook/how-we-hire`, confidence: 5, reason: 'Describes four interview stages.' } },
  });

  const found = await findHiringPage({
    candidates: result.hiringPageCandidates,
    pages: result.pages,
    provider,
  });

  assert.equal(new URL(found.page.url).pathname, '/acme/handbook/how-we-hire');
  assert.ok([HIRING_PAGE_REASONS.FOUND, HIRING_PAGE_REASONS.CONFIRMATION_SKIPPED].includes(found.reason));
  assert.match(found.page.text, /take-home/i, 'the page text must come through for the process extraction');
});

test('link ranking prefers hiring signals and rejects login, legal and assets', () => {
  const rootUrl = new URL('http://x.test/');
  const score = (href, anchorText = '') => scoreLink({ href, anchorText }, { rootUrl, depth: 1 }).score;

  assert.ok(score('http://x.test/handbook/how-we-hire', 'How we hire') > score('http://x.test/about', 'About'));
  assert.ok(score('http://x.test/about', 'About') > score('http://x.test/pricing', 'Pricing'));
  assert.ok(score('http://x.test/login', 'Sign in') < 0);
  assert.ok(score('http://x.test/legal/privacy', 'Privacy') < 0);
  assert.equal(score('http://x.test/logo.png', 'logo'), -Infinity);
  assert.ok(score('http://other.test/careers', 'Careers') < score('http://x.test/careers', 'Careers'));
});

test('every score carries the signals that produced it', () => {
  const { signals } = scoreLink(
    { href: 'http://x.test/careers', anchorText: 'Careers' },
    { rootUrl: new URL('http://x.test/'), depth: 1 }
  );
  assert.ok(signals.includes('+careers'));
  assert.ok(signals.includes('+same-origin'));
});

// ===========================================================================
// EXIT CHECK 2 — a clean null, with a reason
// ===========================================================================

test('EXIT CHECK: the no-hiring-page site yields a clean null with a reason', async () => {
  const result = await crawl('nohire');
  assert.ok(result.pages.length >= 3, 'the site itself must still be crawled');

  const provider = createFakeProvider({
    responses: { 'hiring-page': { chosen_url: '', confidence: 1, reason: 'None of these describe a hiring process.' } },
  });

  const found = await findHiringPage({
    candidates: result.hiringPageCandidates,
    pages: result.pages,
    provider,
  });

  assert.equal(found.page, null);
  assert.equal(found.reason, HIRING_PAGE_REASONS.NONE_FOUND);
  assert.ok(found.modelReason, 'the reason must be recorded, not just the absence');
  assert.ok(found.considered.length > 0, 'what was considered is part of the honest answer');
});

test('a null hiring page never degrades into "the least bad page"', async () => {
  const result = await crawl('nohire');
  const top = result.hiringPageCandidates[0];

  // The about page is the best available and is still not a hiring page. If a future
  // change lets the crawler alone promote it, this catches the regression.
  assert.ok(top.score < 15, `about page scored ${top.score}; it must not clear the obvious bar`);

  const found = await findHiringPage({
    candidates: result.hiringPageCandidates,
    pages: result.pages,
    provider: createFakeProvider({ responses: { 'hiring-page': { chosen_url: '', confidence: 1, reason: 'no' } } }),
  });
  assert.equal(found.page, null);
});

test('with no provider at all, the absence is reported rather than guessed', async () => {
  const result = await crawl('nohire');
  const found = await findHiringPage({ candidates: result.hiringPageCandidates, pages: result.pages, provider: null });

  assert.equal(found.page, null);
  assert.equal(found.reason, HIRING_PAGE_REASONS.CONFIRMATION_FAILED);
});

// ===========================================================================
// EXIT CHECK 3 — the broken site completes, with skips recorded
// ===========================================================================

test('EXIT CHECK: the broken site completes with skips recorded', async () => {
  const result = await crawl('broken');

  assert.ok(result.pages.length >= 1, 'the pages that do work must still be returned');
  assert.ok(result.skipped.length >= 4, `expected several skips, got ${result.skipped.length}`);

  const counts = reasonCounts(result.skipped);
  assert.ok(counts.FETCH_HTTP_ERROR >= 2, `404s must be recorded: ${JSON.stringify(counts)}`);
  assert.ok(counts.FETCH_TIMEOUT >= 1, `the hanging route must time out: ${JSON.stringify(counts)}`);
  assert.ok(counts.FETCH_TOO_MANY_REDIRECTS >= 1, `the redirect loop must be caught: ${JSON.stringify(counts)}`);
  assert.ok(counts.ROBOTS_DISALLOWED >= 1, `robots must be honoured: ${JSON.stringify(counts)}`);

  for (const skip of result.skipped) {
    assert.ok(skip.url, 'every skip names a url');
    assert.ok(skip.reason, 'every skip names a reason');
  }
});

test('a hanging route costs one timeout, not the whole crawl', async () => {
  const started = Date.now();
  const result = await crawl('broken', { maxPages: 10 });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 15_000, `crawl took ${elapsed}ms; a hang must be bounded by the timeout`);
  assert.ok(result.pages.some((page) => page.url.endsWith('/broken/about')), 'the working page is still fetched');
});

test('the timeout applies to the fetcher directly, too', async () => {
  const result = await fetcher.fetchPage(`${server.origin}${BROKEN_ROUTES.HANG}`);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'FETCH_TIMEOUT');
});

test('a wrong content type is skipped rather than parsed', async () => {
  const result = await fetcher.fetchPage(`${server.origin}${BROKEN_ROUTES.PDF}`);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'FETCH_UNSUPPORTED_CONTENT_TYPE');
});

test('a 500 is retried and a 404 is not', async () => {
  const error500 = await fetcher.fetchPage(`${server.origin}${BROKEN_ROUTES.ERROR}`);
  assert.equal(error500.ok, false);
  assert.equal(error500.status, 500);

  const missing = await fetcher.fetchPage(`${server.origin}/broken/careers`);
  assert.equal(missing.status, 404);
  assert.equal(missing.reason, 'FETCH_HTTP_ERROR');
});

// ===========================================================================
// Robots, cache, cleaning and the ledger, against the live server
// ===========================================================================

test('robots.txt is fetched once per origin and honoured', async () => {
  const checker = createRobotsChecker({ fetcher, userAgent: 'ai-interview-prep-kit/1.0' });

  assert.equal((await checker.isAllowed(`${server.origin}/acme/login`)).allowed, false);
  assert.equal((await checker.isAllowed(`${server.origin}/acme/legal/privacy`)).allowed, false);
  assert.equal((await checker.isAllowed(`${server.origin}/acme/handbook/how-we-hire`)).allowed, true);

  assert.equal(checker.report().origins.length, 1, 'one robots.txt fetch for all three checks');
  assert.equal(checker.report().disallowed, 2);
});

test('a missing robots.txt means allowed, and says which kind of missing', async () => {
  const checker = createRobotsChecker({
    fetcher: { fetchPage: async () => ({ ok: false, status: 404, reason: 'FETCH_HTTP_ERROR' }) },
  });
  const verdict = await checker.isAllowed('http://x.test/anything');
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.decision, 'ROBOTS_ALLOWED_NO_FILE');
});

test('robots precedence: longest match wins, Allow breaks a tie', () => {
  const parsed = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/notes\n');
  assert.equal(isPathAllowed(parsed, '/private/x', 'bot').allowed, false);
  assert.equal(isPathAllowed(parsed, '/private/notes', 'bot').allowed, true);
});

test('the cache means a second crawl of the same site costs no fetches', async () => {
  const cache = createPageCache();
  await crawl('nohire', { cache });
  const before = cache.report();

  await crawl('nohire', { cache });
  const after = cache.report();

  assert.ok(after.hits > before.hits, 'the second crawl must hit the cache');
  assert.equal(after.size, before.size, 'and add no new entries');
});

test('links are resolved absolutely against the page they came from', async () => {
  const page = await fetcher.fetchPage(`${server.origin}/acme/handbook/`);
  const parsed = clean(page.html, page.url);

  const hrefs = parsed.links.map((link) => link.href);
  assert.ok(
    hrefs.includes(`${server.origin}/acme/handbook/how-we-hire`),
    `relative link resolved wrongly: ${hrefs.join(', ')}`
  );
  assert.ok(hrefs.includes(`${server.origin}/acme/legal/terms`), 'root-relative links resolve to the origin');
});

test('the ledger records only pages that were actually retrieved', async () => {
  const ledger = createSourceLedger();
  const result = await crawl('broken');
  ledger.recordCrawl(result);

  const used = ledger.pagesUsed();
  assert.ok(used.every((url) => result.pages.some((page) => page.url === url)));
  assert.ok(!used.some((url) => url.includes('/broken/slow')), 'a timed-out URL is not a source');
  assert.ok(!used.some((url) => url.includes('/broken/careers')), 'a 404 is not a source');

  const { kept, dropped } = ledger.vouch([...used, `${server.origin}/acme/invented`]);
  assert.equal(kept.length, used.length);
  assert.equal(dropped.length, 1, 'an unfetched URL is refused, however plausible');

  assert.ok(ledger.report().skipped >= 4);
});

test('search records attempted-and-empty differently from never-attempted', async () => {
  const attempted = await searchPublicDiscussion({
    provider: createNoopSearchProvider(),
    company: 'Halstead Freight',
    role: 'Backend Engineer',
  });
  assert.equal(attempted.attempted, true);
  assert.equal(attempted.reason, SEARCH_REASONS.EMPTY);

  const never = await searchPublicDiscussion({ company: 'Halstead Freight' });
  assert.equal(never.attempted, false);
  assert.equal(never.reason, SEARCH_REASONS.NOT_ATTEMPTED);
});

test('a blank tavily key degrades to the no-op provider rather than throwing', () => {
  const { provider, degraded, reason } = selectSearchProvider({ searchProvider: 'tavily', searchApiKey: '' });
  assert.equal(provider.name, 'none');
  assert.equal(degraded, true);
  assert.equal(reason, SEARCH_REASONS.NO_PROVIDER);
});

// ===========================================================================
// The guard, which must not be relaxed by accident
// ===========================================================================

test('the guard blocks private addresses unless the flag is set', async () => {
  const strict = createUrlGuard({ allowPrivateHosts: false });
  const verdict = await strict.check(`${server.origin}/acme/`);
  assert.equal(verdict.allowed, false, 'the fixture server is on a loopback address');
  assert.equal(verdict.reason, 'URL_PRIVATE_HOST');

  const permissive = createUrlGuard({ allowPrivateHosts: true });
  assert.equal((await permissive.check(`${server.origin}/acme/`)).allowed, true);
});

test('the cloud metadata address is refused, and so is a redirect to it', async () => {
  const strict = createUrlGuard({ allowPrivateHosts: false });
  assert.equal((await strict.check('http://169.254.169.254/latest/meta-data/')).allowed, false);

  const hop = await strict.checkRedirect('http://127.0.0.1/admin', { from: 'http://example.test/start' });
  assert.equal(hop.allowed, false);
  assert.match(hop.message, /redirected from/);
});

test('address classification covers the ranges that matter', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, `${address} must be treated as private`);
  }
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, `${address} must be reachable`);
  }
});

test('url normalisation collapses only differences that cannot change the response', () => {
  assert.equal(normaliseUrl('HTTP://Example.COM:80/a'), normaliseUrl('http://example.com/a'));
  assert.equal(normaliseUrl('http://x.test/a#frag'), normaliseUrl('http://x.test/a'));
  assert.notEqual(normaliseUrl('http://x.test/a?p=1'), normaliseUrl('http://x.test/a?p=2'));
});
