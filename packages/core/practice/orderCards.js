/**
 * orderCards.js — the order flashcards come back in: what the person knew least, first.
 *
 * Decides: one number per card — its practice priority — from the ratings recorded
 * against it, and the order those numbers put the cards in.
 *
 * Does NOT decide: the words a person sees for a rating, how ratings are stored, or how
 * many cards a session covers. It is a pure function of the cards, the ratings and a
 * clock, so it runs identically in a test, on the server and anywhere else it is called.
 *
 * THE ALGORITHM: A CONFIDENCE-WEIGHTED SORT WITH A LIGHT RECENCY DECAY.
 *
 *   priority = latest rating                          (again 1, hard 2, good 3, easy 4)
 *            + RECENCY_PUSH_MAX × ½^(age / RECENCY_HALF_LIFE_MS)
 *   an unseen card has priority UNSEEN_PRIORITY       (2.5 — between hard and good)
 *   cards are practised lowest priority first; a tie keeps the kit's own order.
 *
 *   - LOWEST RATINGS FIRST. The point of recording confidence is to spend the next
 *     session where it was lowest. A card answered "again" comes back before one answered
 *     "hard", which comes back before one answered "good".
 *   - VERY RECENT CARDS ARE PUSHED BACK SLIGHTLY. A card rated a minute ago is still in
 *     short-term memory, so seeing it again at once measures recall of the last minute,
 *     not of the material. The push is at most 0.75 — LESS THAN ONE RATING STEP — so it
 *     reorders a card among its neighbours and can never carry it past a whole rating: a
 *     card failed a moment ago (1.75) still comes before any card found hard (2) and any
 *     unseen card (2.5). It halves every thirty minutes, so by the next sitting it has
 *     all but gone and yesterday's ratings count at full weight.
 *   - UNSEEN CARDS ARE SEEDED IN THE MIDDLE. New material should come before cards the
 *     person already knows well, and after cards they are known to be struggling with.
 *     First would bury the weak cards under everything not yet tried; last would mean a
 *     large deck is never finished.
 *   - THE LATEST RATING, NOT AN AVERAGE. Confidence is supposed to change: "again, again,
 *     easy" averages to 1.67 and would keep a card the person now knows at the front for
 *     days. The full history is still kept in the practice log; it simply does not decide
 *     the order.
 *
 * WHY NOT SM-2. SM-2 is built for months: per-card ease factors and intervals of one day,
 * then six, then growing. For someone practising over three days, the first interval
 * after a correct answer already runs past the horizon, so good cards simply disappear and
 * the scheduler's bookkeeping — state per card, dates that must be migrated when a card is
 * regenerated — buys nothing. This needs no state beyond the ratings already recorded, is
 * obvious to explain, and behaves sensibly over three days.
 *
 * RATINGS FOLLOW THE CARD ID. A regeneration that replaces a card keeps its id, so the new
 * card inherits the old card's ratings. The alternative — ignoring ratings older than the
 * card's `updatedAt` — was considered and rejected: `updatedAt` also moves when a card is
 * merely pinned, so it cannot mean "the content changed", and using it would silently
 * throw away a person's history for pressing Pin.
 */

/** Again, hard, good, easy — the numbers ratings are recorded as. */
export const RATING_VALUES = Object.freeze({ again: 1, hard: 2, good: 3, easy: 4 });

/** Where a card nobody has rated sits: after hard, before good. */
export const UNSEEN_PRIORITY = 2.5;

/** The most a very recent rating is pushed back. Deliberately less than one rating step. */
export const RECENCY_PUSH_MAX = 0.75;

/** How quickly that push fades: it halves every thirty minutes. */
export const RECENCY_HALF_LIFE_MS = 30 * 60 * 1000;

/**
 * How far a card covering a MISSED requirement is pulled forward. Also under one rating
 * step, for the same reason the recency push is: a "good" card covering a weak area
 * (3 − 0.6 = 2.4) surfaces ahead of the unseen cards, but never ahead of a card the
 * person actually found hard — and an "again" card keeps its lead outright.
 */
export const WEAK_BOOST = 0.6;


const isRating = (value) => Number.isInteger(value) && value >= RATING_VALUES.again && value <= RATING_VALUES.easy;

const timeOf = (value) => {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

/**
 * How far a rating made at `ratedAt` is pushed back at `now`. An unknown time is not
 * pushed at all — no evidence it was recent — and a time in the future counts as now.
 */
export function recencyPush(ratedAt, now) {
  const time = timeOf(ratedAt);
  if (time === null) return 0;
  const age = Math.max(0, now - time);
  return RECENCY_PUSH_MAX * 0.5 ** (age / RECENCY_HALF_LIFE_MS);
}

/**
 * The latest valid rating per card, from a practice log in any order.
 *
 * Only card ratings count: question ratings share the log and are ignored, as are ratings
 * outside again..easy. When two ratings carry the same time the one later in the log wins,
 * because the log is appended in the order ratings were made.
 */
export function latestRatings(entries) {
  const latest = new Map();
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const id = entry?.cardId;
    if (!id || !isRating(entry.confidence)) return;

    const time = timeOf(entry.at);
    const current = latest.get(id);
    if (current && current.time !== null && time !== null && time < current.time) {
      current.attempts += 1;
      return;
    }
    latest.set(id, {
      value: entry.confidence,
      time,
      at: time === null ? null : new Date(time).toISOString(),
      attempts: (current?.attempts ?? 0) + 1,
    });
  });
  return latest;
}

/**
 * The cards in practice order, each with the numbers that put it there.
 *
 * @param {object} input
 * @param {Array<{ id: string, requirement_ids?: string[] }>} input.cards  the kit's flashcards, in the kit's order
 * @param {Array<{ cardId?: string, confidence: number, at?: string|Date }>} input.ratings  the practice log
 * @param {number} [input.now]  milliseconds since the epoch
 * @param {string[]} [input.weakRequirements]  requirement ids a scored answer missed. A
 *   card covering one of them is pulled forward by WEAK_BOOST — still never past a whole
 *   rating step, so weak areas resurface without overriding what the person said.
 * @returns {Array<{ id: string, priority: number, seen: boolean, latest: number|null, attempts: number, lastAt: string|null, weak: boolean }>}
 */
export function orderCards({ cards, ratings, now = Date.now(), weakRequirements = [] } = {}) {
  const latest = latestRatings(ratings);
  const weakSet = new Set(Array.isArray(weakRequirements) ? weakRequirements : []);

  return (Array.isArray(cards) ? cards : [])
    .filter((card) => card && card.id)
    .map((card, position) => {
      const weak = weakSet.size > 0 && (card.requirement_ids ?? []).some((id) => weakSet.has(id));
      const rating = latest.get(card.id);
      if (!rating) {
        return {
          id: card.id,
          priority: UNSEEN_PRIORITY - (weak ? WEAK_BOOST : 0),
          seen: false,
          latest: null,
          attempts: 0,
          lastAt: null,
          weak,
          position,
        };
      }
      return {
        id: card.id,
        priority: rating.value + recencyPush(rating.at, now) - (weak ? WEAK_BOOST : 0),
        seen: true,
        latest: rating.value,
        attempts: rating.attempts,
        lastAt: rating.at,
        weak,
        position,
      };
    })
    .sort((a, b) => a.priority - b.priority || a.position - b.position)
    .map(({ position, ...card }) => card);
}
