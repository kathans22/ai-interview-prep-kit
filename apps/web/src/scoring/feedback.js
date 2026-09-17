/**
 * feedback.js — whether a typed answer can be sent, and how a verdict reads.
 *
 * Decides: the reason shown while an answer is too short or too long, and how a verdict is
 * grouped for reading — what was hit, what was missed, what could not be judged, and the
 * one improvement.
 *
 * Does NOT decide: what an answer is judged against or what the verdict is. Both are
 * core's `scoreAnswer`, reached through the server.
 *
 * THE LENGTH LIMITS ARE A MIRROR, HELD TO CORE BY A TEST. The server refuses an answer
 * outside them anyway; they are repeated here only so the button can say why it will not
 * send before the person spends a round trip finding out — the same bargain as the kit
 * form's bounds (CF-068).
 */

/** Mirrors core's ANSWER_MIN_CHARS. */
export const ANSWER_MIN_CHARS = 20;

/** Mirrors core's ANSWER_MAX_CHARS. */
export const ANSWER_MAX_CHARS = 4000;

/** Can this answer be sent, and if not, why not — in words. */
export function checkAnswer(text) {
  const length = String(text ?? '').trim().length;
  if (length < ANSWER_MIN_CHARS) {
    return {
      ok: false,
      length,
      reason: `Write at least ${ANSWER_MIN_CHARS} characters so there is something to score (${length} so far).`,
    };
  }
  if (length > ANSWER_MAX_CHARS) {
    return { ok: false, length, reason: `An answer can be at most ${ANSWER_MAX_CHARS} characters — this one is ${length}.` };
  }
  return { ok: true, length, reason: '' };
}

const toPoint = (point) =>
  point.kind === 'requirement'
    ? { key: `requirement:${point.id}`, kind: 'requirement', tag: point.id, text: point.text, reason: point.reason ?? '' }
    : { key: `outline:${point.text}`, kind: 'outline', tag: 'outline', text: point.text, reason: '' };

/**
 * A verdict, grouped for reading.
 *
 * A requirement the model did not judge is listed on its own rather than folded into
 * "missed": telling a person they missed something nobody assessed would send them to
 * practise the wrong thing.
 */
export function describeVerdict(result) {
  const hits = (Array.isArray(result?.hits) ? result.hits : []).map(toPoint);
  const misses = (Array.isArray(result?.misses) ? result.misses : []).map(toPoint);
  const unjudged = (Array.isArray(result?.requirements) ? result.requirements : [])
    .filter((requirement) => requirement.verdict === 'unjudged')
    .map((requirement) => ({ id: requirement.id, text: requirement.text }));

  return {
    headline: `${hits.length} hit · ${misses.length} missed`,
    hits,
    misses,
    unjudged,
    improvement: String(result?.improvement ?? '').trim(),
  };
}
