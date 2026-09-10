/**
 * errors.js — the failure vocabulary shared by every generation step.
 *
 * Decides: what a generation step can fail with, and what a caught failure carries.
 *
 * Does NOT decide: what to do about it. The orchestrator catches these and degrades —
 * a step that cannot produce its part of the kit leaves that part empty and records
 * why, rather than failing the case.
 *
 * WHY EVERY STEP VALIDATES ITS OWN OUTPUT. responseSchema removes most malformed JSON,
 * but "well-formed" and "usable" are different claims: a schema cannot say that a
 * priority is one of two exact words, that an id is unique, or that evidence is a
 * verbatim quote. Each module checks its own contract before returning, so a bad value
 * is caught at the step that produced it and named there — not three steps later, in a
 * validateKit error that says only "questions[7].difficulty is not an integer".
 */

/** Codes a generation step can raise. A closed set. */
export const GENERATION_ERROR_CODES = Object.freeze({
  /** The model returned something the step cannot use, after its one repair attempt. */
  INVALID_OUTPUT: 'GENERATION_INVALID_OUTPUT',
  /** A required input was missing or unusable — a caller fault, not a model fault. */
  BAD_INPUT: 'GENERATION_BAD_INPUT',
  /** The step could not run at all: no provider, no budget left. */
  UNAVAILABLE: 'GENERATION_UNAVAILABLE',
});

export class GenerationError extends Error {
  /**
   * @param {string} code one of GENERATION_ERROR_CODES
   * @param {string} message
   * @param {object} [details] step name, offending values, the underlying cause
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GenerationError';
    this.code = code;
    this.details = details;
  }
}

/** Throw a BAD_INPUT error. Used for guard clauses at the top of each step. */
export function badInput(step, message, details = {}) {
  return new GenerationError(GENERATION_ERROR_CODES.BAD_INPUT, `${step}: ${message}`, {
    step,
    ...details,
  });
}

/** Throw an INVALID_OUTPUT error naming what was wrong with the model's answer. */
export function invalidOutput(step, message, details = {}) {
  return new GenerationError(GENERATION_ERROR_CODES.INVALID_OUTPUT, `${step}: ${message}`, {
    step,
    ...details,
  });
}

/**
 * Normalise anything thrown beneath a step into a GenerationError, preserving the
 * original code so the orchestrator can still tell a rate limit from bad JSON.
 */
export function asGenerationError(cause, step) {
  if (cause instanceof GenerationError) return cause;

  // LlmError and BudgetExhaustedError already carry a usable code; keep it rather than
  // flattening every failure into "generation failed", which would make backoff and
  // degradation decisions impossible upstream.
  if (cause && typeof cause.code === 'string') {
    const error = new GenerationError(cause.code, `${step}: ${cause.message}`, {
      step,
      ...(cause.details ?? {}),
      cause,
    });
    return error;
  }

  return new GenerationError(
    GENERATION_ERROR_CODES.UNAVAILABLE,
    `${step}: ${cause?.message ?? String(cause)}`,
    { step, cause }
  );
}
