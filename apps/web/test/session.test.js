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
  reveal,
} from '../src/practice/session.js';

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

test('duplicate and blank ids are dropped, and an empty session says so', () => {
  assert.deepEqual(createSession(['f1', '', 'f1', null, 'f2']).order, ['f1', 'f2']);

  const empty = createSession([]);
  assert.equal(currentCardId(empty), null);
  assert.equal(describePosition(empty), 'No cards');
  assert.equal(reveal(empty), empty);
});
