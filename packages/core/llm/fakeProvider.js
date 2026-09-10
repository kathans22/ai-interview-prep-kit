/**
 * fakeProvider.js — a drop-in provider that never calls Google.
 *
 * Decides: what a given step "returns", and which failures to simulate.
 *
 * Does NOT decide: anything about real Gemini behaviour beyond the shapes it imitates.
 * It is a test double, and where it diverges from the real adapter it is wrong by
 * definition — provider.js is the reference.
 *
 * WHY THIS EXISTS AT ALL. The free tier caps requests per DAY, and that ceiling does not
 * clear until midnight Pacific. A test suite that costs real calls turns iteration into
 * rationing: run the tests four times in a morning and there is no quota left for the
 * timed batch run that is actually being graded. Everything except the extraction eval
 * and the real timed run uses this, so the day's quota is spent on the two things that
 * genuinely need a model.
 *
 * It is also deterministic, which the real model is not. An assertion against a canned
 * response tests our code; an assertion against a live model tests the weather.
 */

import { LlmError, LLM_ERROR_CODES, RATE_LIMIT_KINDS } from './provider.js';

/**
 * Build a response object shaped like the SDK's, including the `text` getter behaviour
 * the real one exposes.
 */
export function fakeResponse(payload, { finishReason = 'STOP', blockReason = null } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    text,
    candidates: [{ content: { parts: [{ text }] }, finishReason }],
    promptFeedback: blockReason ? { blockReason } : undefined,
  };
}

/**
 * Create a fake provider.
 *
 * @param {object} options
 * @param {Record<string, unknown>} [options.responses] canned data keyed by step name.
 *   A function value is called with the request, for steps that should vary.
 * @param {unknown} [options.fallback] returned for a step with no canned response
 * @param {object} [options.failures] failure simulation, keyed by step name or '*':
 *   { rateLimitTimes, unavailableTimes, blocked, truncated, invalidJsonTimes,
 *     retryAfterMs, limit }
 * @param {number} [options.tokensPerCall] what countTokens reports
 */
export function createFakeProvider({
  responses = {},
  fallback = {},
  failures = {},
  tokensPerCall = 100,
} = {}) {
  /** Every request seen, in order — the test's window into what the code actually sent. */
  const calls = [];
  /** Remaining simulated failures, decremented as they fire. */
  const budgetOf = new Map();

  function failureFor(step) {
    return { ...(failures['*'] ?? {}), ...(failures[step] ?? {}) };
  }

  function takeCounter(step, key, configured) {
    const mapKey = `${step}:${key}`;
    if (!budgetOf.has(mapKey)) budgetOf.set(mapKey, configured ?? 0);
    const left = budgetOf.get(mapKey);
    if (left > 0) {
      budgetOf.set(mapKey, left - 1);
      return true;
    }
    return false;
  }

  async function complete(request = {}) {
    const { step = 'unlabelled', systemInstruction = '', contents = '' } = request;
    calls.push({ ...request });

    // The boundary is not merely documented, it is enforced here too: a fake that
    // quietly accepted instructions in `contents` would let a real violation pass tests.
    if (typeof systemInstruction !== 'string' || systemInstruction.trim() === '') {
      throw new LlmError(
        LLM_ERROR_CODES.NOT_CONFIGURED,
        'fakeProvider: complete() requires a systemInstruction.',
        { step }
      );
    }

    const failure = failureFor(step);

    if (takeCounter(step, 'rateLimit', failure.rateLimitTimes)) {
      throw new LlmError(
        LLM_ERROR_CODES.RATE_LIMITED,
        `fakeProvider: simulated 429 for step "${step}".`,
        {
          step,
          status: 429,
          limit: failure.limit ?? RATE_LIMIT_KINDS.RPM,
          retryAfterMs: failure.retryAfterMs ?? null,
          retryable: true,
        }
      );
    }

    if (takeCounter(step, 'unavailable', failure.unavailableTimes)) {
      throw new LlmError(
        LLM_ERROR_CODES.UNAVAILABLE,
        `fakeProvider: simulated 503 for step "${step}".`,
        { step, status: 503, retryable: true }
      );
    }

    if (failure.blocked) {
      throw new LlmError(
        LLM_ERROR_CODES.CONTENT_BLOCKED,
        `fakeProvider: simulated safety block for step "${step}".`,
        { step, blockReason: 'SAFETY', retryable: false }
      );
    }

    if (failure.truncated) {
      throw new LlmError(
        LLM_ERROR_CODES.INVALID_OUTPUT,
        `fakeProvider: simulated MAX_TOKENS truncation for step "${step}".`,
        { step, finishReason: 'MAX_TOKENS', truncated: true, retryable: false }
      );
    }

    if (takeCounter(step, 'invalidJson', failure.invalidJsonTimes)) {
      throw new LlmError(
        LLM_ERROR_CODES.INVALID_OUTPUT,
        `fakeProvider: simulated unparseable output for step "${step}".`,
        { step, retryable: false }
      );
    }

    const canned = Object.prototype.hasOwnProperty.call(responses, step)
      ? responses[step]
      : fallback;
    const data = typeof canned === 'function' ? canned(request) : canned;

    return { data, raw: fakeResponse(data), text: JSON.stringify(data), contentsSeen: contents };
  }

  async function countTokens() {
    return tokensPerCall;
  }

  return {
    name: 'fake',
    model: 'fake-model',
    complete,
    countTokens,
    /** Test helpers. */
    calls,
    callCount: () => calls.length,
    callsFor: (step) => calls.filter((call) => call.step === step),
    reset: () => {
      calls.length = 0;
      budgetOf.clear();
    },
  };
}

/**
 * A fake that returns a raw response object rather than throwing, so the parsing path in
 * json.js can be exercised against genuinely malformed and genuinely truncated output
 * instead of against a pre-built error.
 */
export function createRawFakeProvider(sequence = []) {
  let index = 0;
  return {
    name: 'fake-raw',
    model: 'fake-model',
    nextResponse() {
      const entry = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      return entry;
    },
    async countTokens() {
      return 100;
    },
  };
}
