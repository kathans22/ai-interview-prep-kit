// A practice session: one card at a time, the answer hidden until asked for, and hidden
// again on every move.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSession,
  currentCardId,
  describePosition,
  isFirst,
  isLast,
  next,
  previous,
  rate,
  rateAndAdvance,
  ratingOf,
  reveal,
  settleRating,
} from '../src/practice/session.js';
import { RATINGS, ratingFor } from '../src/practice/ratings.js';

test('a session starts on the first card with its answer hidden', () => {
  const session = createSession(['f1', 'f2', 'f3']);
  assert.equal(currentCardId(session), 'f1');
  assert.equal(session.revealed, false);
  assert.equal(describePosition(session), 'Card 1 of 3');
  assert.ok(isFirst(session));
  assert.ok(!isLast(session));
});

test('revealing shows the answer, and revealing again changes nothing', () => {
  const shown = reveal(createSession(['f1', 'f2']));
  assert.equal(shown.revealed, true);
  assert.equal(reveal(shown), shown);
});

test('every move hides the answer again', () => {
  const moved = next(reveal(createSession(['f1', 'f2'])));
  assert.equal(currentCardId(moved), 'f2');
  assert.equal(moved.revealed, false, 'a card must never arrive with its answer showing');
  assert.equal(previous(reveal(moved)).revealed, false);
});

test('moves stop at either end instead of wrapping, and a move that goes nowhere keeps the answer', () => {
  const start = reveal(createSession(['f1', 'f2']));
  assert.equal(previous(start), start, 'nothing before the first card');

  const end = reveal(next(start));
  assert.ok(isLast(end));
  assert.equal(next(end), end, 'nothing after the last card — starting again is the person\'s decision');
});

// --- ratings -------------------------------------------------------------------

test('the four answers are again, hard, good, easy, recorded as 1 to 4', () => {
  assert.deepEqual(RATINGS.map((rating) => [rating.key, rating.value]), [
    ['again', 1],
    ['hard', 2],
    ['good', 3],
    ['easy', 4],
  ]);
  assert.equal(ratingFor(3).label, 'Good');
  assert.equal(ratingFor(5), null);
});

test('rating a card draws it at once as saving, and moves on to the next card with its answer hidden', () => {
  const after = rateAndAdvance(reveal(createSession(['f1', 'f2'])), 1);
  assert.deepEqual(ratingOf(after, 'f1'), { value: 1, status: 'saving' });
  assert.equal(currentCardId(after), 'f2');
  assert.equal(after.revealed, false);
});

test('rating the last card keeps it in view, so the rating is visibly recorded', () => {
  const last = reveal(next(createSession(['f1', 'f2'])));
  const after = rateAndAdvance(last, 4);
  assert.equal(currentCardId(after), 'f2');
  assert.equal(after.revealed, true);
  assert.deepEqual(ratingOf(after, 'f2'), { value: 4, status: 'saving' });
});

test('the server\'s answer settles a rating, but never overwrites a newer choice for the same card', () => {
  let session = rate(createSession(['f1']), 'f1', 2);
  const failed = settleRating(session, 'f1', 2, 'failed');
  assert.deepEqual(ratingOf(failed, 'f1'), { value: 2, status: 'failed' });

  // Chose Hard, then Good before Hard's answer arrived: Hard's answer must not win.
  session = rate(session, 'f1', 3);
  assert.equal(settleRating(session, 'f1', 2, 'saved'), session);
  assert.deepEqual(ratingOf(settleRating(session, 'f1', 3, 'saved'), 'f1'), { value: 3, status: 'saved' });
});

test('a rating for a card outside the session is ignored', () => {
  const session = createSession(['f1']);
  assert.equal(rate(session, 'f9', 1), session);
  assert.equal(ratingOf(session, 'f9'), null);
});

test('duplicate and blank ids are dropped, and an empty session says so', () => {
  assert.deepEqual(createSession(['f1', '', 'f1', null, 'f2']).order, ['f1', 'f2']);

  const empty = createSession([]);
  assert.equal(currentCardId(empty), null);
  assert.equal(describePosition(empty), 'No cards');
  assert.equal(reveal(empty), empty);
});
