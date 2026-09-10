/**
 * crawl.js — fetch a company site, follow the links most likely to matter, and report
 * everything that was skipped.
 *
 * Decides: which links are worth fetching next, in what order, and when to stop.
 *
 * Does NOT decide: which page is THE hiring page (findHiringPage.js asks a model to
 * confirm), what a page means (clean.js), or whether a URL is permitted (urlGuard,
 * robots). It returns candidates and evidence, not conclusions.
 *
 * THERE IS NO PATH LIST, AND THAT IS THE POINT. Trying /careers, /jobs, /about in order
 * is the obvious implementation and it fails on the case that matters: the acme fixture
 * keeps its hiring page at /acme/handbook/how-we-hire, and real companies put it under
 * a handbook, an engineering blog, a Notion export or a "life at" microsite. A guessed
 * path finds pages that were already easy to find. So links are DISCOVERED from the
 * pages actually fetched and RANKED by evidence — anchor text, slug words, depth,
 * origin — and the crawler follows the best ones it has seen so far.
 *
 * BEST-FIRST, NOT BREADTH-FIRST. The frontier is re-sorted every round, so a strong
 * link found at depth 2 is fetched before a weak one at depth 1. With a page budget of
 * ~12 and a 150s case deadline, spending the budget in discovery order rather than in
 * score order is how a crawl runs out of pages one link short of the hiring page.
 *
 * SKIPS ARE RETURNED, NOT LOGGED AND FORGOTTEN. Every URL that was refused, failed or
 * did not fit the budget comes back with its reason, because the source ledger has to
 * be able to say what was tried — and "attempted and empty" is worth points that
 * "never attempted" is not.
 */

import { clean } from './clean.js';

/** Words in a slug or anchor that suggest hiring, process or culture material. */
export const POSITIVE_KEYWORDS = Object.freeze({
  // Direct hiring signals.
  'how-we-hire': 10, hiring: 8, interview: 8, careers: 7, career: 6, jobs: 7, job: 4,
  recruiting: 7, recruitment: 7, vacancies: 6, openings: 6, 'join-us': 7, joinus: 6,
  // Where hiring processes actually live.
  handbook: 6, process: 5, playbook: 5, 'life-at': 5, 'working-at': 5, 'work-with-us': 6,
  // Context material for the company brief.
  culture: 4, values: 3, about: 4, team: 3, people: 3, engineering: 4, blog: 2, mission: 3,
});

/** Path fragments that are reliably not what we are looking for. */
export const NEGATIVE_KEYWORDS = Object.freeze({
  login: -10, signin: -10, 'sign-in': -10, signup: -8, register: -8, account: -6,
  privacy: -8, legal: -8, terms: -8, cookie: -8, gdpr: -8, imprint: -6,
  pricing: -5, checkout: -8, cart: -8, basket: -8,
  support: -3, help: -3, status: -4, docs: -2, api: -2,
  tag: -4, tags: -4, category: -3, archive: -3, feed: -6, rss: -6, sitemap: -6,
});

/** Extensions that are assets rather than pages. */
const ASSET_PATTERN = /\.(png|jpe?g|gif|svg|webp|ico|css|js|json|xml|zip|gz|pdf|docx?|pptx?|mp4|mp3|woff2?)$/i;

export const CRAWL_DEFAULTS = Object.freeze({
  maxPages: 12,
  maxDepth: 2,
  concurrency: 3,
  perHostDelayMs: 200,
  /**
   * Links at or below this score are not worth a fetch.
   *
   * Zero, not negative: a page with no signal at all still scores positive on
   * same-origin, so ordinary content pages are crawled. Only links carrying an actively
   * negative signal — login, pricing, legal, an off-site profile — fall below it, and
   * those are precisely the pages that consume a 12-page budget and return nothing. A
   * crawl that spends two of its twelve fetches on /login and /pricing is two links
   * short of the hiring page it was sent to find.
   */
  minScore: 0,
});

