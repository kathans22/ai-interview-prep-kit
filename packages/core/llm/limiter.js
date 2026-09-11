/**
 * limiter.js — one throttle for the whole process.
 *
 * Decides: when a caller may proceed. Three constraints are enforced together:
 *   RPM — requests per minute, a refilling token bucket
 *   TPM — estimated tokens per minute, a second bucket sharing the same clock
 *   RPD — requests per day, a hard counter that refuses rather than waits
 *
 * Does NOT decide: what to do when refused (retry.js and the orchestrator), how many
 * calls a kit may make (budget.js — a different question: budget is per kit, this is per
 * process), or what any request contains.
 *
 * ONE INSTANCE PER PROCESS. This module exports a singleton and every caller must use it.
 * Crawl concurrency and batch-case concurrency both draw from the same buckets, because
 * two limiters configured at "5 RPM" produce ten requests a minute, which is how a free
 * tier gets burned in an afternoon while every configuration file looks correct.
 *
 * WHERE IT IS ACTUALLY CONSULTED: `completeStructured` in json.js, inside the retried
 * function, so every generation step is paced and a retry spends admission of its own.
 * That is the only call site, and it is the same funnel `withRetry` is wired into. For
 * five stages this module was complete, tested, and consulted by nothing — throttling
 * zero requests while every comment described throttling. If a future step calls
 * `provider.complete` directly it bypasses both the limiter and the retry, which is why
 * going through `completeStructured` is an invariant rather than a convention.
 *
 * AN UNCONFIGURED SINGLETON ADMITS EVERYTHING rather than pacing at this module's
 * defaults — see `createPassThroughLimiter`. The real rates are the owner's, arriving via
 * env at boot; inventing them here would have throttled the test suite with a real sleep
 * and lied about the daily ceiling.
 *
 * RPD IS DIFFERENT IN KIND. RPM and TPM clear within a minute, so waiting is the right
 * response. The daily ceiling does not clear until midnight Pacific, so waiting for it
 * would hang the batch run for hours. Exhaustion is refused immediately, with a typed
 * error the orchestrator can degrade on.
 *
 * The clock is injected so tests do not sleep. Nothing here performs I/O.
 */

import { LlmError, LLM_ERROR_CODES, RATE_LIMIT_KINDS } from './provider.js';

const MINUTE_MS = 60_000;

/**
 * Roughly four characters to a token for English prose.
 *
 * Deliberately a local estimate rather than `provider.countTokens`: counting costs a
 * request on some tiers (CF-025), and spending one of twenty daily requests to find out
 * how big another request is would be a poor trade. TPM is a pacing input, not an
 * accounting record — an estimate within a factor of two paces correctly, and the real
 * usage comes back on the response.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate the token cost of a request, for TPM admission only.
 *
 * Counts the system instruction and the contents, which together are almost all of a
 * request, plus the output allowance — a reply that may run to `maxOutputTokens` spends
 * those tokens whether or not the caller thinks of them as input.
 */
export function estimateTokens(request = {}) {
  const text = [request.systemInstruction, request.contents]
    .filter((part) => typeof part === 'string')
    .join('\n');

  const input = Math.ceil(text.length / CHARS_PER_TOKEN);
  const output = Number.isFinite(request.maxOutputTokens) ? request.maxOutputTokens : 0;

  return input + output;
}

/**
 * A bucket that refills continuously rather than in steps, so a caller never waits for
 * an arbitrary window boundary that has already effectively passed.
 */
class TokenBucket {
  constructor({ capacity, refillPerMs, now }) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMs;
    this.available = capacity;
    this.updatedAt = now();
    this.now = now;
  }

  refill() {
    const timestamp = this.now();
    const elapsed = Math.max(0, timestamp - this.updatedAt);
    if (elapsed > 0) {
      this.available = Math.min(this.capacity, this.available + elapsed * this.refillPerMs);
      this.updatedAt = timestamp;
    }
  }

  /** Milliseconds until `amount` is available. 0 when it already is. */
  waitFor(amount) {
    this.refill();
    if (amount > this.capacity) {
      // Asking for more than the bucket can ever hold would wait forever.
      return Number.POSITIVE_INFINITY;
    }
    if (this.available >= amount) return 0;
    return Math.ceil((amount - this.available) / this.refillPerMs);
  }

  take(amount) {
    this.refill();
    this.available -= amount;
  }
}

