/**
 * json.js — schema first, repair second.
 *
 * Decides: how a model response becomes an object, and what counts as a response worth
 * parsing at all.
 *
 * Does NOT decide: what the object should contain. Field-level validity belongs to
 * validateKit and the generation modules; this only produces a value from text.
 *
 * ORDER MATTERS, AND IT IS THE WHOLE POINT OF THIS FILE:
 *
 *   1. TRUNCATION IS CHECKED BEFORE PARSING. A response cut off at maxOutputTokens is
 *      still a string, and `[{"a":1},{"b":2}` fails loudly — but `[{"a":1},{"b":2}]`
 *      that was *meant* to have nine entries parses perfectly into two. Nothing about
 *      the text reveals that. finishReason does. Parsing first would let a silently
 *      short array through as a valid result, which is the worst outcome available:
 *      a kit that looks complete and is not.
 *
 *   2. WITH responseSchema SET, THE TEXT IS PARSED DIRECTLY. No markdown-fence
 *      stripping, no brace hunting, no "clean the response" pass. Structured output
 *      removes most malformed JSON at the source, and pre-processing that is no longer
 *      needed only hides the cases where the schema was not applied.
 *
 *   3. ONE REPAIR RE-PROMPT, THEN THROW. Repairs spend from the same 12-call budget as
 *      real work. A loop of them turns one bad response into an exhausted budget and a
 *      degraded kit. One attempt, then fail honestly.
 *
 * Pure apart from the injected repair call: no I/O of its own.
 */

import { LlmError, LLM_ERROR_CODES, assertUsableResponse } from './provider.js';

/** How much of a bad response to carry in an error before it stops being useful. */
const ERROR_TEXT_LIMIT = 500;

function excerpt(text) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length <= ERROR_TEXT_LIMIT ? value : `${value.slice(0, ERROR_TEXT_LIMIT)}…`;
}

/**
 * Parse the text of a response that has already been checked for truncation and
 * refusals.
 *
 * @param {string} text
 * @param {{ step?: string }} [context]
 * @returns {object}
 * @throws {LlmError} LLM_INVALID_OUTPUT
 */
export function parseJsonText(text, { step } = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new LlmError(LLM_ERROR_CODES.INVALID_OUTPUT, 'The model returned no text to parse.', {
      step,
      retryable: false,
    });
  }

  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new LlmError(
      LLM_ERROR_CODES.INVALID_OUTPUT,
      `Response was not valid JSON: ${cause.message}`,
      { step, text: excerpt(text), retryable: false }
    );
  }
}

/**
 * Check a raw response for refusal and truncation, then parse it.
 *
 * @param {object} response a GenerateContentResponse
 * @param {{ step?: string }} [context]
 * @returns {object}
 */
export function parseResponse(response, { step } = {}) {
  // Throws LLM_CONTENT_BLOCKED on a refusal and LLM_INVALID_OUTPUT on MAX_TOKENS.
  assertUsableResponse(response, { step });
  return parseJsonText(response?.text ?? '', { step });
}

/**
 * The instruction added to a repair attempt. It says what was wrong and asks for the
 * same content again, rather than asking the model to "fix" a string it cannot see.
 */
export function buildRepairInstruction(originalInstruction, failureMessage) {
  return [
    originalInstruction,
    '',
    'YOUR PREVIOUS RESPONSE WAS REJECTED.',
    `Reason: ${failureMessage}`,
    'Return the same information again as a single valid JSON value matching the schema.',
    'Output JSON only. No prose, no markdown fences, no commentary before or after.',
  ].join('\n');
}

/**
 * Parse a response, and on failure make exactly one repair attempt.
 *
 * @param {object} options
 * @param {object} options.response the first response
 * @param {() => Promise<object>} options.repair called at most once; must return a fresh
 *   response object. The caller supplies it so this module performs no I/O and so the
 *   repair spends from the caller's budget, visibly.
 * @param {string} [options.step]
 * @param {(event: object) => void} [options.onRepair]
 * @returns {Promise<object>}
 */