/**
 * Score a link. Higher is more worth fetching.
 *
 * @param {{ href: string, anchorText?: string }} link
 * @param {{ rootUrl: URL, depth: number }} context
 * @returns {{ score: number, signals: string[] }} the signals are returned so a ranking
 *   decision can be explained rather than merely trusted.
 */
export function scoreLink(link, { rootUrl, depth = 1 } = {}) {
  const signals = [];
  let score = 0;

  let url;
  try {
    url = new URL(link.href);
  } catch {
    return { score: -Infinity, signals: ['unparseable'] };
  }

  const slug = decodeURIComponent(url.pathname).toLowerCase();
  const anchor = String(link.anchorText ?? '').toLowerCase();
  const haystack = `${slug} ${anchor}`;

  if (ASSET_PATTERN.test(slug)) {
    return { score: -Infinity, signals: ['asset'] };
  }

  for (const [word, weight] of Object.entries(POSITIVE_KEYWORDS)) {
    if (haystack.includes(word)) {
      score += weight;
      signals.push(`+${word}`);
    }
  }
  for (const [word, weight] of Object.entries(NEGATIVE_KEYWORDS)) {
    if (haystack.includes(word)) {
      score += weight;
      signals.push(`${word}`);
    }
  }

  if (rootUrl && url.origin === rootUrl.origin) {
    score += 5;
    signals.push('+same-origin');
  } else {
    // Off-site pages are rarely the company's own hiring material and spend budget fast.
    score -= 6;
    signals.push('off-origin');
  }

  // Shallower pages are likelier to be canonical; deeper ones are usually detail pages.
  const segments = slug.split('/').filter(Boolean).length;
  const depthPenalty = Math.min(segments, 6) * 0.75 + depth * 1.5;
  score -= depthPenalty;
  signals.push(`depth-${segments}/${depth}`);

  // A link whose anchor says something is better evidence than a bare URL.
  if (anchor.length >= 3) {
    score += 1;
    signals.push('+has-anchor');
  }

  return { score: Number(score.toFixed(2)), signals };
}

