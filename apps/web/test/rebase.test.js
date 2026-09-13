// A stale revision: someone else saved first. The person's unconfirmed work goes back on
// top of the kit the 409 carried, and nothing they did is lost or sent twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createEditState,
  describeRebase,
  enqueue,
  rebase,
  takeBatch,
  viewOf,
} from '../src/kits/editQueue.js';

const question = (id, prompt, extra = {}) => ({ id, category: 'technical', prompt, origin: 'generated', pinned: false, ...extra });
const kitOf = (...questions) => ({ questions, flashcards: [{ id: 'f1', front: 'a', back: 'b', origin: 'generated', pinned: false }] });
const editPrompt = (id, value) => ({ type: 'edit-question', id, field: 'prompt', value });

const MINE = kitOf(question('q1', 'one'), question('q2', 'two'), question('q3', 'three'));
// What the server holds after another tab edited q2 and deleted q3.
const THEIRS = kitOf(question('q1', 'one'), question('q2', 'CHANGED ELSEWHERE'));

/** A state with one request on the wire and more typed since. */
function midFlight(...laterOps) {
  let state = enqueue(createEditState(MINE), editPrompt('q1', 'my text'));
  state = takeBatch(state, 0).state;
  for (const op of laterOps) state = enqueue(state, op);
  return state;
}

test('the kit the 409 carried becomes the base, and what was on the wire goes back in front', () => {
  const { state, dropped } = rebase(midFlight({ type: 'pin', id: 'q2', pinned: true }), THEIRS);

  assert.equal(state.base, THEIRS);
  assert.deepEqual(state.inflight, []);
  assert.deepEqual(state.queued.map((op) => op.type), ['edit-question', 'pin'], 'in the order they were made');
  assert.deepEqual(dropped, []);
});

test('the screen shows their change and this person\'s text together, with no reload', () => {
  const { state } = rebase(midFlight(), THEIRS);
  const view = viewOf(state);
  assert.equal(view.questions.find((q) => q.id === 'q1').prompt, 'my text');
  assert.equal(view.questions.find((q) => q.id === 'q2').prompt, 'CHANGED ELSEWHERE');
});

test('typing that continued while the conflicted request was out is the text that is resent', () => {
  const { state } = rebase(midFlight(editPrompt('q1', 'my text, and more')), THEIRS);
  assert.deepEqual(state.queued, [editPrompt('q1', 'my text, and more')], 'one operation, the newest text');
});

test('on the same field, this person\'s text wins over the other writer\'s', () => {
  const theirsOnQ1 = kitOf(question('q1', 'THEIRS'), question('q2', 'two'), question('q3', 'three'));
  const { state } = rebase(midFlight(), theirsOnQ1);
  const { batch } = takeBatch(state, 0);
  assert.deepEqual(batch, [editPrompt('q1', 'my text')]);
});

test('work aimed at something the other writer deleted is dropped and reported, not sent to fail', () => {
  const { state, dropped } = rebase(
    midFlight(
      editPrompt('q3', 'edit to a deleted question'),
      { type: 'pin', id: 'q3', pinned: true },
      { type: 'delete-question', id: 'q3', holdUntil: 99 },
      { type: 'reorder-questions', category: 'technical', question_ids: ['q3', 'q1', 'q2'] },
      { type: 'add-question', tempId: 'pending-1', category: 'technical', prompt: 'new' },
      { type: 'edit-brief', field: 'summary', value: 'brief' },
      { type: 'delete-flashcard', id: 'f1', holdUntil: 5 }
    ),
    THEIRS
  );

  assert.deepEqual(dropped.map((op) => `${op.type}:${op.id}`), ['edit-question:q3', 'pin:q3', 'delete-question:q3']);
  assert.deepEqual(
    state.queued.map((op) => op.type),
    ['edit-question', 'reorder-questions', 'add-question', 'edit-brief', 'delete-flashcard'],
    'adds, brief edits and reorders are never dropped'
  );
  assert.equal(state.queued.at(-1).holdUntil, 5, 'a held delete keeps its undo window');

  // And the reorder that named the deleted question is repaired when it is sent.
  const { batch } = takeBatch(state, 10);
  assert.deepEqual(batch.find((op) => op.type === 'reorder-questions').question_ids, ['q1', 'q2']);
});

test('a change the other writer already made is not sent again', () => {
  const alreadyThere = kitOf(question('q1', 'my text'), question('q2', 'two'));
  const { state } = rebase(midFlight(), alreadyThere);
  assert.deepEqual(takeBatch(state, 0).batch, []);
});

test('the notice says what happened, and names anything that could not be reapplied', () => {
  assert.equal(
    describeRebase([]),
    'This kit was changed somewhere else, so your changes were reapplied on top of the latest version.'
  );
  assert.match(describeRebase([editPrompt('q3', 'x'), { type: 'pin', id: 'q3' }]), /Your change to q3 was not, because it was deleted there\.$/);
  assert.match(
    describeRebase([editPrompt('q3', 'x'), { type: 'delete-flashcard', id: 'f2' }]),
    /Your changes to q3 and f2 were not, because they were deleted there\.$/
  );
});
