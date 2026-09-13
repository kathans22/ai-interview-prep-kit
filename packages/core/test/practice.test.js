// Practice order: least confident first, very recent cards pushed back slightly, unseen
// cards in the middle — and nothing else deciding it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RATING_VALUES,
  RECENCY_HALF_LIFE_MS,
  RECENCY_PUSH_MAX,
  UNSEEN_PRIORITY,
  latestRatings,
  orderCards,
  recencyPush,
} from '@aipk/core/practice/orderCards.js';

const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(NOW - ms).toISOString();
const cards = (...ids) => ids.map((id) => ({ id, front: `front ${id}`, back: `back ${id}` }));
const rating = (cardId, confidence, msAgo) => ({ cardId, confidence, at: ago(msAgo) });
const ids = (ordered) => ordered.map((card) => card.id);

test('the constants keep their promises: the push is under one step, and unseen sits between hard and good', () => {
  assert.ok(RECENCY_PUSH_MAX < 1, 'a recency push must never carry a card past a whole rating');
  assert.ok(UNSEEN_PRIORITY > RATING_VALUES.hard && UNSEEN_PRIORITY < RATING_VALUES.good);
  assert.deepEqual(RATING_VALUES, { again: 1, hard: 2, good: 3, easy: 4 });
});

test('lowest ratings come first, and unseen cards are seeded in the middle', () => {
  const ordered = orderCards({
    cards: cards('easy', 'unseen', 'good', 'again', 'hard'),
    ratings: [rating('easy', 4, DAY), rating('good', 3, DAY), rating('again', 1, DAY), rating('hard', 2, DAY)],
    now: NOW,
  });
  assert.deepEqual(ids(ordered), ['again', 'hard', 'unseen', 'good', 'easy']);
  assert.equal(ordered.find((card) => card.id === 'unseen').seen, false);
});

test('a card rated moments ago is pushed back slightly — behind an older card with the same rating, never past a whole step', () => {
  const ordered = orderCards({
    cards: cards('againNow', 'againYesterday', 'hardYesterday', 'unseen', 'goodNow', 'goodYesterday'),
    ratings: [
      rating('againNow', 1, 0),
      rating('againYesterday', 1, DAY),
      rating('hardYesterday', 2, DAY),
      rating('goodNow', 3, 0),
      rating('goodYesterday', 3, DAY),
    ],
    now: NOW,
  });
  assert.deepEqual(ids(ordered), ['againYesterday', 'againNow', 'hardYesterday', 'unseen', 'goodYesterday', 'goodNow']);
});

test('the push halves every half-life, and has all but gone by the next sitting', () => {
  assert.equal(recencyPush(ago(0), NOW), RECENCY_PUSH_MAX);
  assert.equal(recencyPush(ago(RECENCY_HALF_LIFE_MS), NOW), RECENCY_PUSH_MAX / 2);
  assert.ok(recencyPush(ago(3 * HOUR), NOW) < 0.02);
  assert.equal(recencyPush('not a date', NOW), 0, 'no evidence it was recent, so no push');
  assert.equal(recencyPush(new Date(NOW + HOUR), NOW), RECENCY_PUSH_MAX, 'a future time counts as now');
});

test('the latest rating decides, not an average of the history', () => {
  const ordered = orderCards({
    cards: cards('learned', 'stillHard'),
    ratings: [rating('learned', 1, 2 * DAY), rating('learned', 1, DAY), rating('learned', 4, 2 * HOUR), rating('stillHard', 2, 2 * HOUR)],
    now: NOW,
  });
  assert.deepEqual(ids(ordered), ['stillHard', 'learned']);
  const learned = ordered.find((card) => card.id === 'learned');
  assert.equal(learned.latest, 4);
  assert.equal(learned.attempts, 3);
});

test('the log may arrive in any order; the latest by time wins, and a same-time tie goes to the later entry', () => {
  const late = rating('f1', 4, HOUR);
  const early = rating('f1', 1, DAY);
  assert.equal(latestRatings([late, early]).get('f1').value, 4);

  const at = ago(HOUR);
  assert.equal(latestRatings([{ cardId: 'f1', confidence: 1, at }, { cardId: 'f1', confidence: 3, at }]).get('f1').value, 3);
});

test('question ratings, ratings for other cards and ratings outside again..easy change nothing', () => {
  const ordered = orderCards({
    cards: cards('f1', 'f2'),
    ratings: [
      { questionId: 'q1', confidence: 1, at: ago(DAY) },
      rating('f9', 1, DAY),
      rating('f2', 5, DAY),
      rating('f2', 0, DAY),
      rating('f2', 2.5, DAY),
    ],
    now: NOW,
  });
  assert.deepEqual(
    ordered.map((card) => [card.id, card.seen, card.priority]),
    [
      ['f1', false, UNSEEN_PRIORITY],
      ['f2', false, UNSEEN_PRIORITY],
    ]
  );
});

test('ties keep the kit\'s own order, so the same inputs always give the same session', () => {
  const input = { cards: cards('a', 'b', 'c', 'd'), ratings: [rating('b', 2, DAY), rating('d', 2, DAY)], now: NOW };
  assert.deepEqual(ids(orderCards(input)), ['b', 'd', 'a', 'c']);
  assert.deepEqual(orderCards(input), orderCards(input));
});

test('EXIT CHECK, in miniature: a card rated "again" returns near the front of the very next session', () => {
  // Five cards; the whole deck was just practised; f3 was the one not known.
  const deck = cards('f1', 'f2', 'f3', 'f4', 'f5');
  const justNow = [rating('f1', 3, 60_000), rating('f2', 4, 50_000), rating('f3', 1, 40_000), rating('f4', 3, 30_000), rating('f5', 2, 20_000)];
  const next = orderCards({ cards: deck, ratings: justNow, now: NOW });
  assert.equal(next[0].id, 'f3', 'rated again moments ago, and still first');

  // Half the deck unpractised: the failed card still leads the unseen ones.
  const partial = orderCards({ cards: deck, ratings: [rating('f1', 4, 60_000), rating('f3', 1, 10_000)], now: NOW });
  assert.deepEqual(ids(partial).slice(0, 2), ['f3', 'f2']);
});

test('no cards, or no ratings, is an ordinary answer rather than an error', () => {
  assert.deepEqual(orderCards({ cards: [], ratings: [] }), []);
  assert.deepEqual(orderCards(), []);
  assert.deepEqual(ids(orderCards({ cards: cards('f1', 'f2'), ratings: undefined, now: NOW })), ['f1', 'f2']);
});
