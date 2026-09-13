/**
 * editing.test.js — optimistic editing without losing a keystroke.
 *
 * The queue is where optimistic editing goes wrong quietly: an edit sent twice, a
 * response overwriting text typed after the request left, a rollback taking a later edit
 * with it, a no-op that marks a generated item `edited` and protects it from regeneration
 * for a change nobody made. None of those crash. All of them are asserted here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { markEdited } from '@aipk/core/contracts/provenance.js';

import { applyLocalOps, currentValue } from '../src/kits/localOps.js';
import {
  cancel,
  confirm,
  createEditState,
  enqueue,
  fail,
  isNoop,
  opKey,
  pendingKeys,
  takeBatch,
  toServerOp,
  viewOf,
} from '../src/kits/editQueue.js';

const KIT = Object.freeze({
  company_brief: {
    summary: 'Acme builds routing software.',
    what_they_do: 'Dispatch.',
    sources: [],
    provenance: { summary: { origin: 'generated', pinned: false }, what_they_do: { origin: 'generated', pinned: false } },
  },
  questions: [
    { id: 'q1', category: 'technical', prompt: 'Original one', answer_outline: 'o1', origin: 'generated', pinned: false },
    { id: 'q2', category: 'technical', prompt: 'Original two', answer_outline: 'o2', origin: 'manual', pinned: true },
  ],
  flashcards: [{ id: 'f1', front: 'Front', back: 'Back', requirement_ids: ['r1'], origin: 'generated', pinned: false }],
});

const editPrompt = (id, value) => ({ type: 'edit-question', id, field: 'prompt', value });

// --- the local preview ------------------------------------------------------

test('a local edit changes the text and the badge, and never touches the kit it was given', () => {
  const view = applyLocalOps(KIT, [editPrompt('q1', 'Mine')]);

  assert.equal(view.questions[0].prompt, 'Mine');
  assert.equal(view.questions[0].origin, 'edited');
  assert.equal(KIT.questions[0].prompt, 'Original one', 'the confirmed kit is untouched');
});

test('the local provenance rule matches core markEdited for every origin', () => {
  // The client mirrors this rule for the preview. If core's rule changes, this fails
  // before a wrong badge ever reaches a screen.
  for (const origin of ['generated', 'edited', 'manual']) {
    const item = { id: 'q1', category: 'technical', prompt: 'x', answer_outline: 'y', origin, pinned: false };
    const kit = { questions: [item] };
    const local = applyLocalOps(kit, [editPrompt('q1', 'changed')]).questions[0].origin;
    assert.equal(local, markEdited(item).origin, `origin ${origin}`);
  }
});

test('flashcard faces and brief fields preview the same way', () => {
  const view = applyLocalOps(KIT, [
    { type: 'edit-flashcard', id: 'f1', field: 'back', value: 'New back' },
    { type: 'edit-brief', field: 'summary', value: 'New summary' },
  ]);

  assert.equal(view.flashcards[0].back, 'New back');
  assert.equal(view.flashcards[0].origin, 'edited');
  assert.equal(view.company_brief.summary, 'New summary');
  assert.equal(view.company_brief.provenance.summary.origin, 'edited');
  assert.equal(view.company_brief.provenance.what_they_do.origin, 'generated', 'only the edited field is marked');
});

test('with nothing pending, the very same kit object comes back', () => {
  assert.equal(applyLocalOps(KIT, []), KIT);
});

test('an edit to an item that no longer exists draws nothing and is left for the server to refuse', () => {
  const view = applyLocalOps(KIT, [editPrompt('q99', 'ghost')]);
  assert.equal(view.questions.length, 2);
  assert.equal(currentValue(KIT, editPrompt('q99', 'x')), undefined);
});

// --- merging while waiting --------------------------------------------------

test('keystrokes to the same field merge into ONE operation carrying the last text', () => {
  let state = createEditState(KIT);
  for (const value of ['O', 'Or', 'Ori', 'Orig']) state = enqueue(state, editPrompt('q1', value));

  assert.equal(state.queued.length, 1, 'typing never becomes a request per keystroke');
  assert.equal(state.queued[0].value, 'Orig');
});

test('edits to different fields stay separate and keep their order', () => {
  let state = createEditState(KIT);
  state = enqueue(state, editPrompt('q1', 'a'));
  state = enqueue(state, { type: 'edit-question', id: 'q1', field: 'answer_outline', value: 'b' });
  state = enqueue(state, editPrompt('q2', 'c'));
  state = enqueue(state, editPrompt('q1', 'a2'));

  assert.deepEqual(
    state.queued.map((op) => `${op.id}.${op.field}=${op.value}`),
    ['q1.prompt=a2', 'q1.answer_outline=b', 'q2.prompt=c'],
    'a later edit replaces the earlier one IN PLACE'
  );
});

// --- sending ----------------------------------------------------------------

test('a no-op is dropped before sending, compared trimmed', () => {
  // Sending it would still mark a generated item edited, protecting it from regeneration
  // for a change nobody made.
  assert.equal(isNoop(editPrompt('q1', 'Original one  '), KIT), true);
  assert.equal(isNoop(editPrompt('q1', 'Original one!'), KIT), false);

  let state = createEditState(KIT);
  state = enqueue(state, editPrompt('q1', ' Original one '));
  const { batch } = takeBatch(state);
  assert.equal(batch.length, 0);
});

test('only one request is on the wire at a time', () => {
  let state = createEditState(KIT);
  state = enqueue(state, editPrompt('q1', 'first'));
  const first = takeBatch(state);
  assert.equal(first.batch.length, 1);

  state = enqueue(first.state, editPrompt('q2', 'second'));
  const second = takeBatch(state);
  assert.equal(second.batch.length, 0, 'a second request would carry a revision the first is about to invalidate');
  assert.equal(second.state.queued.length, 1, 'and the waiting edit is kept for next time');
});

test('typing after a request leaves survives that request confirming', () => {
  let state = enqueue(createEditState(KIT), editPrompt('q1', 'sent text'));
  ({ state } = takeBatch(state));

  // The person keeps typing while the request is out.
  state = enqueue(state, editPrompt('q1', 'sent text, and more'));

  // The server confirms the OLDER text.
  const serverKit = applyLocalOps(KIT, [editPrompt('q1', 'sent text')]);
  state = confirm(state, serverKit);

  assert.equal(viewOf(state).questions[0].prompt, 'sent text, and more', 'the response must not overwrite newer typing');
  assert.equal(state.queued.length, 1, 'and the newer text is still waiting to be sent');
});

test('a failed request rolls back what was on the wire, and nothing typed after it', () => {
  let state = enqueue(createEditState(KIT), editPrompt('q1', 'will fail'));
  ({ state } = takeBatch(state));
  state = enqueue(state, { type: 'edit-flashcard', id: 'f1', field: 'front', value: 'typed during' });

  state = fail(state);

  const view = viewOf(state);
  assert.equal(view.questions[0].prompt, 'Original one', 'the failed edit is rolled back');
  assert.equal(view.flashcards[0].front, 'typed during', 'the later edit is not');
  assert.equal(state.inflight.length, 0);
});

test('cancelling a field that was never sent drops it with no request', () => {
  let state = enqueue(createEditState(KIT), editPrompt('q1', 'changed my mind'));
  state = cancel(state, opKey(editPrompt('q1', '')));

  assert.equal(state.queued.length, 0);
  assert.equal(viewOf(state).questions[0].prompt, 'Original one');
});

test('pending keys say which fields are saving and which are waiting', () => {
  let state = enqueue(createEditState(KIT), editPrompt('q1', 'a'));
  ({ state } = takeBatch(state));
  state = enqueue(state, editPrompt('q2', 'b'));

  const keys = pendingKeys(state);
  assert.equal(keys.saving.has(opKey(editPrompt('q1', ''))), true);
  assert.equal(keys.queued.has(opKey(editPrompt('q2', ''))), true);
});

// --- adding by hand ---------------------------------------------------------

const addQuestion = {
  type: 'add-question',
  tempId: 'pending-1',
  category: 'behavioural',
  prompt: 'Tell me about a disagreement.',
  answer_outline: 'Evidence, outcome.',
  difficulty: 3,
  requirement_ids: ['r6'],
};

test('an added question is drawn at once, marked manual and pending, and the kit is untouched', () => {
  const view = applyLocalOps(KIT, [addQuestion]);
  const added = view.questions.at(-1);

  assert.equal(view.questions.length, 3);
  assert.equal(added.id, 'pending-1');
  assert.equal(added.origin, 'manual', 'the brief requires hand-added items to be manual');
  assert.equal(added.pendingAdd, true, 'read-only until the server gives it a real id');
  assert.equal(KIT.questions.length, 2);
});

test('an added flashcard is drawn the same way', () => {
  const view = applyLocalOps(KIT, [
    { type: 'add-flashcard', tempId: 'pending-2', front: 'Q', back: 'A', requirement_ids: [] },
  ]);
  const added = view.flashcards.at(-1);
  assert.equal(added.origin, 'manual');
  assert.equal(added.pendingAdd, true);
});

test('the preview never duplicates an add, however often it is recomputed', () => {
  const view = applyLocalOps(KIT, [addQuestion, addQuestion]);
  assert.equal(view.questions.filter((q) => q.id === 'pending-1').length, 1);
});

test('an add is never mistaken for a no-op, and its temporary id never reaches the server', () => {
  assert.equal(isNoop(addQuestion, KIT), false);

  const serverOp = toServerOp(addQuestion);
  assert.equal('tempId' in serverOp, false);
  assert.deepEqual(Object.keys(serverOp).sort(), ['answer_outline', 'category', 'difficulty', 'prompt', 'requirement_ids', 'type']);
});

test('a failed add rolls back its pending row', () => {
  let state = enqueue(createEditState(KIT), addQuestion);
  ({ state } = takeBatch(state));
  assert.equal(viewOf(state).questions.length, 3);

  state = fail(state);
  assert.equal(viewOf(state).questions.length, 2);
});

test('operations are translated into exactly what the edit route accepts', () => {
  assert.deepEqual(toServerOp(editPrompt('q1', 'x')), { type: 'edit-question', id: 'q1', prompt: 'x' });
  assert.deepEqual(toServerOp({ type: 'edit-flashcard', id: 'f1', field: 'back', value: 'y' }), {
    type: 'edit-flashcard',
    id: 'f1',
    back: 'y',
  });
  assert.deepEqual(toServerOp({ type: 'edit-brief', field: 'what_they_do', value: 'z' }), {
    type: 'edit-brief',
    what_they_do: 'z',
  });
});
