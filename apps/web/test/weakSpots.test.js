// weakSpots: the server's weak requirement ids, named for the practice screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeWeakSpots } from '../src/practice/weakSpots.js';

const REQUIREMENTS = [
  { id: 'r1', text: '5+ years with React' },
  { id: 'r2', text: 'Mentoring juniors' },
];

const CARDS = [
  { id: 'f1', requirement_ids: ['r1'] },
  { id: 'f2', requirement_ids: ['r2'] },
];

test('the server ids are named with the kit\'s own words and card coverage', () => {
  const spots = describeWeakSpots(['r1'], REQUIREMENTS, CARDS);
  assert.deepEqual(spots, [{ id: 'r1', text: '5+ years with React', hasCard: true }]);
});

test('a requirement the kit still names but no card covers reads as uncovered', () => {
  const spots = describeWeakSpots(['r1'], REQUIREMENTS, [{ id: 'f9', requirement_ids: ['r2'] }]);
  assert.deepEqual(spots, [{ id: 'r1', text: '5+ years with React', hasCard: false }]);
});

test('an id the kit no longer names still shows, as its id — and reads as uncovered', () => {
  const spots = describeWeakSpots(['r9'], REQUIREMENTS, CARDS);
  assert.deepEqual(spots, [{ id: 'r9', text: 'r9', hasCard: false }]);
});

test('nothing weak means nothing to describe, whatever the inputs look like', () => {
  assert.deepEqual(describeWeakSpots([], REQUIREMENTS, CARDS), []);
  assert.deepEqual(describeWeakSpots(undefined, REQUIREMENTS, CARDS), []);
  assert.deepEqual(describeWeakSpots(null, undefined, undefined), []);
});
