/**
 * provider.js — the Gemini adapter. Text in, structured data out.
 *
 * Decides: how a request is shaped for Gemini, which side of the request our
 * instructions go on, and what class of failure a given SDK error represents.
 *
 * Does NOT decide: what to ask for. No prompts, no schemas, no business logic and no
 * retry policy live here — those belong to the generation modules, retry.js and the
 * orchestrator. This module is deliberately dull.
 *
 * THE INJECTION BOUNDARY IS THE POINT OF THIS FILE.
 *   systemInstruction — our instructions, and only ever ours.
 *   contents          — untrusted material: the pasted JD, crawled pages, search results.
 * They are separate parameters and are never concatenated. A crawled page cannot reach
 * systemInstruction through this function, because there is no argument that would carry
 * it there. Callers must route untrusted text through safePrompt first.
 *
 * NO temperature IS SET. Sampling parameters (temperature, top_p, top_k) are deprecated
 * on the Gemini 3.x line. Output consistency comes from responseSchema constraining the
 * shape plus tight instructions, not from sampling controls.
 *
 * Verified against @google/genai 2.21.0: GoogleGenAI, ai.models.generateContent,
 * ai.models.countTokens, the res.text getter, ApiError.status, and the FinishReason /
 * BlockedReason enums all exist as used below.
 */

import { GoogleGenAI, ApiError, FinishReason } from '@google/genai';

/** Typed failure codes. A closed set; every throw from this package uses one. */
export const LLM_ERROR_CODES = Object.freeze({
  RATE_LIMITED: 'LLM_RATE_LIMITED',
  UNAVAILABLE: 'LLM_UNAVAILABLE',
  INVALID_OUTPUT: 'LLM_INVALID_OUTPUT',
  CONTENT_BLOCKED: 'LLM_CONTENT_BLOCKED',
  // Not in the original four. A 400 for a bad model id or a 403 for a bad key is neither
  // "unavailable" nor "rate limited": retrying it wastes budget and hides a misconfigured
  // .env behind backoff. It gets its own code so retry.js can refuse to retry it.
  REQUEST_FAILED: 'LLM_REQUEST_FAILED',
  NOT_CONFIGURED: 'LLM_NOT_CONFIGURED',
});

/** Which rate limit we believe was hit. The right wait differs for each. */
export const RATE_LIMIT_KINDS = Object.freeze({
  RPM: 'RPM',
  TPM: 'TPM',
  RPD: 'RPD',
  UNKNOWN: 'UNKNOWN',
});

/** An error carrying a code, a message and the context needed to act on it. */
export class LlmError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.details = details;
    if (details.retryable !== undefined) this.retryable = details.retryable;
  }
}

/** Retryable classes. A blocked prompt and a bad request are not among them. */
export const RETRYABLE_CODES = Object.freeze([
  LLM_ERROR_CODES.RATE_LIMITED,
  LLM_ERROR_CODES.UNAVAILABLE,
]);

/**
 * Guess which limit a 429 refers to. Gemini does not always say, and the wait differs:
 * RPM clears in about a minute, TPM within the minute, RPD not until the daily reset.
 * A guess that is logged is worth more than a silent uniform backoff.
 */
export function classifyRateLimit(message = '') {
  const text = String(message).toLowerCase();
  if (text.includes('per day') || text.includes('daily') || text.includes('requests per day')) {
    return RATE_LIMIT_KINDS.RPD;
  }
  if (text.includes('token')) return RATE_LIMIT_KINDS.TPM;
  if (text.includes('per minute') || text.includes('rate')) return RATE_LIMIT_KINDS.RPM;
  return RATE_LIMIT_KINDS.UNKNOWN;
}

/** Read Retry-After from whatever shape the SDK surfaced, in milliseconds. */
export function retryAfterMs(error) {
  const headers = error?.headers ?? error?.response?.headers;
  const raw =
    typeof headers?.get === 'function'
      ? headers.get('retry-after')
      : headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw === undefined || raw === null || raw === '') return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));

  const asDate = Date.parse(raw);
  return Number.isNaN(asDate) ? null : Math.max(0, asDate - Date.now());
}

/**
 * Turn an SDK failure into a typed LlmError.
 *
 * @param {unknown} error
 * @param {{ step?: string }} context
 */
export function classifyError(error, { step } = {}) {
  if (error instanceof LlmError) return error;

  const status = error instanceof ApiError ? error.status : error?.status;
  const message = error?.message ?? String(error);

  if (status === 429) {
    const limit = classifyRateLimit(message);
    return new LlmError(
      LLM_ERROR_CODES.RATE_LIMITED,
      `Gemini refused the request as rate limited (suspected ${limit}): ${message}`,
      { step, status, limit, retryAfterMs: retryAfterMs(error), retryable: true }
    );
  }

  if (status === 408 || (typeof status === 'number' && status >= 500)) {
    return new LlmError(
      LLM_ERROR_CODES.UNAVAILABLE,
      `Gemini was unavailable (status ${status}): ${message}`,
      { step, status, retryable: true }
    );
  }

  if (typeof status === 'number' && status >= 400) {
    return new LlmError(
      LLM_ERROR_CODES.REQUEST_FAILED,
      `Gemini rejected the request (status ${status}): ${message}. ` +
        'This is a configuration or request fault — check GEMINI_MODEL and GEMINI_API_KEY. ' +
        'Retrying will not fix it.',
      { step, status, retryable: false }
    );
  }

  return new LlmError(
    LLM_ERROR_CODES.UNAVAILABLE,
    `Gemini call failed: ${message}`,
    { step, cause: error, retryable: true }
  );
}

