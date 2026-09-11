/**
 * rateLimit.js — refuse too many requests, politely and with a Retry-After.
 *
 * Decides: how many requests a caller may make in a window, and what a refusal says.
 *
 * Does NOT decide: which routes are limited — the caller mounts it where it matters.
 *
 * TWO DIFFERENT PROBLEMS, TWO DIFFERENT LIMITS:
 *
 *   AUTH is limited to slow down credential guessing. bcrypt at cost 12 already makes
 *   each attempt expensive for us as well as the attacker — roughly a quarter-second of
 *   CPU — so an unlimited login endpoint is both a brute-force surface and a trivial
 *   denial-of-service: a few hundred concurrent logins is a saturated server. Keyed by
 *   IP, because there is no session yet and the email is attacker-controlled.
 *
 *   GENERATION is limited to protect quota. Every build spends up to twelve model calls
 *   against a ceiling of twenty a DAY. One impatient user clicking "generate" six times
 *   does not degrade the service — it ends it, for everyone, until midnight Pacific.
 *   Keyed by user id, because this is about one person's share and they are signed in.
 *
 * IN-MEMORY, AND HONEST ABOUT IT. Counters live in this process. With several server
 * processes each enforces its own limit, so the real ceiling is the limit times the
 * process count. For a single-instance deploy that is exactly right; for a scaled one
 * it would need shared state, and the comment says so rather than the code implying a
 * guarantee it cannot make.
 *
 * A FIXED WINDOW, NOT A SLIDING ONE. A fixed window lets a caller spend its whole
 * allowance at the very end of one window and again at the start of the next — twice
 * the nominal rate, briefly. That is acceptable for both uses here (neither is
 * protecting a hard per-second resource) and it costs one integer per caller instead of
 * a list of timestamps. Naming the imprecision is better than implying it is absent.
 */

import { ApiError } from './errors.js';

/** Sensible defaults for the two uses. */
export const LIMITS = Object.freeze({
  /** Login and registration: enough for a person, not for a script. */
  auth: { limit: 10, windowMs: 15 * 60 * 1000 },
  /** Kit generation and regeneration: bounded by a 20-a-day model ceiling. */
  generation: { limit: 10, windowMs: 60 * 60 * 1000 },
});

/**
 * Create a limiter middleware.
 *
 * @param {object} options
 * @param {number} options.limit requests allowed per window
 * @param {number} options.windowMs
 * @param {(request: object) => string} [options.keyBy] defaults to the client IP
 * @param {() => number} [options.now] injected for tests
 * @param {string} [options.message]
 */
export function createRateLimit({
  limit,
  windowMs,
  keyBy = (request) => clientIp(request),
  now = () => Date.now(),
  message = 'Too many requests. Wait a moment and try again.',
} = {}) {
  /** key -> { count, resetAt } */
  const buckets = new Map();

  /**
   * Drop expired buckets occasionally.
   *
   * Without this the Map grows by one entry per distinct IP forever, which is a slow
   * memory leak that only shows up in production. Swept on write rather than on a
   * timer, so an idle process does no work and holds no handle open.
   */
  function sweep(timestamp) {
    if (buckets.size < 1000) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= timestamp) buckets.delete(key);
    }
  }

  return function rateLimit(request, response, next) {
    const timestamp = now();
    const key = keyBy(request);

    // A caller we cannot identify is not limited rather than sharing one global bucket
    // with every other unidentifiable caller — which would let one of them lock out
    // the rest.
    if (!key) {
      next();
      return;
    }

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= timestamp) {
      bucket = { count: 0, resetAt: timestamp + windowMs };
      buckets.set(key, bucket);
      sweep(timestamp);
    }

    bucket.count += 1;

    const remaining = Math.max(0, limit - bucket.count);
    const resetSeconds = Math.ceil((bucket.resetAt - timestamp) / 1000);

    // Advertised on every response, not only on a refusal: a client that can see its
    // remaining allowance can slow down before being refused.
    response.setHeader('x-ratelimit-limit', String(limit));
    response.setHeader('x-ratelimit-remaining', String(remaining));
    response.setHeader('x-ratelimit-reset', String(resetSeconds));

    if (bucket.count > limit) {
      response.setHeader('retry-after', String(resetSeconds));
      next(
        new ApiError('RATE_LIMITED', `${message} You can try again in ${describe(resetSeconds)}.`, {
          details: { retryAfterSeconds: resetSeconds, limit, windowMs },
        })
      );
      return;
    }

    next();
  };
}

/** A human interval, because "retry in 3517 seconds" is not information. */
function describe(seconds) {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * The client's address.
 *
 * `request.ip` already honours `trust proxy`, which the app sets only in production.
 * That matters: trusting `x-forwarded-for` with no proxy in front lets any client claim
 * any address and sidestep the limiter entirely, so the header is respected exactly
 * where a proxy is actually terminating the connection.
 */
function clientIp(request) {
  return request.ip ?? request.socket?.remoteAddress ?? null;
}

/** Limit by signed-in user. Used where the cost is quota rather than CPU. */
export function byUser(request) {
  return request.session?.userId ?? null;
}

/** The two limiters this API mounts. */
export function createLimiters({ now } = {}) {
  return {
    auth: createRateLimit({
      ...LIMITS.auth,
      now,
      message: 'Too many sign-in attempts from this address.',
    }),
    generation: createRateLimit({
      ...LIMITS.generation,
      keyBy: byUser,
      now,
      message:
        'Too many generations. Each kit costs a share of a small daily model quota, so they are paced.',
    }),
  };
}
