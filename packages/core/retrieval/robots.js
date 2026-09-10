/**
 * robots.js — ask permission before crawling, and record the answer either way.
 *
 * Decides: whether robots.txt permits fetching a given path, for our user-agent.
 *
 * Does NOT decide: whether the URL is safe (urlGuard) or worth fetching (crawl.js). It
 * also does not decide that a run fails — see below.
 *
 * MISSING OR UNPARSEABLE MEANS ALLOWED. Most company sites have no robots.txt, and a
 * crawler that refuses to proceed without one would fail on the ordinary case. The
 * standard is a grant of restriction, not a grant of permission: absence is permission.
 * A 404, a timeout, a 500 and a file full of nonsense all resolve to "allowed", and all
 * of them are RECORDED with the reason, so "we were allowed" and "we could not find out"
 * are never confused in the ledger.
 *
 * PRECEDENCE FOLLOWS THE DE FACTO STANDARD: the most specific matching rule wins, by
 * path length, and Allow beats Disallow on an exact tie. "Disallow:" with an empty value
 * is an explicit allow-everything, not a block — getting that backwards would refuse to
 * crawl the many sites that write it.
 *
 * The result is cached per origin: one robots.txt fetch per site, not one per page.
 */

/** Why a robots decision came out the way it did. */
export const ROBOTS_DECISIONS = Object.freeze({
  ALLOWED_BY_RULE: 'ROBOTS_ALLOWED_BY_RULE',
  ALLOWED_NO_RULE: 'ROBOTS_ALLOWED_NO_RULE',
  ALLOWED_NO_FILE: 'ROBOTS_ALLOWED_NO_FILE',
  ALLOWED_UNREADABLE: 'ROBOTS_ALLOWED_UNREADABLE',
  DISALLOWED: 'ROBOTS_DISALLOWED',
});

/**
 * Parse a robots.txt body into agent groups.
 *
 * @param {string} text
 * @returns {{ groups: Array<{ agents: string[], rules: Array<{allow: boolean, path: string}>, crawlDelay: number|null }> }}
 */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let previousWasAgent = false;

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (line === '') continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group of rules.
      if (!previousWasAgent || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      previousWasAgent = true;
      continue;
    }

    previousWasAgent = false;
    if (!current) continue; // A rule before any User-agent line belongs to nobody.

    if (field === 'disallow') {
      // "Disallow:" with no value is an explicit allow-all, not a block.
      if (value === '') current.rules.push({ allow: true, path: '/' });
      else current.rules.push({ allow: false, path: value });
    } else if (field === 'allow') {
      if (value !== '') current.rules.push({ allow: true, path: value });
    } else if (field === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) current.crawlDelay = delay;
    }
  }

  return { groups };
}

/** The group that applies to us: an exact agent match, else the wildcard group. */
export function groupFor(parsed, userAgent) {
  const agent = String(userAgent ?? '').toLowerCase();
  const groups = parsed?.groups ?? [];

  const exact = groups.find((group) =>
    group.agents.some((candidate) => candidate !== '*' && agent.includes(candidate))
  );
  if (exact) return exact;

  return groups.find((group) => group.agents.includes('*')) ?? null;
}

/** Does a robots path pattern match this request path? Supports * and a trailing $. */
function matches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  const expression = new RegExp(`^${escaped}${anchored ? '$' : ''}`);
  return expression.test(path);
}

/**
 * Decide one path against a parsed robots.txt.
 *
 * @returns {{ allowed: boolean, decision: string, rule: string|null, crawlDelay: number|null }}
 */
export function isPathAllowed(parsed, path, userAgent) {
  const group = groupFor(parsed, userAgent);
  if (!group || group.rules.length === 0) {
    return { allowed: true, decision: ROBOTS_DECISIONS.ALLOWED_NO_RULE, rule: null, crawlDelay: group?.crawlDelay ?? null };
  }

  let best = null;
  for (const rule of group.rules) {
    if (!matches(rule.path, path)) continue;
    // Longest match wins; on an exact tie, Allow beats Disallow.
    if (
      best === null ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }

  if (!best) {
    return { allowed: true, decision: ROBOTS_DECISIONS.ALLOWED_NO_RULE, rule: null, crawlDelay: group.crawlDelay };
  }

  return {
    allowed: best.allow,
    decision: best.allow ? ROBOTS_DECISIONS.ALLOWED_BY_RULE : ROBOTS_DECISIONS.DISALLOWED,
    rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}`,
    crawlDelay: group.crawlDelay,
  };
}

/**
 * Build a checker that fetches and caches robots.txt per origin.
 *
 * @param {object} options
 * @param {{ fetchPage: Function }} options.fetcher
 * @param {string} [options.userAgent]
 */
export function createRobotsChecker({ fetcher, userAgent = 'ai-interview-prep-kit' } = {}) {
  if (!fetcher || typeof fetcher.fetchPage !== 'function') {
    throw new Error('ROBOTS_NOT_CONFIGURED: createRobotsChecker requires a page fetcher.');
  }

  /** @type {Map<string, { parsed: object|null, decision: string }>} origin -> robots */
  const byOrigin = new Map();
  const decisions = [];

  async function loadFor(origin) {
    if (byOrigin.has(origin)) return byOrigin.get(origin);

    const result = await fetcher.fetchPage(`${origin}/robots.txt`);

    let entry;
    if (!result.ok) {
      // A 404 is the common case and means "no restrictions". A timeout or a 500 means
      // we could not find out — also allowed, but recorded differently, because the two
      // are not the same fact and the ledger should not pretend they are.
      entry = {
        parsed: null,
        decision:
          result.status === 404
            ? ROBOTS_DECISIONS.ALLOWED_NO_FILE
            : ROBOTS_DECISIONS.ALLOWED_UNREADABLE,
        note: result.reason,
      };
    } else {
      try {
        entry = { parsed: parseRobots(result.html), decision: null };
      } catch (cause) {
        entry = { parsed: null, decision: ROBOTS_DECISIONS.ALLOWED_UNREADABLE, note: cause.message };
      }
    }

    byOrigin.set(origin, entry);
    return entry;
  }

  /**
   * @param {string} url
   * @returns {Promise<{ allowed: boolean, decision: string, rule: string|null, crawlDelay: number|null, url: string }>}
   */
  async function isAllowed(url) {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      // Not our decision to make; the guard will refuse it for its own reasons.
      const record = { allowed: true, decision: ROBOTS_DECISIONS.ALLOWED_UNREADABLE, rule: null, crawlDelay: null, url };
      decisions.push(record);
      return record;
    }

    const entry = await loadFor(parsedUrl.origin);

    const record = entry.parsed
      ? { ...isPathAllowed(entry.parsed, `${parsedUrl.pathname}${parsedUrl.search}`, userAgent), url }
      : { allowed: true, decision: entry.decision, rule: null, crawlDelay: null, url, note: entry.note };

    decisions.push(record);
    return record;
  }

  /** Every decision made, so the ledger can show robots was consulted. */
  function report() {
    return {
      origins: [...byOrigin.keys()],
      checked: decisions.length,
      disallowed: decisions.filter((entry) => !entry.allowed).length,
      decisions: [...decisions],
    };
  }

  return { isAllowed, report };
}
