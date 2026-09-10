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
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const requests = new TokenBucket({ capacity: rpm, refillPerMs: rpm / MINUTE_MS, now });
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
 * The process-wide limiter.
 *
 * Held in a module-level slot rather than created at import time so configuration can be
 * applied once, at boot, from the adapter that read the environment. Every consumer
 * calls getLimiter() and gets the same object.
 */
let shared = null;

/**
 * Configure and return the singleton. Calling it twice with different settings is a
 * programming error: it would mean part of the process is throttling against different
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

/** The singleton, configured with defaults on first use if boot has not done so. */
export function getLimiter() {
  if (!shared) shared = createLimiter();
  return shared;
}

/** Test-only. Production code must never call this. */
export function resetLimiterForTests() {
  shared = null;
}
