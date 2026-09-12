/**
 * kitStatus.test.js — the five states a kit reads as.
 *
 * The assertion that matters most is that an INTERRUPTED kit and a FAILED one are
 * distinguishable. The server records both as `status: 'failed'` and separates them only
 * by an error code, so the difference is one line of derivation away from being lost —
 * and losing it tells someone whose server restarted that their job posting was the
 * problem.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERRUPTED_CODE,
  INTERRUPTED_CODES,
  KIT_VIEW,
  describeKit,
  describeResume,
  isSettled,
} from '../src/kits/kitStatus.js';

test('BOTH interrupted codes are recognised, because the server writes two', () => {
  // `INTERRUPTED` comes from mongoStore.reclaimStale, which index.js calls at boot.
  // `BUILD_INTERRUPTED` comes from the job runner's own reclaimStale, which has no
  // production call site. Matching only the latter — the one the comments describe —
  // renders every real interrupted kit as "Failed".
  assert.deepEqual([...INTERRUPTED_CODES], ['INTERRUPTED', 'BUILD_INTERRUPTED']);

  for (const code of INTERRUPTED_CODES) {
    const described = describeKit({ status: 'failed', error: { code, message: 'x' } });
    assert.equal(described.view, KIT_VIEW.interrupted, code);
    assert.equal(described.label, 'Interrupted', code);
  }
});

test('a ready kit opens', () => {
  const described = describeKit({ status: 'ready' });
  assert.equal(described.view, KIT_VIEW.ready);
  assert.equal(described.label, 'Ready');
  assert.equal(described.primary.kind, 'open');
  assert.equal(described.canResume, false);
});

test('queued and running are both busy, and both offer watching', () => {
  for (const status of ['queued', 'running']) {
    const described = describeKit({ status });
    assert.equal(described.tone, 'busy', status);
    assert.equal(described.primary.kind, 'open', status);
    assert.equal(described.primary.label, 'Watch', status);
    assert.equal(described.canResume, false, status);
  }
});

test('queued explains why nothing is happening yet', () => {
  // "Queued" with no explanation reads as stuck.
  assert.match(describeKit({ status: 'queued' }).detail, /build slot|quota/);
});

test('an INTERRUPTED kit is visibly distinct from a failed one', () => {
  const interrupted = describeKit({
    status: 'failed',
    error: { code: INTERRUPTED_CODE, message: 'The server restarted while this kit was being built.' },
  });
  const failed = describeKit({
    status: 'failed',
    error: { code: 'BUILD_NO_REQUIREMENTS', message: 'No requirements could be extracted from that posting.' },
  });

  // Different in every channel a reader has: the word, the colour, and the wording.
  assert.notEqual(interrupted.view, failed.view);
  assert.notEqual(interrupted.label, failed.label);
  assert.notEqual(interrupted.tone, failed.tone);
  assert.equal(interrupted.label, 'Interrupted');
  assert.equal(failed.label, 'Failed');
});

test('an interrupted kit says the posting was not the problem', () => {
  const described = describeKit({ status: 'failed', error: { code: INTERRUPTED_CODE, message: 'whatever' } });

  assert.match(described.detail, /Nothing is wrong with the posting/);
  assert.equal(described.canResume, true);
  assert.equal(described.primary.kind, 'resume');
  assert.equal(described.primary.label, 'Continue building');
});

test('a genuinely failed kit shows the server own sentence', () => {
  const message = 'No requirements could be extracted from that posting.';
  const described = describeKit({ status: 'failed', error: { code: 'BUILD_NO_REQUIREMENTS', message } });

  assert.equal(described.detail, message, 'the server message was written to be read');
  assert.equal(described.primary.label, 'Try again');
  assert.equal(described.canResume, true);
});

test('a failed kit with no recorded error still says something and still offers a way on', () => {
  const described = describeKit({ status: 'failed' });
  assert.ok(described.detail);
  assert.equal(described.canResume, true, 'a red badge with nothing to press is a dead end');
});

test('every state offers exactly one primary action', () => {
  for (const kit of [
    { status: 'ready' },
    { status: 'queued' },
    { status: 'running' },
    { status: 'failed', error: { code: INTERRUPTED_CODE } },
    { status: 'failed', error: { code: 'BUILD_INVALID_KIT' } },
    { status: undefined },
  ]) {
    const described = describeKit(kit);
    assert.ok(described.primary?.label, JSON.stringify(kit));
    assert.ok(['open', 'resume'].includes(described.primary.kind), JSON.stringify(kit));
  }
});

test('only ready and failed count as settled', () => {
  assert.equal(isSettled({ status: 'ready' }), true);
  assert.equal(isSettled({ status: 'failed' }), true);
  assert.equal(isSettled({ status: 'running' }), false);
  assert.equal(isSettled({ status: 'queued' }), false);
});

test('resuming says which of the two things happened', () => {
  // They cost very different fractions of a small daily quota.
  assert.match(describeResume({ resumedFrom: 'checkpoint' }), /not run again/);
  assert.match(describeResume({ resumedFrom: 'the beginning' }), /from the start/);
  assert.match(describeResume({}), /from the start/, 'an unknown answer must not claim a checkpoint');
});

test('the server own sentence wins, because it can tell three outcomes apart', () => {
  // `resumedFrom` is 'the beginning' both when there was no checkpoint and when the user
  // asked to discard one. Only the server's message distinguishes them.
  assert.equal(
    describeResume({ resumedFrom: 'the beginning', message: 'Starting again from the beginning, as asked.' }),
    'Starting again from the beginning, as asked.'
  );
  assert.match(describeResume({ resumedFrom: 'the beginning', message: '' }), /from the start/);
});
