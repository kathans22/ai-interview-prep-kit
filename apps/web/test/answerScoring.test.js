// answerScoring: the states of typing an answer and getting it scored — pure, so the
// transitions are provable without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canSubmit,
  createAnswerScorer,
  describeResult,
  isScoring,
  scoringFailed,
  scoringStarted,
  scoringSucceeded,
  setDraft,
} from '../src/practice/answerScoring.js';

const RESULT = {
  score: 3,
  hits: [{ point: 'a', explanation: 'because' }],
  misses: [{ point: 'b', explanation: 'why' }],
  improvement: 'add b',
  weakRequirementIds: ['r1'],
};

test('idle: nothing to submit until there is an answer, and typing enables the button', () => {
  const empty = createAnswerScorer();
  assert.equal(canSubmit(empty), false);
  assert.equal(canSubmit(setDraft(empty, '   ')), false);
  assert.equal(canSubmit(setDraft(empty, 'My answer')), true);
  assert.equal(isScoring(empty), false);
});

test('scoring: the wait disables the button and clears the old verdict and error', () => {
  const scored = scoringSucceeded(scoringStarted(setDraft(createAnswerScorer('a'), 'a')), RESULT);
  const again = scoringStarted(setDraft(scored, 'a better answer'));

  assert.equal(isScoring(again), true);
  assert.equal(canSubmit(again), false);
  assert.equal(again.result, null);
  assert.equal(again.answer, 'a better answer', 'the typed answer is kept through the wait');
});

test('success: the verdict arrives and the answer stays for another attempt', () => {
  const state = scoringSucceeded(scoringStarted(createAnswerScorer('my answer')), RESULT);
  assert.equal(state.status, 'scored');
  assert.deepEqual(state.result, RESULT);
  assert.equal(state.answer, 'my answer');
});

test('failure: the answer is kept and the error is shown; nothing was recorded', () => {
  const error = new Error('The answer could not be scored.');
  const state = scoringFailed(scoringStarted(createAnswerScorer('my answer')), error);
  assert.equal(state.status, 'failed');
  assert.equal(state.error, error);
  assert.equal(state.result, null);
  assert.equal(state.answer, 'my answer');
});

test('a late answer cannot overwrite a verdict that already arrived', () => {
  const scored = scoringSucceeded(scoringStarted(createAnswerScorer('a')), RESULT);
  const late = scoringFailed(scored, new Error('too late'));
  assert.equal(late, scored, 'a failure arriving after a success changes nothing');
});

test('describeResult leads with the score and says what it was made of', () => {
  assert.equal(describeResult(RESULT), 'Score 3 of 5 · 1 point hit · 1 missed');
  assert.equal(describeResult({ ...RESULT, hits: [], misses: [] }), 'Score 3 of 5 · 0 points hit · 0 missed');
  assert.equal(describeResult(null), '');
});