/**
 * Inspect a response for refusals and truncation before anyone tries to read it.
 *
 * Truncation is the failure this project is most likely to hit once responseSchema is on,
 * and the easiest to miss: a response cut off at maxOutputTokens still yields a string,
 * and that string can parse into a shorter-but-valid-looking array. Detecting it here,
 * from finishReason rather than from the text, is the only reliable way.
 *
 * @param {object} response a GenerateContentResponse
 * @param {{ step?: string }} context
 * @throws {LlmError}
 */
export function assertUsableResponse(response, { step } = {}) {
  const blockReason = response?.promptFeedback?.blockReason;
  if (blockReason) {
    throw new LlmError(
      LLM_ERROR_CODES.CONTENT_BLOCKED,
      `Gemini blocked the prompt (${blockReason}). Something in the fetched material ` +
        'tripped a safety filter. Do not retry unchanged.',
      { step, blockReason, retryable: false }
    );
  }

  const candidate = response?.candidates?.[0];
  if (!candidate) {
    throw new LlmError(LLM_ERROR_CODES.INVALID_OUTPUT, 'Gemini returned no candidates.', {
      step,
      retryable: false,
    });
  }

  if (candidate.finishReason === FinishReason.SAFETY) {
    throw new LlmError(
      LLM_ERROR_CODES.CONTENT_BLOCKED,
      'Gemini stopped generation for safety reasons. Do not retry unchanged.',
      { step, finishReason: candidate.finishReason, retryable: false }
    );
  }

  if (candidate.finishReason === FinishReason.MAX_TOKENS) {
    throw new LlmError(
      LLM_ERROR_CODES.INVALID_OUTPUT,
      'Gemini hit maxOutputTokens, so the JSON is truncated. It may still parse while ' +
        'silently missing array items, which is why this is caught from finishReason ' +
        'rather than from the text.',
      { step, finishReason: candidate.finishReason, truncated: true, retryable: false }
    );
  }

  return candidate;
}

/**
 * Build a Gemini provider.
 *
 * @param {object} config
 * @param {string} config.apiKey
 * @param {string} config.model
 * @param {number} config.maxOutputTokens
 * @param {object} [config.client] an injected SDK client, for tests
 * @returns {{ name: string, model: string, complete: Function, countTokens: Function }}
 */
export function createGeminiProvider({ apiKey, model, maxOutputTokens, client } = {}) {
  if (!client) {
    if (!apiKey) {
      throw new LlmError(
        LLM_ERROR_CODES.NOT_CONFIGURED,
        'GEMINI_API_KEY is empty. Get a key from https://aistudio.google.com/apikey.'
      );
    }
    if (!model) {
      throw new LlmError(
        LLM_ERROR_CODES.NOT_CONFIGURED,
        'GEMINI_MODEL is empty. Pin a specific stable Flash model id from Google AI Studio.'
      );
    }
  }

  const ai = client ?? new GoogleGenAI({ apiKey });

  /**
   * One structured generation call.
   *
   * @param {object} request
   * @param {string} request.systemInstruction OUR instructions. Never fetched text.
   * @param {string} request.contents untrusted material, already wrapped by safePrompt.
   * @param {object} request.responseSchema flat OpenAPI-subset schema for this step
   * @param {number} [request.maxTokens]
   * @param {string} [request.step] a label for logs and errors
   * @returns {Promise<{ data: object, raw: object, text: string }>}
   */
  async function complete({ systemInstruction, contents, responseSchema, maxTokens, step } = {}) {
    if (typeof systemInstruction !== 'string' || systemInstruction.trim() === '') {
      throw new LlmError(
        LLM_ERROR_CODES.NOT_CONFIGURED,
        'complete() requires a systemInstruction. Instructions never travel in contents.',
        { step }
      );
    }

    let response;
    try {
      response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema,
          maxOutputTokens: maxTokens ?? maxOutputTokens,
        },
      });
    } catch (cause) {
      throw classifyError(cause, { step });
    }

    assertUsableResponse(response, { step });

    const text = response.text ?? '';
    // Parsing is intentionally minimal here; json.js takes over the parse-and-repair
    // path, and this adapter stays a transport concern.
    let data;
    try {
      data = JSON.parse(text);
    } catch (cause) {
      throw new LlmError(
        LLM_ERROR_CODES.INVALID_OUTPUT,
        `Gemini returned text that is not JSON: ${cause.message}`,
        { step, text, retryable: false }
      );
    }

    return { data, raw: response, text };
  }

  /**
   * Estimate the tokens a request will consume, so the TPM bucket is measured rather
   * than guessed. Counting failures never block a call — an estimate is a courtesy to
   * the limiter, not a precondition.
   *
   * @returns {Promise<number|null>} null when the count could not be obtained
   */
  async function countTokens({ systemInstruction = '', contents = '' } = {}) {
    try {
      const result = await ai.models.countTokens({
        model,
        contents: `${systemInstruction}\n${contents}`,
      });
      return result?.totalTokens ?? null;
    } catch {
      return null;
    }
  }

  return { name: 'gemini', model, complete, countTokens };
}

/**
 * Convenience construction from an environment bag. Block G specifies the model and key
 * come from env; keeping that in one named function means every other path stays
 * injectable and testable without touching process.env.
 */
export function createGeminiProviderFromEnv(env = process.env) {
  return createGeminiProvider({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    maxOutputTokens: Number(env.LLM_MAX_OUTPUT_TOKENS) || 8192,
  });
}
