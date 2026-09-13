/**
 * answerScoring.js — the states of typing an answer and getting it scored.
 *
 * Decides: what the answer panel shows while idle, scoring, scored and failed; that a
 * typed answer is kept after a score (so it can be edited and re-scored, not retyped);
 * and that a late failure cannot overwrite an answer that already arrived.
 *
 * Does NOT decide: what the server scores against (core's `scoreAnswer`), what the
 * request costs (the route's budget), or how any of it is drawn.
 *
 * PURE, so the rules can be tested without a browser. Every transition is a function
 * from one state to the next, exactly like `session.js`.
 */

/** The panel before anything has been typed. */
export function createAnswerScorer(answer = '') {
  return { status: 'idle', answer, result: null, error: null };
}

/** A submission is in flight. Nothing else may be submitted until it settles. */
export const isScoring = (state) => state.status === 'scoring';

/** The button is live only when there is something to score and nothing in flight. */
export const canSubmit = (state) => !isScoring(state) && state.answer.trim() !== '';

/** Every keystroke. Typing after a score clears the old verdict's hold on the form. */
export function setDraft(state, answer) {
  return { ...state, answer };
}

/** The person submitted. The previous verdict and error give way to the wait. */
export function scoringStarted(state) {
  return { ...state, status: 'scoring', result: null, error: null };
}

/** The server scored it. The typed answer stays, so it can be improved and re-scored. */
export function scoringSucceeded(state, result) {
  if (state.status !== 'scoring') return state;
  return { ...state, status: 'scored', result };
}

/** The server could not score it. The typed answer stays; the error is the panel's to show. */
export function scoringFailed(state, error) {
  if (state.status !== 'scoring') return state;
  return { ...state, status: 'failed', error };
}

/**
 * The one line the feedback view leads with: the score, and what it was made of.
 * A result with no hits and no misses says so rather than reading as "0 of 0".
 */
export function describeResult(result) {
  if (!result) return '';
  const { score, hits, misses } = result;
  const parts = [`Score ${score} of 5`, `${hits.length} point${hits.length === 1 ? '' : 's'} hit`, `${misses.length} missed`];
  return parts.join(' · ');
}
