/**
 * ids.test.js — tests for stable id generation.
 *
 * Decides: that ids continue from the highest existing number, never reuse a gap, and
 * never renumber what already exists.
 *
 * Does NOT decide: reference integrity between ids — that belongs to validateKit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseId,
  isValidId,
  nextId,
  nextIds,
  collectIds,
  nextIdFor,
} from '../contracts/ids.js';

test('parseId splits a well-formed id and rejects a malformed one', () => {
  assert.deepEqual(parseId('r12'), { prefix: 'r', number: 12 });
  assert.deepEqual(parseId('q1'), { prefix: 'q', number: 1 });

  for (const bad of ['r0', 'r01', 'r', '1', 'r-1', 'R1', '', null, undefined, 7, 'r1.5']) {
    assert.equal(parseId(bad), null, `${String(bad)} should not parse`);
  }
});

test('isValidId can be scoped to one prefix', () => {
  assert.equal(isValidId('q3'), true);
  assert.equal(isValidId('q3', 'q'), true);
  assert.equal(isValidId('q3', 'r'), false);
});

test('nextId starts at 1 and continues from the highest existing number', () => {
  assert.equal(nextId('r', []), 'r1');
  assert.equal(nextId('r', ['r1', 'r2']), 'r3');
  assert.equal(nextId('f', ['f9', 'f10']), 'f11', 'must compare numerically, not as strings');
});

test('nextId ignores other prefixes entirely', () => {
  assert.equal(nextId('q', ['r7', 'f4', 'q2']), 'q3');
  assert.equal(nextId('q', ['r7', 'f4']), 'q1');
});

test('nextId never reuses a gap left by a removed item', () => {
  // r2 was removed. Reusing it would silently repoint every reference to the old r2.
  assert.equal(nextId('r', ['r1', 'r3']), 'r4');
});

test('nextId tolerates malformed entries without renumbering', () => {
  assert.equal(nextId('r', ['r1', 'nonsense', '', null, undefined, 'r5']), 'r6');
});

test('nextId rejects an empty prefix with a coded error', () => {
  assert.throws(() => nextId('', ['r1']), /IDS_INVALID_PREFIX/);
});

test('nextIds returns a consecutive run and does not mutate the input', () => {
  const existing = ['q1'];
  assert.deepEqual(nextIds('q', 3, existing), ['q2', 'q3', 'q4']);
  assert.deepEqual(existing, ['q1'], 'the caller\'s array must be untouched');
  assert.deepEqual(nextIds('q', 0, existing), []);
});

test('nextIds rejects a non-integer count', () => {
  assert.throws(() => nextIds('q', 2.5), /IDS_INVALID_COUNT/);
  assert.throws(() => nextIds('q', -1), /IDS_INVALID_COUNT/);
});

test('collectIds gathers usable ids and skips the rest', () => {
  assert.deepEqual(collectIds([{ id: 'r1' }, {}, { id: '' }, null, { id: 'r2' }]), ['r1', 'r2']);
  assert.deepEqual(collectIds('not an array'), []);
});

test('nextIdFor uses the prefix registered in kitSchema', () => {
  assert.equal(nextIdFor('requirement', [{ id: 'r1' }, { id: 'r2' }]), 'r3');
  assert.equal(nextIdFor('question', []), 'q1');
  assert.equal(nextIdFor('flashcard', [{ id: 'f4' }]), 'f5');
  assert.throws(() => nextIdFor('widget', []), /IDS_UNKNOWN_COLLECTION/);
});

test('ids assigned across two passes never renumber the first pass', () => {
  const firstPass = nextIds('r', 3, []);
  const secondPass = nextIds('r', 2, firstPass);

  assert.deepEqual(firstPass, ['r1', 'r2', 'r3']);
  assert.deepEqual(secondPass, ['r4', 'r5']);
  assert.equal(new Set([...firstPass, ...secondPass]).size, 5, 'ids must be unique');
});
