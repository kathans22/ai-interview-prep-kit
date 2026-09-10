/**
 * pageCache.js — fetch each URL once per kit, however many times it is asked for.
 *
 * Decides: what counts as "the same URL", and what a repeat request returns.
 *
 * Does NOT decide: whether to fetch (the crawler), or whether a page is any good. It
 * caches SKIPS as well as successes, which is the less obvious half: a 404 asked for
 * three times is three round trips and three chances to time out, for an answer that
 * will not change inside one run.
 *
 * WHY THIS EXISTS RATHER THAN BEING A NICETY. The crawl reaches the same page by more
 * than one path — a company site links its careers page from the header, the footer and
 * the about page — and resume re-enters a kit that already fetched most of what it
 * needs. Against a 150s per-case deadline, re-fetching is the difference between
 * finishing and degrading.
 *
 * NORMALISATION IS CONSERVATIVE. Only differences that certainly do not change the
 * response are collapsed: scheme and host case, the default port, a trailing empty
 * query, and the fragment (never sent to a server). Query ORDER is preserved and query
 * parameters are never dropped — some sites route on them, and a cache that guesses
 * wrong serves the wrong page, which is worse than fetching twice.
 *
 * Pure bookkeeping plus an injected fetcher: no I/O of its own.
 */

/**
 * Canonical cache key for a URL.
 *
 * @param {string|URL} candidate
 * @returns {string} the normalised URL, or the original string when unparseable — an
 *   unparseable URL is still cacheable as itself, and will simply fail identically.
 */
export function normaliseUrl(candidate) {
  let url;
  try {
    url = new URL(String(candidate));
  } catch {
    return String(candidate).trim();
  }

  url.hash = '';
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();

  // "?" with nothing after it is not a different resource.
  if (url.search === '?') url.search = '';

  // The default port is implied; :80 and :443 are the same address as no port at all.
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }

  // "http://host" and "http://host/" are the same document.
  if (url.pathname === '') url.pathname = '/';

  return url.toString();
}

/**
 * Create a cache.
 *
 * @param {object} [options]
 * @param {Iterable<[string, object]>} [options.entries] restore a persisted cache
 */
export function createPageCache({ entries = [] } = {}) {
  /** @type {Map<string, object>} normalised url -> fetch result (ok or skip) */
  const store = new Map(entries);
  const stats = { hits: 0, misses: 0, stored: 0 };

  function has(url) {
    return store.has(normaliseUrl(url));
  }

  function get(url) {
    const key = normaliseUrl(url);
    if (store.has(key)) {
      stats.hits += 1;
      return store.get(key);
    }
    stats.misses += 1;
    return undefined;
  }

  function set(url, result) {
    const key = normaliseUrl(url);
    store.set(key, result);
    stats.stored += 1;
    return result;
  }

  /**
   * Fetch through the cache.
   *
   * @param {string} url
   * @param {(url: string) => Promise<object>} fetcher
   * @returns {Promise<object>} the result, with `cached: true` when it came from here
   */
  async function fetchThrough(url, fetcher) {
    const existing = get(url);
    if (existing !== undefined) return { ...existing, cached: true };

    const result = await fetcher(url);
    set(url, result);

    // The response URL after redirects is cached too, so a second route to the same
    // final page is also a hit. Without this, three links that all redirect to the same
    // careers page cost three fetches.
    if (result?.ok && result.url && normaliseUrl(result.url) !== normaliseUrl(url)) {
      set(result.url, result);
    }

    return { ...result, cached: false };
  }

  function report() {
    const total = stats.hits + stats.misses;
    return {
      size: store.size,
      hits: stats.hits,
      misses: stats.misses,
      hitRate: total === 0 ? 0 : Number((stats.hits / total).toFixed(4)),
    };
  }

  /** Serialise for persistence alongside a kit, so a resume does not re-fetch. */
  function toJSON() {
    return { version: 1, entries: [...store.entries()] };
  }

  return { has, get, set, fetchThrough, report, toJSON, keys: () => [...store.keys()] };
}

/**
 * Restore a cache from its serialised form. An unrecognised or malformed payload yields
 * an empty cache rather than throwing — a stale cache file is a performance loss, never
 * a reason to fail a run.
 */
export function restorePageCache(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entries)) {
    return createPageCache();
  }
  const usable = payload.entries.filter(
    (entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
  );
  return createPageCache({ entries: usable });
}
