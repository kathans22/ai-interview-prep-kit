/**
 * retry.js — when to try again, how long to wait, and when to stop.
 *
 * Decides: retry policy. Exponential backoff with jitter for 429s and 5xx, honouring
 * Retry-After when the server sent one, and refusing outright for failures that retrying
 * cannot fix.
 *
 * Does NOT decide: what the request was, whether the response was usable, or whether the
 * caller can afford another attempt — that is budget.js, and retries spend from it.
 *
 * WHAT IS NOT RETRIED, AND WHY IT MATTERS MORE THAN WHAT IS:
 *   LLM_CONTENT_BLOCKED — a crawled page tripped a safety filter. The same bytes will
 *     trip it again. Retrying spends budget to reproduce a certainty.
 *   LLM_INVALID_OUTPUT  — malformed or truncated JSON. The fix is one repair re-prompt
 *     with different instructions (json.js), not the identical request again.
 *   LLM_REQUEST_FAILED  — a 400 for a bad model id, a 403 for a bad key. Backing off
 *     repeatedly against a misconfigured .env hides the fault behind a delay.
 *   RPD exhaustion      — the daily ceiling does not clear until midnight Pacific, so a
 *     wait long enough to help is longer than the run.
 *
 * WHY JITTER. Batch case concurrency is 2 and both cases share one limiter, so they tend
 * to hit a 429 at the same moment. Identical backoff would have them wake together and
 * collide again — the thundering herd, self-inflicted. Randomising the wait spreads them.
 *
 * The sleep is injected so tests do not actually wait.
 */

import {
  LlmError,
  LLM_ERROR_CODES,
  RETRYABLE_CODES,
  RATE_LIMIT_KINDS,
  classifyError,
} from './provider.js';

/** Defaults chosen against a 5 RPM free tier: a full RPM window clears in ~60s. */
export const RETRY_DEFAULTS = Object.freeze({
  attempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.3,
});

/**
 * Is this failure worth another attempt?
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryable(error) {
  if (!(error instanceof LlmError)) return false;
  if (error.details?.retryable === false) return false;
  // RPD is rate limiting, but not the waitable kind.
  if (error.details?.limit === RATE_LIMIT_KINDS.RPD) return false;
  return RETRYABLE_CODES.includes(error.code);
}

/**
 * How long to wait before attempt N.
 *
 * Retry-After wins when the server sent one — it is the only number here that is not a
 * guess. Otherwise exponential backoff, capped, with jitter applied downward so a wait
 * is never longer than the cap.
 *
 * @param {number} attempt 1 for the wait after the first failure
 * @param {object} [options]
 * @param {number|null} [options.retryAfterMs]
 * @param {() => number} [options.random] injected for deterministic tests
 */
export function backoffDelay(attempt, {
  retryAfterMs = null,
  baseDelayMs = RETRY_DEFAULTS.baseDelayMs,
  maxDelayMs = RETRY_DEFAULTS.maxDelayMs,
  jitterRatio = RETRY_DEFAULTS.jitterRatio,
  random = Math.random,
} = {}) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs !== null && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, maxDelayMs);
  }

  const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  const jitter = exponential * jitterRatio * random();
  return Math.round(exponential - jitter);
}

/**
 * Run an async operation with retries.
 *
 * @param {() => Promise<T>} operation
 * @param {object} [options]
 * @param {number} [options.attempts] total attempts, including the first
 * @param {string} [options.step] label for logs
 * @param {(event: object) => void} [options.onRetry] called before each wait. Core does
 *   not log; this is how the adapter learns which limit we believe we hit.
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.random]
 * @returns {Promise<T>}
 * @template T
 */
export async function withRetry(operation, {
  attempts = RETRY_DEFAULTS.attempts,
  baseDelayMs = RETRY_DEFAULTS.baseDelayMs,
  maxDelayMs = RETRY_DEFAULTS.maxDelayMs,
  jitterRatio = RETRY_DEFAULTS.jitterRatio,
  step,
  onRetry,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new LlmError(
      LLM_ERROR_CODES.NOT_CONFIGURED,
      `withRetry requires at least one attempt, got ${attempts}.`,
      { step }
    );
  }

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation({ attempt });
    } catch (cause) {
      const error = classifyError(cause, { step });
      lastError = error;

      const isLastAttempt = attempt === attempts;
      if (!isRetryable(error) || isLastAttempt) {
        // Attach the attempt history so a caller can see this was not a single failure.
        error.details = { ...error.details, attempts: attempt, step };
        throw error;
      }

      const delayMs = backoffDelay(attempt, {
        retryAfterMs: error.details?.retryAfterMs ?? null,
        baseDelayMs,
        maxDelayMs,
        jitterRatio,
        random,
      });

      if (typeof onRetry === 'function') {
        onRetry({
          step,
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
          code: error.code,
          // Which bucket we believe we hit. RPM clears in ~60s, TPM within the minute,
          // RPD not until the daily reset — the wait that is correct differs, so the
          // suspicion is worth recording even though it is a suspicion.
          suspectedLimit: error.details?.limit ?? RATE_LIMIT_KINDS.UNKNOWN,
          honouredRetryAfter: error.details?.retryAfterMs != null,
          message: error.message,
        });
      }

      await sleep(delayMs);
    }
  }

  throw lastError;
}
