/**
 * revisions.test.js — optimistic concurrency, without a database.
 *
 * Decides: that a stale write is refused with a structured conflict, that a fresh one
 * lands, and that the check and the write are a single operation.
 *
 * Does NOT decide: anything about Mongo's own behaviour. The fake model below implements
 * `findOneAndUpdate` with the same contract the real one has — match the filter, apply
 * the update, return the new document, or return null when nothing matched. That is the
 * property `writeWithRevision` depends on; a test needing a live database to assert it
 * would be a test nobody runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  writeWithRevision,
  writeUnchecked,
  StaleRevisionError,
  isStaleRevision,
  STALE_REVISION,
} from '../src/models/revisions.js';

/**
 * A stand-in for the Kit model.
 *
 * `findOneAndUpdate` honours the filter exactly as Mongo does, including the revision,
 * so a stale write finds no document — which is what makes the compare-and-set atomic
 * rather than a read followed by a hopeful write.
 */
function fakeModel(initial = {}) {
  const docs = new Map();
  for (const [id, doc] of Object.entries(initial)) docs.set(id, { _id: id, ...doc });

  let onBeforeWrite = null;

  return {
    /** Let a test simulate another writer landing between a read and a write. */
    interleave(fn) {
      onBeforeWrite = fn;
    },

    async findOneAndUpdate(filter, update) {
      if (onBeforeWrite) {
        const fn = onBeforeWrite;
        onBeforeWrite = null;
        await fn(docs);
      }

      const doc = docs.get(String(filter._id));
      if (!doc) return null;
      if (filter.revision !== undefined && doc.revision !== filter.revision) return null;

      Object.assign(doc, update.$set ?? {});
      for (const [key, amount] of Object.entries(update.$inc ?? {})) {
        doc[key] = (doc[key] ?? 0) + amount;
      }
      for (const [key, value] of Object.entries(update.$push ?? {})) {
        doc[key] = [...(doc[key] ?? []), value];
      }
      return { ...doc };
    },

    async findByIdAndUpdate(id, update) {
      return this.findOneAndUpdate({ _id: id }, update);
    },

    findById(id) {
      const doc = docs.get(String(id));
      return {
        select() {
          return this;
        },
        async lean() {
          return doc ? { ...doc } : null;
        },
      };
    },

    peek: (id) => docs.get(String(id)),
  };
}

const NOW = () => new Date('2026-09-11T12:00:00.000Z');

// ===========================================================================
// EXIT CHECK — a stale write is rejected with a structured conflict
// ===========================================================================

test('EXIT CHECK: a stale write is rejected with a structured conflict', async () => {
  const model = fakeModel({ k1: { revision: 5, kit: { questions: [] } } });

  await assert.rejects(
    writeWithRevision({
      model,
      kitId: 'k1',
      expectedRevision: 4, // the client last saw 4; a regeneration has since written 5
      set: { kit: { questions: ['my edit'] } },
      now: NOW,
    }),
    (error) => {
      assert.ok(error instanceof StaleRevisionError);
      assert.equal(error.code, STALE_REVISION);
      assert.equal(error.currentRevision, 5);
      assert.equal(error.expectedRevision, 4);
      return true;
    }
  );

  // The kit was not touched.
  assert.equal(model.peek('k1').revision, 5);
  assert.deepEqual(model.peek('k1').kit, { questions: [] }, 'a refused write must change nothing');
});

test('the conflict body carries what a client needs to recover', async () => {
  const model = fakeModel({ k1: { revision: 9 } });

  const error = await writeWithRevision({ model, kitId: 'k1', expectedRevision: 2, set: {}, now: NOW }).catch((e) => e);
  const body = error.toResponse();

  assert.deepEqual(body, {
    code: 'STALE_REVISION',
    message: body.message,
    currentRevision: 9,
    expectedRevision: 2,
  });
  assert.match(body.message, /re-read the kit/i);
  assert.equal(isStaleRevision(error), true);
});

// ===========================================================================
// The happy path, and the counter
// ===========================================================================

test('a write at the current revision lands and bumps the counter', async () => {
  const model = fakeModel({ k1: { revision: 3, kit: null } });

  const updated = await writeWithRevision({
    model,
    kitId: 'k1',
    expectedRevision: 3,
    set: { kit: { questions: ['a'] }, status: 'ready' },
    now: NOW,
  });

  assert.equal(updated.revision, 4, 'every write bumps the revision');
  assert.equal(updated.status, 'ready');
  assert.deepEqual(updated.updatedAt, NOW(), 'and updatedAt moves with it');
});

