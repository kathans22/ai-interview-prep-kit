// Reordering questions: what a drop means, how it is drawn before the server answers,
// and how its id list is rebuilt at the moment it is sent so the server never sees a
// stale one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planMove } from '../src/kits/reorder.js';
import { applyLocalOps, orderCategory } from '../src/kits/localOps.js';
import { confirm, createEditState, enqueue, resolveOrder, takeBatch } from '../src/kits/editQueue.js';

const question = (id, category, extra = {}) => ({ id, category, prompt: `prompt ${id}`, origin: 'generated', pinned: false, ...extra });

const QUESTIONS = Object.freeze([
  question('q1', 'technical'),
  question('q2', 'behavioural'),
  question('q3', 'technical'),
  question('q4', 'technical'),
]);
const KIT = Object.freeze({ questions: QUESTIONS });

const ids = (list, category) => list.filter((entry) => entry.category === category).map((entry) => entry.id);

// --- planMove ---------------------------------------------------------------

test('a drop within a category is one reorder naming the whole category', () => {
  assert.deepEqual(planMove(QUESTIONS, { id: 'q4', category: 'technical', beforeId: 'q1' }), [
    { type: 'reorder-questions', category: 'technical', question_ids: ['q4', 'q1', 'q3'] },
  ]);
});

test('a drop where the question already is changes nothing and sends nothing', () => {
  assert.deepEqual(planMove(QUESTIONS, { id: 'q3', category: 'technical', beforeId: 'q4' }), []);
  assert.deepEqual(planMove(QUESTIONS, { id: 'q4', category: 'technical', beforeId: null }), []);
});

test('a drop across categories is the move, then the order of the category it lands in', () => {
  assert.deepEqual(planMove(QUESTIONS, { id: 'q2', category: 'technical', beforeId: 'q3' }), [
    { type: 'move-category', id: 'q2', category: 'technical' },
    { type: 'reorder-questions', category: 'technical', question_ids: ['q1', 'q2', 'q3', 'q4'] },
  ]);
});

test('a drop into an empty category, or at the end, lands last', () => {
  assert.deepEqual(planMove(QUESTIONS, { id: 'q1', category: 'company', beforeId: null }), [
    { type: 'move-category', id: 'q1', category: 'company' },
    { type: 'reorder-questions', category: 'company', question_ids: ['q1'] },
  ]);
});

test('a question still being added is neither movable nor named in a list', () => {
  const withPending = [...QUESTIONS, question('pending-1', 'technical', { pendingAdd: true })];
  assert.deepEqual(planMove(withPending, { id: 'pending-1', category: 'technical', beforeId: 'q1' }), []);
  assert.deepEqual(planMove(withPending, { id: 'q1', category: 'technical', beforeId: null })[0].question_ids, ['q3', 'q4', 'q1']);
});

test('a question awaiting its undo window is still on the server, so it is still named', () => {
  const withHeld = QUESTIONS.map((entry) => (entry.id === 'q3' ? { ...entry, pendingDelete: true } : entry));
  assert.deepEqual(planMove(withHeld, { id: 'q4', category: 'technical', beforeId: 'q1' })[0].question_ids, ['q4', 'q1', 'q3']);
});

// --- the preview ------------------------------------------------------------

test('a reorder refills its own category\'s slots and moves no other category', () => {
  const view = applyLocalOps(KIT, [{ type: 'reorder-questions', category: 'technical', question_ids: ['q4', 'q1', 'q3'] }]);
  assert.deepEqual(view.questions.map((entry) => entry.id), ['q4', 'q2', 'q1', 'q3']);
  assert.ok(view.questions.every((entry) => entry.origin === 'generated'), 'order is not content: nothing is marked edited');
});

test('moving a category marks a generated question edited, and leaves a manual one manual', () => {
  const view = applyLocalOps({ questions: [...QUESTIONS, question('q5', 'behavioural', { origin: 'manual' })] }, [
    { type: 'move-category', id: 'q2', category: 'technical' },
    { type: 'move-category', id: 'q5', category: 'technical' },
  ]);
  assert.equal(view.questions.find((entry) => entry.id === 'q2').origin, 'edited');
  assert.equal(view.questions.find((entry) => entry.id === 'q5').origin, 'manual');
});

test('ordering tolerates a list that has fallen behind the kit', () => {
  // q9 no longer exists and q3 is not named: skip the one, keep the other after the rest.
  const ordered = orderCategory(QUESTIONS, 'technical', ['q9', 'q4', 'q1', 'q4']);
  assert.deepEqual(ids(ordered, 'technical'), ['q4', 'q1', 'q3']);
  assert.equal(ordered.length, QUESTIONS.length);
});

// --- at the moment of sending -----------------------------------------------

test('a reorder behind a delete in the same request no longer names the deleted question', () => {
  const [, reorder] = resolveOrder(KIT, [
    { type: 'delete-question', id: 'q3' },
    { type: 'reorder-questions', category: 'technical', question_ids: ['q4', 'q3', 'q1'] },
  ]);
  assert.deepEqual(reorder.question_ids, ['q4', 'q1']);
});

test('a reorder of a category a question has just left, or joined, is rebuilt to match', () => {
  const resolved = resolveOrder(KIT, [
    // Names only two of the three technical questions.
    { type: 'reorder-questions', category: 'technical', question_ids: ['q3', 'q1'] },
    // Then q2 joins technical, and a list made before it arrived is sent after.
    { type: 'move-category', id: 'q2', category: 'technical' },
    { type: 'reorder-questions', category: 'technical', question_ids: ['q2', 'q4'] },
  ]);
  assert.deepEqual(resolved[0].question_ids, ['q3', 'q1', 'q4'], 'unnamed questions keep their order after the named ones');
  assert.deepEqual(resolved[2].question_ids, ['q2', 'q4', 'q3', 'q1']);
});

test('a reorder never goes in the same request as an add before it, and goes next with the real id', () => {
  let state = createEditState(KIT);
  state = enqueue(state, { type: 'add-question', tempId: 'pending-1', category: 'technical', prompt: 'new' });
  state = enqueue(state, { type: 'reorder-questions', category: 'technical', question_ids: ['q4', 'q1', 'q3'] });

  const first = takeBatch(state, 0);
  assert.deepEqual(first.batch.map((op) => op.type), ['add-question']);
  assert.deepEqual(first.state.queued.map((op) => op.type), ['reorder-questions']);

  // The add lands: the server's kit now has the question under a real id.
  const saved = { questions: [...QUESTIONS, question('q5', 'technical', { origin: 'manual' })] };
  const second = takeBatch(confirm(first.state, saved), 0);
  assert.deepEqual(second.batch, [
    { type: 'reorder-questions', category: 'technical', question_ids: ['q4', 'q1', 'q3', 'q5'] },
  ]);
});
