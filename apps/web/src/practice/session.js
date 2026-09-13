/**
 * session.js — one practice session: which card is showing, and whether its answer is.
 *
 * Decides: the cards a session walks and in what order it walks them, where it is, and
 * that an answer is hidden until asked for — and hidden again on every move.
 *
 * Does NOT decide: which order is best (that is the server's, weakest first, once ratings
 * exist), what a rating means, or how any of it is drawn.
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
 */

/** A session over these card ids, in this order. Duplicates and blanks are dropped. */
export function createSession(cardIds) {
  const order = [...new Set((Array.isArray(cardIds) ? cardIds : []).filter(Boolean))];
  return { order, index: 0, revealed: false };
}

export const currentCardId = (session) => session.order[session.index] ?? null;
export const isFirst = (session) => session.index <= 0;
export const isLast = (session) => session.index >= session.order.length - 1;

/** Show the current card's answer. Revealing twice changes nothing. */
export function reveal(session) {
  if (session.order.length === 0 || session.revealed) return session;
  return { ...session, revealed: true };
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
