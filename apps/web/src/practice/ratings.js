/**
 * ratings.js — the four answers to "how well did you know it?".
 *
 * Decides: the words, their order, and the number each is recorded as.
 *
 * Does NOT decide: what a rating does to the order cards come back in. That is decided
 * from the stored numbers, not from these words.
 *
 * NAMED FOR WHAT HAPPENED, NOT AS A SCORE. "Again" reports "I did not know it — bring it
 * back"; an unlabelled 1-to-4 invites a person to grade themselves rather than say what
 * happened. The numbers are what is stored, because numbers sort.
 */

export const RATINGS = Object.freeze([
  Object.freeze({ value: 1, key: 'again', label: 'Again' }),
  Object.freeze({ value: 2, key: 'hard', label: 'Hard' }),
  Object.freeze({ value: 3, key: 'good', label: 'Good' }),
  Object.freeze({ value: 4, key: 'easy', label: 'Easy' }),
]);

/** The rating recorded as `value`, or null for anything else. */
export function ratingFor(value) {
  return RATINGS.find((rating) => rating.value === value) ?? null;
}