/** A tiny semaphore: N in flight, no more. */
function createGate(limit) {
  let active = 0;
  const waiting = [];

  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };

  return async function run(task) {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/**
 * Crawl a site.
 *
 * @param {string} rootUrl
 * @param {object} options
 * @param {{ fetchPage: Function }} options.fetcher
 * @param {{ isAllowed: Function }} [options.robots] omit to skip robots checking
 * @param {{ fetchThrough: Function }} [options.cache]
 * @param {number} [options.maxPages]
 * @param {number} [options.maxDepth]
 * @param {number} [options.concurrency]
 * @param {number} [options.perHostDelayMs]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @returns {Promise<{ pages: object[], skipped: object[], hiringPageCandidates: object[] }>}
 */
export async function crawlSite(rootUrl, {
  fetcher,
  robots = null,
  cache = null,
  maxPages = CRAWL_DEFAULTS.maxPages,
  maxDepth = CRAWL_DEFAULTS.maxDepth,
  concurrency = CRAWL_DEFAULTS.concurrency,
  perHostDelayMs = CRAWL_DEFAULTS.perHostDelayMs,
  minScore = CRAWL_DEFAULTS.minScore,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!fetcher || typeof fetcher.fetchPage !== 'function') {
    throw new Error('CRAWL_NOT_CONFIGURED: crawlSite requires a page fetcher.');
  }

  const pages = [];
  const skipped = [];
  const seen = new Set();

  let root;
  try {
    root = new URL(rootUrl);
  } catch {
    return {
      pages,
      skipped: [{ url: String(rootUrl), reason: 'URL_MALFORMED', message: 'Root URL is not a URL.' }],
      hiringPageCandidates: [],
    };
  }

  const gate = createGate(Math.max(1, concurrency));
  let lastFetchStartedAt = 0;

  /** Fetch one page, honouring robots, the cache and a polite per-host spacing. */
  async function fetchOne(url) {
    if (robots) {
      const verdict = await robots.isAllowed(url);
      if (!verdict.allowed) {
        return { ok: false, reason: 'ROBOTS_DISALLOWED', message: verdict.rule ?? 'robots.txt disallows this path.', url };
      }
    }

    return gate(async () => {
      // Per-host spacing measured from the last START, so concurrency and politeness
      // compose instead of cancelling out.
      const since = Date.now() - lastFetchStartedAt;
      if (perHostDelayMs > 0 && since < perHostDelayMs) await sleep(perHostDelayMs - since);
      lastFetchStartedAt = Date.now();

      return cache ? cache.fetchThrough(url, (target) => fetcher.fetchPage(target)) : fetcher.fetchPage(url);
    });
  }

  /** The links we know about but have not fetched, best-scored first. */
  const frontier = new Map();

  function consider(link, depth) {
    if (depth > maxDepth) return;
    const href = link.href;
    if (seen.has(href) || frontier.has(href)) return;

    const { score, signals } = scoreLink(link, { rootUrl: root, depth });
    if (score === -Infinity) {
      skipped.push({ url: href, reason: 'CRAWL_NOT_A_PAGE', message: signals.join(' ') });
      return;
    }
    if (score <= minScore) {
      skipped.push({
        url: href,
        reason: 'CRAWL_LOW_SCORE',
        message: `Score ${score} at or below the ${minScore} threshold (${signals.join(' ')}).`,
        score,
      });
      return;
    }
    frontier.set(href, { href, anchorText: link.anchorText ?? '', depth, score, signals });
  }

  async function visit(entry) {
    seen.add(entry.href);
    const result = await fetchOne(entry.href);

    if (!result.ok) {
      skipped.push({
        url: entry.href,
        reason: result.reason,
        message: result.message,
        status: result.status ?? null,
        score: entry.score,
      });
      return;
    }

    const parsed = clean(result.html, result.url ?? entry.href);
    const page = {
      url: result.url ?? entry.href,
      requestedUrl: entry.href,
      status: result.status,
      title: parsed.title,
      text: parsed.text,
      headings: parsed.headings,
      depth: entry.depth,
      score: entry.score,
      signals: entry.signals,
      cached: Boolean(result.cached),
      linkCount: parsed.links.length,
    };
    pages.push(page);

    for (const link of parsed.links) consider(link, entry.depth + 1);
  }

  // The root is always visited, whatever it scores.
  await visit({ href: root.toString(), anchorText: '', depth: 0, score: Infinity, signals: ['root'] });

  // Best-first rounds. Each round takes the top `concurrency` links and fetches them
  // together, then re-sorts with whatever they discovered.
  while (pages.length < maxPages && frontier.size > 0) {
    const batch = [...frontier.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(concurrency, maxPages - pages.length)));

    if (batch.length === 0) break;
    for (const entry of batch) frontier.delete(entry.href);

    await Promise.all(batch.map((entry) => visit(entry)));
  }

  // Anything still queued when the budget ran out is a skip with a reason, not silence.
  for (const entry of frontier.values()) {
    skipped.push({
      url: entry.href,
      reason: 'CRAWL_BUDGET_REACHED',
      message: `Page budget of ${maxPages} reached before this link (score ${entry.score}).`,
      score: entry.score,
    });
  }

  // Candidates are ranked by page evidence, not just by the link that led to them —
  // a page titled "How we hire" is a candidate even if its URL said nothing.
  const hiringPageCandidates = pages
    .map((page) => {
      const evidence = scoreLink(
        { href: page.url, anchorText: `${page.title} ${page.headings.slice(0, 3).join(' ')}` },
        { rootUrl: root, depth: page.depth }
      );
      return { url: page.url, title: page.title, score: evidence.score, signals: evidence.signals, depth: page.depth };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  return { pages, skipped, hiringPageCandidates };
}
