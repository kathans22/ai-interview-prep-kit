// Answer feedback on the client: the length limits are core's, and a verdict reads as hit,
// missed, not judged, and one improvement.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANSWER_MAX_CHARS as CORE_MAX,
  ANSWER_MIN_CHARS as CORE_MIN,
} from '@aipk/core/scoring/scoreAnswer.js';

import { ANSWER_MAX_CHARS, ANSWER_MIN_CHARS, checkAnswer, describeVerdict } from '../src/scoring/feedback.js';

test("the client's length limits are exactly core's", () => {
  assert.equal(ANSWER_MIN_CHARS, CORE_MIN);
  assert.equal(ANSWER_MAX_CHARS, CORE_MAX);
});

test('an answer outside the limits says why, in words, counting what the server counts', () => {
  const empty = checkAnswer('');
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /at least 20 characters/);

  assert.equal(checkAnswer(`   ${'a'.repeat(19)}   `).ok, false, 'surrounding spaces do not count');
  assert.equal(checkAnswer('a'.repeat(20)).ok, true);

  const long = checkAnswer('a'.repeat(ANSWER_MAX_CHARS + 1));
  assert.equal(long.ok, false);
  assert.match(long.reason, /at most 4000 characters/);
});

test('a verdict groups hit and missed points, keeps not-judged separate, and carries one improvement', () => {
  const view = describeVerdict({
    hits: [
      { kind: 'requirement', id: 'r1', text: 'React performance', reason: 'profiled it' },
      { kind: 'outline', text: 'Measure first' },
    ],
    misses: [{ kind: 'requirement', id: 'r3', text: 'Mentoring', reason: 'not mentioned' }],
    requirements: [
      { id: 'r1', text: 'React performance', verdict: 'hit' },
      { id: 'r3', text: 'Mentoring', verdict: 'missed' },
      { id: 'r4', text: 'APIs', verdict: 'unjudged' },
    ],
    improvement: '  Say what the fix cost.  ',
  });

  assert.equal(view.headline, '2 hit · 1 missed');
  assert.deepEqual(view.hits.map((point) => [point.tag, point.text]), [
    ['r1', 'React performance'],
    ['outline', 'Measure first'],
  ]);
  assert.deepEqual(view.misses.map((point) => point.tag), ['r3']);
  assert.deepEqual(view.unjudged, [{ id: 'r4', text: 'APIs' }], 'not judged is not missed');
  assert.equal(view.improvement, 'Say what the fix cost.');
});

test('a malformed verdict reads as nothing rather than crashing the panel', () => {
  const view = describeVerdict(null);
  assert.equal(view.headline, '0 hit · 0 missed');
  assert.deepEqual([view.hits, view.misses, view.unjudged, view.improvement], [[], [], [], '']);
});