test('two writes from the same stale view: the first wins, the second is refused', async () => {
  const model = fakeModel({ k1: { revision: 1, kit: { note: 'original' } } });

  const first = await writeWithRevision({ model, kitId: 'k1', expectedRevision: 1, set: { kit: { note: 'first' } }, now: NOW });
  assert.equal(first.revision, 2);

  // The second client also read revision 1 and is now out of date.
  await assert.rejects(
    writeWithRevision({ model, kitId: 'k1', expectedRevision: 1, set: { kit: { note: 'second' } }, now: NOW }),
    (error) => error.currentRevision === 2
  );

  assert.deepEqual(model.peek('k1').kit, { note: 'first' }, 'the loser must not overwrite the winner');
});

test('a writer that lands between the read and the write still loses', async () => {
  const model = fakeModel({ k1: { revision: 7, kit: { note: 'original' } } });

  // A background regeneration lands the instant before our update is applied. Because
  // the revision is part of the FILTER, the database refuses it rather than our code
  // noticing afterwards.
  model.interleave((docs) => {
    const doc = docs.get('k1');
    doc.revision = 8;
    doc.kit = { note: 'regenerated' };
  });

  await assert.rejects(
    writeWithRevision({ model, kitId: 'k1', expectedRevision: 7, set: { kit: { note: 'my edit' } }, now: NOW }),
    (error) => {
      assert.equal(error.code, STALE_REVISION);
      assert.equal(error.currentRevision, 8);
      return true;
    }
  );

  assert.deepEqual(model.peek('k1').kit, { note: 'regenerated' });
});

test('a missing kit is a different failure from a stale one', async () => {
  const model = fakeModel({});

  await assert.rejects(
    writeWithRevision({ model, kitId: 'nope', expectedRevision: 1, set: {}, now: NOW }),
    (error) => {
      assert.equal(error.code, 'KIT_NOT_FOUND');
      assert.equal(isStaleRevision(error), false, 'a client should not retry a kit that does not exist');
      return true;
    }
  );
});

test('a write with no usable revision is refused before it reaches the database', async () => {
  const model = fakeModel({ k1: { revision: 1 } });

  for (const bad of [undefined, null, -1, 1.5, '1']) {
    await assert.rejects(
      writeWithRevision({ model, kitId: 'k1', expectedRevision: bad, set: {}, now: NOW }),
      TypeError,
      `expectedRevision=${JSON.stringify(bad)} should be refused`
    );
  }
  assert.equal(model.peek('k1').revision, 1, 'and nothing was written');
});

test('progress events append without replacing the array', async () => {
  const model = fakeModel({ k1: { revision: 1, progress: [{ step: 'requirements', status: 'done' }] } });

  const updated = await writeWithRevision({
    model,
    kitId: 'k1',
    expectedRevision: 1,
    set: { status: 'running' },
    push: { progress: { step: 'crawl', status: 'started' } },
    now: NOW,
  });

  assert.equal(updated.progress.length, 2);
  assert.equal(updated.progress[1].step, 'crawl');
});

// ===========================================================================
// Pipeline writes
// ===========================================================================

test('an unchecked pipeline write still bumps the revision', async () => {
  const model = fakeModel({ k1: { revision: 2 } });

  // A build reporting its own progress has no "revision the author last saw" — the
  // author is the build. It still moves the counter, so a client editing mid-build is
  // correctly told its view is stale.
  const updated = await writeUnchecked({
    model,
    kitId: 'k1',
    set: { status: 'running' },
    push: { progress: { step: 'crawl', status: 'done' } },
    now: NOW,
  });

  assert.equal(updated.revision, 3);

  await assert.rejects(
    writeWithRevision({ model, kitId: 'k1', expectedRevision: 2, set: {}, now: NOW }),
    (error) => error.currentRevision === 3
  );
});

test('an unchecked write to a missing kit returns null rather than throwing', async () => {
  const model = fakeModel({});
  assert.equal(await writeUnchecked({ model, kitId: 'gone', set: { status: 'failed' }, now: NOW }), null);
});
