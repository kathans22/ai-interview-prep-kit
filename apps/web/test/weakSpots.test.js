// Weak spots on screen: named with their cards, and a verdict's missed points turned into
// what practice will do about them — or cannot.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeWeakSpots, practiceNote } from '../src/scoring/weakSpots.js';

const REQUIREMENTS = [
  { id: 'r1', text: 'React' },
  { id: 'r2', text: 'Mentoring' },
  { id: 'r3', text: 'APIs' },
];
const CARDS = [
  { id: 'f1', requirement_ids: ['r1'] },
  { id: 'f2', requirement_ids: ['r2'] },
  { id: 'f3', requirement_ids: ['r2', 'r1'] },
];

test('a weak spot lists the cards that cover it, and says when there are none', () => {
  assert.deepEqual(describeWeakSpots(['r2', 'r3'], REQUIREMENTS, CARDS), [
    { id: 'r2', text: 'Mentoring', cardIds: ['f2', 'f3'], hasCard: true },
    { id: 'r3', text: 'APIs', cardIds: [], hasCard: false },
  ]);
});

test('an id the kit no longer has is not shown as a weak spot', () => {
  assert.deepEqual(describeWeakSpots(['r9'], REQUIREMENTS, CARDS), []);
  assert.deepEqual(describeWeakSpots(undefined, REQUIREMENTS, CARDS), []);
});

test('a verdict with nothing missed says nothing about practice', () => {
  assert.equal(practiceNote([], CARDS), null);
});

test('missed requirements with cards will come up first; ones without cannot, and say so', () => {
  const both = practiceNote(['r2', 'r3'], CARDS);
  assert.equal(
    both.text,
    'Flashcards for r2 will come up first the next time you practise. No flashcard covers r3 yet, so practice cannot bring it back — add one below.'
  );
  assert.equal(both.canPractise, true);

  const none = practiceNote(['r3'], CARDS);
  assert.equal(none.canPractise, false, 'no link to practice when practice cannot help');
  assert.match(none.text, /^No flashcard covers r3 yet/);

  assert.match(practiceNote(['r1', 'r2'], CARDS).text, /^Flashcards for r1 and r2 will come up first/);
});
