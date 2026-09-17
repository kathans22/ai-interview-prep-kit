// Weak spots: a requirement is weak when the most recent scored verdict on it was a miss.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { weakRequirementIds } from '@aipk/core/scoring/weakSpots.js';

const at = (minutes) => new Date(Date.parse('2026-09-16T10:00:00.000Z') + minutes * 60_000).toISOString();
const score = (minutes, verdicts) => ({
  questionId: 'q1',
  at: at(minutes),
  verdicts: Object.entries(verdicts).map(([requirementId, verdict]) => ({ requirementId, verdict })),
});

test('a missed requirement is weak; a hit one is not', () => {
  assert.deepEqual(weakRequirementIds([score(0, { r1: 'hit', r2: 'missed' })]), ['r2']);
});

test('the latest verdict decides: a later hit clears a miss, a later miss makes it weak again', () => {
  assert.deepEqual(weakRequirementIds([score(0, { r2: 'missed' }), score(5, { r2: 'hit' })]), []);
  assert.deepEqual(weakRequirementIds([score(0, { r2: 'hit' }), score(5, { r2: 'missed' })]), ['r2']);
});

test('verdicts from different questions count together, and the log may arrive in any order', () => {
  const log = [score(10, { r3: 'hit' }), { ...score(0, { r3: 'missed' }), questionId: 'q2' }];
  assert.deepEqual(weakRequirementIds(log), [], 'the later hit on another question clears it');
});

test('at the same moment, the later entry in the log wins', () => {
  assert.deepEqual(weakRequirementIds([score(0, { r1: 'hit' }), score(0, { r1: 'missed' })]), ['r1']);
});

test('unjudged is not evidence, and malformed entries change nothing', () => {
  assert.deepEqual(weakRequirementIds([score(0, { r1: 'missed' }), score(5, { r1: 'unjudged' })]), ['r1']);
  assert.deepEqual(weakRequirementIds([null, { verdicts: [{ verdict: 'missed' }] }, score(0, { r2: 'maybe' })]), []);
  assert.deepEqual(weakRequirementIds(undefined), []);
});

test('only requirements the kit still has can be weak', () => {
  assert.deepEqual(weakRequirementIds([score(0, { r1: 'missed', r9: 'missed' })], { requirementIds: ['r1', 'r2'] }), ['r1']);
});

test('weak spots are listed in the order their deciding miss happened', () => {
  assert.deepEqual(weakRequirementIds([score(10, { r2: 'missed' }), score(0, { r5: 'missed' })]), ['r5', 'r2']);
});
