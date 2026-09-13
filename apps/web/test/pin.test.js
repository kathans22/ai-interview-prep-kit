// Pinning: drawn exactly as core pins, merged while it waits, and never sent when it
// ends up where it started.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setPinned } from '@aipk/core/contracts/provenance.js';

import { applyLocalOps, currentPinned } from '../src/kits/localOps.js';
import { createEditState, enqueue, isNoop, opKey, takeBatch, toServerOp } from '../src/kits/editQueue.js';

const KIT = Object.freeze({
  questions: [{ id: 'q1', category: 'technical', prompt: 'p', origin: 'generated', pinned: false }],
  flashcards: [{ id: 'f1', front: 'a', back: 'b', origin: 'edited', pinned: true }],
});

const pin = (id, pinned) => ({ type: 'pin', id, pinned });

test('a local pin changes exactly what core setPinned changes, on both kinds of item', () => {
  for (const [list, id, pinned] of [
    ['questions', 'q1', true],
    ['flashcards', 'f1', false],
  ]) {
    const local = applyLocalOps(KIT, [pin(id, pinned)])[list][0];
    const { updatedAt, ...fromCore } = setPinned(KIT[list][0], pinned, { updatedAt: 'stamp' });
    assert.deepEqual(local, fromCore, `${id}: the flag, and nothing else — origin included`);
  }
});

test('the kit reports a pin, and says nothing about an item it does not have', () => {
  assert.equal(currentPinned(KIT, 'q1'), false);
  assert.equal(currentPinned(KIT, 'f1'), true);
  assert.equal(currentPinned(KIT, 'q9'), undefined);
});

test('toggling while waiting merges into one pin, and a pin back where it started sends nothing', () => {
  let state = enqueue(createEditState(KIT), pin('q1', true));
  state = enqueue(state, pin('q1', false));
  assert.equal(state.queued.length, 1, 'merged by key');

  const { batch } = takeBatch(state, 0);
  assert.deepEqual(batch, [], 'q1 was unpinned and still is');
});

test('a real change of pin is sent as the route expects it', () => {
  assert.equal(isNoop(pin('q1', true), KIT), false);
  assert.equal(isNoop(pin('q9', true), KIT), false, 'an unknown item is for the server to refuse');
  assert.equal(opKey(pin('f1', false)), 'pin:f1');

  const { batch } = takeBatch(enqueue(createEditState(KIT), pin('f1', false)), 0);
  assert.deepEqual(batch.map(toServerOp), [{ type: 'pin', id: 'f1', pinned: false }]);
});