export async function parseWithRepair({ response, repair, step, onRepair } = {}) {
  try {
    return parseResponse(response, { step });
  } catch (firstError) {
    // A blocked prompt is not a parsing problem and a repair cannot help: the same
    // material will be refused again. Truncation is not repairable by re-prompting
    // either — the ceiling that cut it off is still the ceiling.
    if (firstError.code === LLM_ERROR_CODES.CONTENT_BLOCKED || firstError.details?.truncated) {
      throw firstError;
    }

    if (typeof repair !== 'function') throw firstError;

    if (typeof onRepair === 'function') {
      onRepair({ step, reason: firstError.code, message: firstError.message });
    }

    let repaired;
    try {
      repaired = await repair({ failure: firstError });
    } catch (repairError) {
      // Surface the repair's own failure, but keep the original visible: "the retry
      // failed" is much harder to act on without knowing what first went wrong.
      repairError.details = {
        ...(repairError.details ?? {}),
        step,
        afterRepairOf: firstError.code,
        originalMessage: firstError.message,
      };
      throw repairError;
    }

    try {
      return parseResponse(repaired, { step });
    } catch (secondError) {
      throw new LlmError(
        LLM_ERROR_CODES.INVALID_OUTPUT,
        `The response could not be parsed, and the single repair attempt also failed. ` +
          `First: ${firstError.message} Second: ${secondError.message}`,
        {
          step,
          firstCode: firstError.code,
          secondCode: secondError.code,
          repaired: true,
          retryable: false,
        }
      );
    }
  }
}

/**
 * One structured call with the repair path attached — the shape every generation module
 * should use, so none of them reimplements "try, then repair once".
 *
 * A repair is a second call and therefore a second unit of budget. That is deliberate
 * and visible: the caller passes the same `spend` function it uses for real work, so an
 * expensive repair loop shows up as an exhausted budget rather than as an invisible
 * doubling of the request count.
 *
 * @param {object} options
 * @param {{ complete: Function }} options.provider
 * @param {object} options.request systemInstruction, contents, responseSchema, maxTokens
 * @param {string} [options.step]
 * @param {() => void} [options.spend] called once per attempt, before it is made
 * @param {(event: object) => void} [options.onRepair]
 * @returns {Promise<object>} the parsed data
 */
export async function completeStructured({ provider, request, step, spend, onRepair } = {}) {
  if (!provider || typeof provider.complete !== 'function') {
    throw new LlmError(
      LLM_ERROR_CODES.NOT_CONFIGURED,
      'completeStructured requires a provider with a complete() function.',
      { step }
    );
  }

  const attempt = async (overrides = {}) => {
    if (typeof spend === 'function') spend();
    const { data } = await provider.complete({ ...request, ...overrides, step });
    return data;
  };

  try {
    return await attempt();
  } catch (firstError) {
    const unrepairable =
      firstError.code === LLM_ERROR_CODES.CONTENT_BLOCKED ||
      firstError.details?.truncated === true ||
      firstError.code !== LLM_ERROR_CODES.INVALID_OUTPUT;

    // Truncation is not repairable by asking again: maxOutputTokens has not moved, so a
    // second answer of the same size is cut off in the same place. Blocked content will
    // be blocked identically. Rate limits and transport faults belong to retry.js.
    if (unrepairable) throw firstError;

    if (typeof onRepair === 'function') {
      onRepair({ step, reason: firstError.code, message: firstError.message });
    }

    try {
      return await attempt({
        systemInstruction: buildRepairInstruction(request.systemInstruction, firstError.message),
      });
    } catch (secondError) {
      throw new LlmError(
        LLM_ERROR_CODES.INVALID_OUTPUT,
        `Structured output failed twice at step "${step}". ` +
          `First: ${firstError.message} Second: ${secondError.message}`,
        { step, repaired: true, retryable: false }
      );
    }
  }
}
