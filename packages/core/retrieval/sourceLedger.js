/**
 * sourceLedger.js — the record of what was actually retrieved.
 *
 * Decides: what may appear in `source.pages_used` and `company_brief.sources`.
 *
 * Does NOT decide: what any page said, or which sources support which claim. It is a
 * register of events, not an interpreter of them.
 *
 * THE ONE RULE: A URL REACHES THE KIT ONLY IF IT WAS FETCHED SUCCESSFULLY. Nothing else
 * qualifies — not a URL the crawler considered, not one a page linked to, and above all
 * not one a model mentioned. Provenance assembled by hand at each generation step drifts
 * within a single run: a step cites the careers page it "read" when the fetch actually
 * 404'd, and the kit then claims evidence it never had. Every fetch goes through here,
 * and `pagesUsed()` reads only from recorded successes, so the drift is impossible
 * rather than merely discouraged.
 *
 * SKIPS ARE RECORDED AS CAREFULLY AS SUCCESSES. "We tried the careers page and it timed
 * out" is a different kit from "we never looked", and only one of the two is honest
 * about a gap. The ledger keeps the reason and the timestamp for both.
 *
 * Pure bookkeeping: no I/O, no model.
 */

/** Categories of ledger entry. */
export const LEDGER_EVENTS = Object.freeze({
  FETCHED: 'FETCHED',
  SKIPPED: 'SKIPPED',
  SEARCHED: 'SEARCHED',
  ROBOTS: 'ROBOTS',
});

/**
 * Create a ledger.
 *
 * @param {{ now?: () => Date }} [options] clock injected so tests are deterministic
 */
export function createSourceLedger({ now = () => new Date() } = {}) {
  /** @type {Array<object>} every event, in order */
  const entries = [];
  /** Successful fetches by URL, so a repeat does not duplicate provenance. */
  const fetched = new Map();

  function timestamp() {
    return now().toISOString();
  }

  /**
   * Record a successful fetch.
   *
   * @param {{ url: string, status?: number, title?: string, bytes?: number, cached?: boolean, role?: string }} page
   */
  function recordFetch(page) {
    const url = typeof page?.url === 'string' ? page.url : '';
    if (url === '') return null;

    const entry = {
      event: LEDGER_EVENTS.FETCHED,
      url,
      status: page.status ?? null,
      title: page.title ?? '',
      bytes: page.bytes ?? null,
      cached: Boolean(page.cached),
      // What this page was retrieved FOR: 'root', 'crawl', 'hiring-page', 'robots'.
      role: page.role ?? 'crawl',
      at: timestamp(),
    };

    entries.push(entry);
    // A cache hit is not a second retrieval, so the first record stands.
    if (!fetched.has(url)) fetched.set(url, entry);
    return entry;
  }

  /**
   * Record a URL that was not retrieved, and why.
   *
   * @param {{ url: string, reason: string, message?: string, status?: number, score?: number }} skip
   */
  function recordSkip(skip) {
    const entry = {
      event: LEDGER_EVENTS.SKIPPED,
      url: typeof skip?.url === 'string' ? skip.url : '',
      reason: skip?.reason ?? 'UNKNOWN',
      message: skip?.message ?? '',
      status: skip?.status ?? null,
      score: skip?.score ?? null,
      at: timestamp(),
    };
    entries.push(entry);
    return entry;
  }

  /** Record a search attempt — including one that found nothing, which still counts. */
  function recordSearch({ provider, query, attempted, reason, results = [] }) {
    const entry = {
      event: LEDGER_EVENTS.SEARCHED,
      provider: provider ?? 'unknown',
      query: query ?? '',
      attempted: Boolean(attempted),
      reason: reason ?? '',
      resultCount: Array.isArray(results) ? results.length : 0,
      resultUrls: (Array.isArray(results) ? results : []).map((entry_) => entry_?.url).filter(Boolean),
      at: timestamp(),
    };
    entries.push(entry);
    return entry;
  }

  /** Record a robots.txt decision, so "we asked" is provable either way. */
  function recordRobots({ url, allowed, decision, rule }) {
    const entry = {
      event: LEDGER_EVENTS.ROBOTS,
      url: url ?? '',
      allowed: Boolean(allowed),
      decision: decision ?? '',
      rule: rule ?? null,
      at: timestamp(),
    };
    entries.push(entry);
    return entry;
  }

  /** Absorb a whole crawl result in one call. */
  function recordCrawl({ pages = [], skipped = [] } = {}) {
    for (const page of pages) recordFetch({ ...page, role: page.role ?? 'crawl' });
    for (const skip of skipped) recordSkip(skip);
  }

  /**
   * The URLs that may appear in `source.pages_used`.
   *
   * Successfully fetched only, in retrieval order, de-duplicated. Search result URLs
   * are deliberately absent: a snippet is not a page we retrieved, and listing it as
   * one would overstate the research.
   */
  function pagesUsed() {
    return [...fetched.keys()];
  }

  /**
   * URLs for `company_brief.sources`, restricted to those the brief could have been
   * written from.
   *
   * @param {{ roles?: string[] }} [options]
   */
  function sources({ roles = ['root', 'crawl', 'hiring-page'] } = {}) {
    return [...fetched.values()]
      .filter((entry) => roles.includes(entry.role))
      .map((entry) => entry.url);
  }

  /** Was this URL genuinely retrieved? The check a generation step should use. */
  function wasFetched(url) {
    return fetched.has(url);
  }

  /**
   * Keep only URLs the ledger can vouch for.
   *
   * The guard against a model citing a plausible URL it never saw — a hallucinated
   * /careers, or one lifted from an injected page. Anything unvouched is dropped and
   * reported rather than silently passed through to the kit.
   *
   * @param {string[]} candidates
   * @returns {{ kept: string[], dropped: string[] }}
   */
  function vouch(candidates = []) {
    const kept = [];
    const dropped = [];
    for (const url of Array.isArray(candidates) ? candidates : []) {
      if (typeof url === 'string' && fetched.has(url)) kept.push(url);
      else dropped.push(String(url));
    }
    return { kept, dropped };
  }

  /** A summary for logs and for the degradation notes in the kit. */
  function report() {
    const skips = entries.filter((entry) => entry.event === LEDGER_EVENTS.SKIPPED);
    const byReason = {};
    for (const skip of skips) byReason[skip.reason] = (byReason[skip.reason] ?? 0) + 1;

    const searches = entries.filter((entry) => entry.event === LEDGER_EVENTS.SEARCHED);

    return {
      fetched: fetched.size,
      skipped: skips.length,
      skipReasons: byReason,
      searchesAttempted: searches.filter((entry) => entry.attempted).length,
      searchResults: searches.reduce((total, entry) => total + entry.resultCount, 0),
      robotsChecks: entries.filter((entry) => entry.event === LEDGER_EVENTS.ROBOTS).length,
      firstAt: entries[0]?.at ?? null,
      lastAt: entries[entries.length - 1]?.at ?? null,
    };
  }

  return {
    recordFetch,
    recordSkip,
    recordSearch,
    recordRobots,
    recordCrawl,
    pagesUsed,
    sources,
    wasFetched,
    vouch,
    report,
    entries: () => [...entries],
  };
}