/**
 * Create a limiter.
 *
 * @param {object} options
 * @param {number} options.rpm requests per minute
 * @param {number} options.tpm estimated tokens per minute
 * @param {number} options.rpd requests per day
 * @param {() => number} [options.now] clock, injected for tests
 * @param {(ms: number) => Promise<void>} [options.sleep] delay, injected for tests
 */
export function createLimiter({
  rpm = 5,
  tpm = 100_000,
  rpd = 200,
  /**
   * How many requests may go out back-to-back before pacing begins.
   *
   * ONE BY DEFAULT, AND THAT IS THE FIX FOR A REAL 429. A bucket sized to `rpm` starts
   * FULL, so at rpm=5 it releases five requests instantly and then one every twelve
   * seconds — putting TEN requests into the first rolling sixty seconds against a limit
   * of five. Google measures a rolling window, so it returned 429 even though the
   * configured number matched the published limit exactly. That 429 was then blamed on
   * the number rather than on the burst, and the number was lowered to 2 (CF-053).
   *
   * With a burst of 1 the requests are spaced evenly at 60/rpm seconds and the rolling
   * window is never exceeded. The cost is that a run cannot open with a flurry; on a
   * ceiling of twenty requests a day, where every 429 costs a retry and every retry
   * costs one of those twenty, that is a trade worth making by default.
   */
  burst = 1,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const capacity = Math.max(1, Math.min(burst, rpm));
  const requests = new TokenBucket({ capacity, refillPerMs: rpm / MINUTE_MS, now });
  // TPM keeps a full bucket: token limits are measured per minute in aggregate, and one
  // large request is a single request — spacing tokens the way requests are spaced would
  // stall a legitimate prompt that fits comfortably inside the allowance.
  const tokens = new TokenBucket({ capacity: tpm, refillPerMs: tpm / MINUTE_MS, now });

  let dayCount = 0;
  let dayStartedAt = now();

  /** Serialises admission so two concurrent callers cannot both see the same free slot. */
  let queue = Promise.resolve();

  const stats = { admitted: 0, waitedMs: 0, refusedRpd: 0 };

  function rollDayIfNeeded() {
    const timestamp = now();
    if (timestamp - dayStartedAt >= 24 * 60 * MINUTE_MS) {
      dayCount = 0;
      dayStartedAt = timestamp;
    }
  }

  /**
   * Wait until one request carrying `estimatedTokens` may be sent, then account for it.
   *
   * Admission is serialised: the check and the deduction happen together, so two callers
   * racing on the last slot cannot both be admitted. This is the property that makes a
   * single shared instance meaningful.
   *
   * @param {{ estimatedTokens?: number, label?: string }} [request]
   * @returns {Promise<{ waitedMs: number, remainingToday: number }>}
   * @throws {LlmError} LLM_RATE_LIMITED with limit RPD when the daily ceiling is spent
   */
  async function acquire({ estimatedTokens = 0, label } = {}) {
    const admission = queue.then(async () => {
      rollDayIfNeeded();

      if (dayCount >= rpd) {
        stats.refusedRpd += 1;
        throw new LlmError(
          LLM_ERROR_CODES.RATE_LIMITED,
          `Daily request ceiling reached (${rpd} requests). RPD does not clear until the ` +
            'daily reset at midnight Pacific, so waiting is not an option — the run must ' +
            'degrade and assemble with what it has.',
          { limit: RATE_LIMIT_KINDS.RPD, label, retryable: false, remainingToday: 0 }
        );
      }

      const tokenCost = Math.max(0, Math.ceil(estimatedTokens));
      let waitedMs = 0;

      // Loop rather than wait once: another caller admitted while we slept may have
      // taken the slot we were waiting for.
      //
      // The iteration cap is a safety catch, not a policy. If the injected clock never
      // advances — a frozen clock in a test, or a sleep that resolves without waiting —
      // the bucket never refills and this loop would spin forever, pinning a core with
      // no error and no output. Failing loudly after a bounded number of rounds turns an
      // invisible hang into a diagnosable fault.
      const MAX_ADMISSION_ROUNDS = 1000;
      for (let round = 0; ; round += 1) {
        if (round >= MAX_ADMISSION_ROUNDS) {
          throw new LlmError(
            LLM_ERROR_CODES.RATE_LIMITED,
            `Admission did not converge after ${MAX_ADMISSION_ROUNDS} rounds. The clock ` +
              'is not advancing: check that the injected sleep actually waits.',
            { limit: RATE_LIMIT_KINDS.UNKNOWN, label, retryable: false }
          );
        }
        const requestWait = requests.waitFor(1);
        const tokenWait = tokenCost === 0 ? 0 : tokens.waitFor(tokenCost);

        if (tokenWait === Number.POSITIVE_INFINITY) {
          throw new LlmError(
            LLM_ERROR_CODES.RATE_LIMITED,
            `A single request estimated at ${tokenCost} tokens exceeds the whole ` +
              `per-minute budget of ${tpm}. It can never be admitted — shorten the input ` +
              'or raise GEMINI_TPM to match your rate limit page.',
            { limit: RATE_LIMIT_KINDS.TPM, label, retryable: false }
          );
        }

        const wait = Math.max(requestWait, tokenWait);
        if (wait <= 0) break;

        await sleep(wait);
        waitedMs += wait;
      }

      requests.take(1);
      if (tokenCost > 0) tokens.take(tokenCost);
      dayCount += 1;

      stats.admitted += 1;
      stats.waitedMs += waitedMs;

      return { waitedMs, remainingToday: rpd - dayCount };
    });

    // The queue advances whether or not this admission succeeded, so one refusal does
    // not deadlock every later caller.
    queue = admission.then(
      () => undefined,
      () => undefined
    );

    return admission;
  }

  /** Run `task` once admission is granted. The common path for callers. */
  async function schedule(task, request = {}) {
    const admission = await acquire(request);
    return task(admission);
  }

  function report() {
    rollDayIfNeeded();
    requests.refill();
    tokens.refill();
    return {
      rpm,
      tpm,
      rpd,
      requestsAvailable: Math.floor(requests.available),
      tokensAvailable: Math.floor(tokens.available),
      usedToday: dayCount,
      remainingToday: rpd - dayCount,
      admitted: stats.admitted,
      waitedMs: stats.waitedMs,
      refusedRpd: stats.refusedRpd,
    };
  }

  return { acquire, schedule, report };
}

/**
 * The process-wide limiters — ONE PER MODEL.
 *
 * Held in module-level slots rather than created at import time so configuration can be
 * applied once, at boot, from the adapter that read the environment.
 *
 * WHY PER MODEL, WHEN BLOCK C SAYS "ONE LIMITER". Block C's rule exists to stop two
 * limiters pacing the SAME model, because two buckets at "5 RPM" send ten requests a
 * minute. That danger is real and this preserves it: one instance per model, and a
 * second `configureLimiterFor` on the same model still throws.
 *
 * But Gemini's RPM, TPM and RPD are all per-model-per-project. Counting a light model's
 * requests against the main model's daily ceiling would make the two-model split buy
 * exactly nothing — the whole point of routing mechanical calls elsewhere is that
 * "elsewhere" has its own quota. One shared counter would refuse the 21st request of the
 * day even when 20 of them went to a model with a separate allowance.
 *
 * So: one limiter per model id, and `getLimiter(model)` is how a caller reaches the
 * right one. Callers that pass no model get the default, which is what every existing
 * call site did and still does.
 */
let shared = null;

/** model id -> limiter, for any model configured separately from the default. */
const perModel = new Map();

/**
 * Configure and return the default singleton. Calling it twice with different settings is
 * a programming error: it would mean part of the process is throttling against different
 * numbers, which is the two-limiter bug wearing a disguise.
 */
export function configureLimiter(options = {}) {
  if (shared) {
    throw new LlmError(
      LLM_ERROR_CODES.NOT_CONFIGURED,
      'The shared limiter is already configured. One instance per process — configure it ' +
        'once at boot and inject it. Use resetLimiterForTests() in tests.'
    );
  }
  shared = createLimiter(options);
  return shared;
}

/**
 * A limiter that admits everything, used when boot has not configured one.
 *
 * WHY PASS-THROUGH RATHER THAN DEFAULTS. The previous behaviour was to build a limiter
 * from this module's defaults on first use. Those defaults are invented numbers — and
 * one of them was provably wrong: `rpd = 200`, where this account's real free-tier
 * ceiling is 20, read off a live 429. Pacing against numbers nobody chose is not pacing,
 * it is a guess that looks like a guarantee, and it would have throttled every test
 * suite to 5 requests a minute with a real sleep.
 *
 * The real rates live on the owner's rate-limit page and reach the process through
 * `GEMINI_RPM`/`TPM`/`RPD`, so the only correct source is a `configureLimiter` call at
 * boot (CF-024). When that has not happened — a test, a pure-function import, a fake
 * provider that touches no network — there is nothing to pace and nothing to guess.
 *
 * The state is queryable rather than silent: `isLimiterConfigured()` lets an entry point
 * assert at boot that it did its job, and `report()` says `configured: false` so a run
 * that paced nothing cannot claim it did.
 */
function createPassThroughLimiter() {
  let admitted = 0;
  return {
    async acquire() {
      admitted += 1;
      return { waitedMs: 0, remainingToday: Number.POSITIVE_INFINITY };
    },
    schedule: (task) => task(),
    report: () => ({
      configured: false,
      admitted,
      waitedMs: 0,
      refusedRpd: 0,
      remainingToday: Number.POSITIVE_INFINITY,
    }),
  };
}

/**
 * Configure a limiter for ONE model, separate from the default.
 *
 * Used for the light-model split: RPM, TPM and RPD are all per-model-per-project on
 * Gemini, so a second model has its own allowance and must have its own counters.
 *
 * @param {string} model the model id, matched against `provider.model`
 * @param {object} options same shape as `createLimiter`
 */
export function configureLimiterFor(model, options = {}) {
  const key = String(model ?? '').trim();
  if (key === '') {
    throw new LlmError(
      LLM_ERROR_CODES.NOT_CONFIGURED,
      'configureLimiterFor needs a model id. A limiter keyed by an empty string would be ' +
        'reachable by accident from any caller that forgot to pass a model.'
    );
  }
  if (perModel.has(key)) {
    throw new LlmError(
      LLM_ERROR_CODES.NOT_CONFIGURED,
      `A limiter for "${key}" is already configured. One instance per model — two buckets ` +
        'at the same RPM send twice the configured rate. Use resetLimiterForTests() in tests.'
    );
  }
  const limiter = createLimiter(options);
  perModel.set(key, limiter);
  return limiter;
}

/**
 * Whether boot has configured a real limiter.
 *
 * @param {string} [model] ask about one model; omit for the default
 */
export function isLimiterConfigured(model) {
  if (model === undefined) return shared !== null;
  return perModel.has(String(model));
}

/**
 * The singleton.
 *
 * Returns the configured limiter when boot provided one, and a pass-through otherwise —
 * see `createPassThroughLimiter` for why that is not a silent failure. The fallback is
 * NOT cached into `shared`, so a later `configureLimiter` still succeeds rather than
 * throwing "already configured" because something read the limiter during import.
 */
export function getLimiter(model) {
  // A model with its own configured limiter gets it. Everything else falls through to
  // the default, which is what every call site did before the split existed.
  if (model !== undefined) {
    const own = perModel.get(String(model));
    if (own) return own;
  }
  return shared ?? passThrough;
}

const passThrough = createPassThroughLimiter();

/** Test-only. Production code must never call this. */
export function resetLimiterForTests() {
  shared = null;
  perModel.clear();
}
