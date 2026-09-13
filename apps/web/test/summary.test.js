// A session summary: covered means the answer was revealed; untouched requirements say
// whether their cards were not reached or do not exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSession, next, rate, reveal, seenIds, settleRating } from '../src/practice/session.js';
import { summariseSession } from '../src/practice/summary.js';

const CARDS = [
  { id: 'f1', front: 'one', requirement_ids: ['r1'] },
  { id: 'f2', front: 'two', requirement_ids: ['r2'] },
  { id: 'f3', front: 'three', requirement_ids: ['r1', 'r3'] },
  { id: 'f4', front: 'four', requirement_ids: ['r3'] },
];
const REQUIREMENTS = [
  { id: 'r1', text: 'React' },
  { id: 'r2', text: 'APIs' },
  { id: 'r3', text: 'Performance' },
  { id: 'r4', text: 'Mentoring' },
];

/** f1 revealed and rated Again (saved); f2 revealed, not rated; f3 and f4 never revealed. */
function practisedSession() {
  let session = createSession(CARDS.map((card) => card.id));
  session = reveal(session);
  session = settleRating(rate(session, 'f1', 1), 'f1', 1, 'saved');
  session = reveal(next(session));
  return next(session);
}

test('revealing counts a card as seen once; stepping past it does not', () => {
  const session = practisedSession();
  assert.deepEqual(seenIds(session), ['f1', 'f2']);
  assert.deepEqual(seenIds(reveal(reveal(createSession(['f1'])))), ['f1']);
});

test('covered is what was revealed, with its rating; not seen is everything else', () => {
  const summary = summariseSession({ session: practisedSession(), cards: CARDS, requirements: REQUIREMENTS });

  assert.equal(summary.total, 4);
  assert.deepEqual(summary.covered, [
    { id: 'f1', front: 'one', rating: 'Again', saved: true },
    { id: 'f2', front: 'two', rating: null, saved: null },
  ]);
  assert.deepEqual(summary.notSeen.map((card) => card.id), ['f3', 'f4']);
  assert.deepEqual(summary.counts, [
    { label: 'Again', count: 1 },
    { label: 'Hard', count: 0 },
    { label: 'Good', count: 0 },
    { label: 'Easy', count: 0 },
  ]);
  assert.equal(summary.unrated, 1);
});

test('untouched requirement ids are named, and say whether a card exists for them', () => {
  const summary = summariseSession({ session: practisedSession(), cards: CARDS, requirements: REQUIREMENTS });

  assert.deepEqual(summary.untouchedRequirementIds, ['r3', 'r4']);
  assert.deepEqual(
    summary.requirements.map((row) => [row.id, row.touched, row.hasCard]),
    [
      ['r1', true, true],
      ['r2', true, true],
      ['r3', false, true],
      ['r4', false, false],
    ]
  );
});

test('a session that revealed nothing covered nothing and left every requirement untouched', () => {
  const summary = summariseSession({ session: createSession(['f1', 'f2']), cards: CARDS, requirements: REQUIREMENTS });
  assert.deepEqual(summary.covered, []);
  assert.deepEqual(summary.notSeen.map((card) => card.id), ['f1', 'f2']);
  assert.deepEqual(summary.untouchedRequirementIds, ['r1', 'r2', 'r3', 'r4']);
});
