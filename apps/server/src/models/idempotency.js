/**
 * idempotency.js — the same posting, submitted twice, does not build twice.
 *
 * Decides: what makes two submissions "the same", and how long that sameness lasts.
 *
 * Does NOT decide: what to do with the existing kit — the route returns it. This module
 * answers one question: have we already built this?
 *
 * WHY THIS IS NOT A NICETY. A kit costs up to twelve model calls against a free tier of
 * twenty a day. A double-submitted form, an impatient second click, or a client retrying
 * a request whose response was lost, each spends a whole day's remaining quota building
 * something that already exists. The window turns an expensive accident into a no-op.
 *
 * WHAT COUNTS AS THE SAME, AND WHAT DELIBERATELY DOES NOT.
 * The hash covers the normalised job description, the company URL and the day count —
 * the three inputs that determine the output. Normalisation collapses the differences a
 * person cannot see and would not intend: leading and trailing space, Windows line
 * endings against Unix, runs of blank lines, trailing whitespace on each line. Paste the
 * same posting from a different editor and it is the same posting.
 *
 * CASE IS NOT NORMALISED, and that is a judgement rather than an oversight. A posting
 * retyped in different case is a different document, and requirement extraction reads
 * capitalisation as a signal — "Required" under a heading is not "required" mid-sentence.
 * Treating them as identical would return a kit built from text the user did not submit.
 *
 * THE HASH IS SCOPED PER USER at the query, never in the hash itself. Two people can
 * legitimately prepare for the same job, and each must get their own kit — but a hash
 * containing the user id would also make the same posting look different to the same
 * person across sessions. Owner belongs in the WHERE clause; content belongs in the hash.
 */

import { createHash } from 'node:crypto';

/** Block C's window, matching IDEMPOTENCY_WINDOW_MS in the environment template. */
export const DEFAULT_IDEMPOTENCY_WINDOW_MS = 900_000; // 15 minutes

/**
 * The field separator inside the hashed string.
 *
 * A NUL, because it cannot occur in a job description, a URL or a day count — so no
 * combination of inputs can be rearranged into the same joined string as a different
 * combination. Written as an ESCAPE, never as a literal byte: a raw NUL in a source file
 * makes git classify it as binary, which costs every future diff and merge on this file,
 * and some editors silently drop it. The escape is identical at runtime.
 */
const SEPARATOR = '\u0000';

/**
 * Normalise a job description for hashing.
 *
 * Only differences invisible to the person who pasted it are removed.
 */
export function normaliseJd(jd) {
  return String(jd ?? '')
    .replace(/\r\n?/g, '\n') // Windows and old-Mac line endings
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+$/, '')) // trailing spaces per line
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // runs of blank lines
    .trim();
}

/** Normalise a company URL: scheme and host case, and a trailing slash, are not meaning. */
export function normaliseCompanyUrl(companyUrl) {
  const raw = String(companyUrl ?? '').trim();
  if (raw === '') return '';

  try {
    const url = new URL(raw);
    url.hash = '';
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname === '') url.pathname = '/';
    return url.toString();
  } catch {
    // Not a URL we can parse. Hash it as given rather than guessing at a correction —
    // an unparseable URL is still a distinguishing input.
    return raw.toLowerCase();
  }
}

/**
 * The fingerprint of a submission.
 *
 * Fields are joined with a separator that cannot occur in any of them, so a URL ending
 * in a digit and a day count cannot combine into the same string as a different pairing.
 *
 * @param {{ jd: string, company_url?: string, days: number }} input
 * @returns {string} a hex sha256
 */
export function jdHash({ jd, company_url: companyUrl, days } = {}) {
  const parts = [normaliseJd(jd), normaliseCompanyUrl(companyUrl), String(days ?? '')];
  return createHash('sha256').update(parts.join(SEPARATOR)).digest('hex');
}

/**
 * Has this person already submitted this, recently enough to reuse?
 *
 * A `failed` kit is deliberately NOT reused: the failure may have been transient — a 503,
 * an exhausted budget, a site that was down — and returning yesterday's failure instead
 * of trying again would make a retry impossible. Only a kit that is `ready`, `running`
 * or `queued` counts, because those represent work that is either done or in flight.
 *
 * @param {object} options
 * @param {import('mongoose').Model} options.model the Kit model
 * @param {string} options.userId
 * @param {object} options.input
 * @param {number} [options.windowMs]
 * @param {() => Date} [options.now]
 * @returns {Promise<{ duplicate: boolean, kit: object|null, hash: string, reason: string }>}
 */
/**
 * Which statuses count as "already have one".
 *
 * A `failed` kit is deliberately absent: the failure may have been transient — a 503, an
 * exhausted budget, a site that was down — and returning yesterday's failure instead of
 * trying again would make a retry impossible.
 */
export const DUPLICATE_STATUSES = Object.freeze(['queued', 'running', 'ready']);

/**
 * The lookup this policy implies, as plain values any store can execute.
 *
 * POLICY LIVES HERE; THE QUERY LIVES IN THE STORE. The three rules — how the hash is
 * computed, how far back to look, and which statuses count — are the decisions, and they
 * belong in one module. Running a `findOne` against Mongo or a filter over a Map is
 * mechanism, and the two backing stores do it differently.
 *
 * This split exists because the rules were duplicated: `kitRoutes` restated the status
 * list and the window inline while this module held the authoritative copy that nothing
 * called. Changing the rule where it was documented changed nothing at runtime, which is
 * worse than dead code — it is misleading code.
 */
export function duplicateQuery(input, { windowMs = DEFAULT_IDEMPOTENCY_WINDOW_MS, now = () => new Date() } = {}) {
  return {
    jdHash: jdHash(input),
    since: new Date(now().getTime() - windowMs),
    statuses: DUPLICATE_STATUSES,
  };
}

/**
 * Name the outcome.
 *
 * The two cases a caller may want to distinguish: a finished kit it can return
 * immediately, and one still being built that it should point the client at.
 */
export function describeDuplicate(kit) {
  if (!kit) return 'NO_RECENT_MATCH';
  return kit.status === 'ready' ? 'DUPLICATE_READY' : 'DUPLICATE_IN_FLIGHT';
}

/**
 * The Mongoose-backed lookup, expressed in terms of the policy above so there is exactly
 * one definition of each rule.
 */
export async function findDuplicate({
  model,
  userId,
  input,
  windowMs = DEFAULT_IDEMPOTENCY_WINDOW_MS,
  now = () => new Date(),
}) {
  const { jdHash: hash, since, statuses } = duplicateQuery(input, { windowMs, now });

  const existing = await model
    .findOne({
      userId,
      'input.jdHash': hash,
      status: { $in: statuses },
      createdAt: { $gte: since },
    })
    .sort({ createdAt: -1 });

  return {
    duplicate: Boolean(existing),
    kit: existing ?? null,
    hash,
    reason: describeDuplicate(existing),
  };
}

/**
 * Describe the window in words, for the response that tells a user why they got an
 * existing kit rather than a new one.
 *
 * A silent reuse looks like a bug — the user pressed the button and nothing appeared to
 * happen. Saying so turns it into a feature they can understand.
 */
export function duplicateMessage(windowMs = DEFAULT_IDEMPOTENCY_WINDOW_MS) {
  const minutes = Math.round(windowMs / 60_000);
  return (
    `You submitted this same job description, company URL and day count within the last ` +
    `${minutes} minute${minutes === 1 ? '' : 's'}, so this is the kit that was already built ` +
    'rather than a second one. Change any of the three, or wait, to build a new kit.'
  );
}
