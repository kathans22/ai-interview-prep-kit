/**
 * session.js — one practice session: which card is showing, whether its answer is, and
 * what the person said about each card they rated.
 *
 * Decides: the cards a session walks and in what order it walks them, where it is, that
 * an answer is hidden until asked for — and hidden again on every move — and the state of
 * each rating made in this session.
 *
 * Does NOT decide: which order is best (that is the server's, weakest first, once ratings
 * exist), what a rating means, how a rating reaches the server, or how any of it is drawn.
 *
 * PURE, SO THE RULES CAN BE TESTED WITHOUT A BROWSER. The screen is a thin reader of this
 * state; every move is a function from one session to the next.
 *
 * EVERY MOVE HIDES THE ANSWER. A card that arrives with its answer already showing —
 * because the previous card's was — cannot be practised: recall is the exercise, and it
 * is over before it starts.
 *
 * MOVES STOP AT THE ENDS rather than wrapping. Wrapping from the last card to the first
 * would quietly start the session again, which is a decision the person should make.
 *
 * A RATING IS DRAWN AT ONCE, THEN SETTLED. It is marked `saving` the moment it is chosen,
 * so practice never waits on the network, and becomes `saved` or `failed` when the server
 * answers. A later rating of the same card supersedes an earlier one still in flight, and
 * the earlier answer must not overwrite it.
 */

/** A session over these card ids, in this order. Duplicates and blanks are dropped. */
export function createSession(cardIds) {
  const order = [...new Set((Array.isArray(cardIds) ? cardIds : []).filter(Boolean))];
  return { order, index: 0, revealed: false, ratings: {}, seen: [] };
}

/**
 * Card ids whose answer was revealed in this session, in the order they were first seen.
 * A card that was stepped past without looking at its answer was not practised, so it is
 * not "seen" — whatever the screen showed of its front.
 */
export const seenIds = (session) => session.seen ?? [];

export const currentCardId = (session) => session.order[session.index] ?? null;
export const isFirst = (session) => session.index <= 0;
export const isLast = (session) => session.index >= session.order.length - 1;

/** Show the current card's answer, and count the card as seen. Revealing twice changes nothing. */
export function reveal(session) {
  if (session.order.length === 0 || session.revealed) return session;
  const cardId = currentCardId(session);
  const seen = seenIds(session);
  return { ...session, revealed: true, seen: seen.includes(cardId) ? seen : [...seen, cardId] };
}

/** Move by `delta` cards, stopping at either end. A move that goes nowhere changes nothing. */
export function move(session, delta) {
  const last = Math.max(session.order.length - 1, 0);
  const index = Math.min(Math.max(session.index + delta, 0), last);
  if (index === session.index) return session;
  return { ...session, index, revealed: false };
}

export const next = (session) => move(session, 1);
export const previous = (session) => move(session, -1);

/** "Card 3 of 12" — the position as a person reads it. */
export function describePosition(session) {
  if (session.order.length === 0) return 'No cards';
  return `Card ${session.index + 1} of ${session.order.length}`;
}

/** This session's rating of a card: `{ value, status }`, or null if it has none. */
export const ratingOf = (session, cardId) => session.ratings?.[cardId] ?? null;

/** Record a rating for a card in this session, marked `saving`. Unknown cards are ignored. */
export function rate(session, cardId, value) {
  if (!session.order.includes(cardId)) return session;
  return { ...session, ratings: { ...session.ratings, [cardId]: { value, status: 'saving' } } };
}

/**
 * Rate the current card and move on, unless it is the last. On the last card the rating
 * stays in view, because moving nowhere would leave the person looking at a card with no
 * sign that anything happened.
 */
export function rateAndAdvance(session, value) {
  const cardId = currentCardId(session);
  if (!cardId) return session;
  const rated = rate(session, cardId, value);
  return isLast(rated) ? rated : next(rated);
}

/**
 * The server answered for a rating. Marks it `saved` or `failed` — but only if it is still
 * the rating waiting: a newer choice for the same card is not overwritten by an older
 * answer.
 */
export function settleRating(session, cardId, value, status) {
  const current = ratingOf(session, cardId);
  if (!current || current.value !== value || current.status !== 'saving') return session;
  return { ...session, ratings: { ...session.ratings, [cardId]: { value, status } } };
}
