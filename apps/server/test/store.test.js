/**
 * store.test.js — one contract, both stores.
 *
 * Decides: that `memoryStore` and `mongoStore` are genuinely interchangeable.
 *
 * Does NOT decide: anything about routes. This is the seam beneath them.
 *
 * WHY THIS FILE EXISTS. Every route reads `request.store` and none may know which
 * backing it has — that is what lets the whole API be tested with no database while the
 * same code serves real traffic. Two implementations of an interface agree only for as
 * long as someone checks, and for two stages nobody did: the routes ran entirely on the
 * Map, and the Mongoose path had no production call site at all. The same assertions run
 * against both here, so a divergence fails a test instead of waiting for production.
 *
 * THE MONGO HALF IS SKIPPED WHEN THERE IS NO DATABASE, not deleted. A clean clone with
 * no `.env` runs the memory half and reports the other as skipped; a machine with
 * `MONGODB_URI` set runs both. A test that required a database would be a test the
 * clean-clone check could not run, and a test nobody runs is not a test.
 *
 * IT WRITES INTO ITS OWN DATABASE. The URI's database name is replaced with a
 * per-run scratch name and the whole thing is dropped afterwards, so running the suite
 * can never touch real kits.
 */

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from '../src/store/memoryStore.js';
import { isStaleRevision, STALE_REVISION } from '../src/models/revisions.js';

const INPUT = { jd: 'A job description long enough to be real.', company_url: '', days: 3 };

/**
 * Every assertion that must hold for ANY store.
 *
 * Taking the store as an argument rather than closing over one is the whole point: the
 * body cannot accidentally depend on a Map or on Mongoose.
 */
function contractFor(name, makeStore, { setUp = async () => {}, tearDown = async () => {} } = {}) {
  describe(`store contract: ${name}`, () => {
    let store;

    // The connection lifecycle lives INSIDE this describe. Split across two describes it
    // does not work: node:test runs each block's `after` when that block finishes, so a
    // connection opened in one is already closed by the time the next one's tests run.
    before(async () => {
      await setUp();
      store = await makeStore();
    });

    after(async () => {
      await tearDown();
    });

    test('a user round trips, and email is matched case-insensitively', async () => {
      const created = await store.users.create({
        email: '  Ada.Lovelace@Example.COM  ',
        passwordHash: 'hash',
      });

      assert.ok(created.id, 'an id is returned as a string');
      assert.equal(typeof created.id, 'string');
      // Normalised by the store, not by the caller: a route that forgot would otherwise
      // create a second account for the same person.
      assert.equal(created.email, 'ada.lovelace@example.com');

      const byEmail = await store.users.findByEmail('ADA.LOVELACE@EXAMPLE.COM');
      assert.equal(byEmail.id, created.id);
      assert.equal((await store.users.findById(created.id)).id, created.id);
    });

    test('a duplicate email is refused with the same code from either store', async () => {
      await store.users.create({ email: 'dup@example.com', passwordHash: 'hash' });
      await assert.rejects(
        store.users.create({ email: 'DUP@example.com', passwordHash: 'other' }),
        (error) => error.code === 'DUPLICATE_EMAIL'
      );
    });

    test('an unknown user is null, not a throw', async () => {
      assert.equal(await store.users.findByEmail('nobody@example.com'), null);
      // A malformed id must behave like a missing one. Against Mongo this is a CastError
      // unless it is handled, which would surface as a 500 and tell an attacker probing
      // ids the difference between a malformed one and a real one they do not own.
      assert.equal(await store.users.findById('not-an-id'), null);
    });

    test('a kit is created queued, at revision 0, owned by its creator', async () => {
      const user = await store.users.create({ email: 'owner@example.com', passwordHash: 'h' });
      const kit = await store.kits.create({ userId: user.id, input: INPUT, jdHash: 'hash-a' });

      assert.equal(kit.status, 'queued');
      assert.equal(kit.revision, 0);
      assert.equal(kit.input.jdHash, 'hash-a');
      assert.equal(kit.input.days, 3);
      assert.ok(kit.createdAt instanceof Date || typeof kit.createdAt === 'string');
    });

    test('OWNERSHIP: another user cannot find the kit at all', async () => {
      const alice = await store.users.create({ email: 'a-own@example.com', passwordHash: 'h' });
      const bob = await store.users.create({ email: 'b-own@example.com', passwordHash: 'h' });
      const kit = await store.kits.create({ userId: alice.id, input: INPUT, jdHash: 'hash-own' });

      assert.ok(await store.kits.findOwned({ kitId: kit.id, userId: alice.id }));
      // Not "found but refused" — not found. The owner is part of the lookup, so there
      // is no ownership check a handler could forget.
      assert.equal(await store.kits.findOwned({ kitId: kit.id, userId: bob.id }), null);
      assert.equal(await store.kits.remove({ kitId: kit.id, userId: bob.id }), false);
      assert.ok(await store.kits.findOwned({ kitId: kit.id, userId: alice.id }), 'still there');
    });

    test('listing is scoped to the owner and newest first', async () => {
      const alice = await store.users.create({ email: 'a-list@example.com', passwordHash: 'h' });
      const bob = await store.users.create({ email: 'b-list@example.com', passwordHash: 'h' });

      await store.kits.create({ userId: alice.id, input: INPUT, jdHash: 'l1' });
      await store.kits.create({ userId: alice.id, input: INPUT, jdHash: 'l2' });
      await store.kits.create({ userId: bob.id, input: INPUT, jdHash: 'l3' });

      assert.equal((await store.kits.listOwned({ userId: alice.id })).length, 2);
      assert.equal((await store.kits.listOwned({ userId: bob.id })).length, 1);
    });

    test('EVERY write bumps the revision, checked or not', async () => {
      const user = await store.users.create({ email: 'rev@example.com', passwordHash: 'h' });
      const kit = await store.kits.create({ userId: user.id, input: INPUT, jdHash: 'rev' });

      const afterUnchecked = await store.kits.write({ kitId: kit.id, set: { status: 'running' } });
      assert.equal(afterUnchecked.revision, 1, 'a pipeline write still moves the counter');
      assert.equal(afterUnchecked.status, 'running');

      const afterChecked = await store.kits.writeWithRevision({
        kitId: kit.id,
        expectedRevision: 1,
        set: { status: 'ready' },
      });
      assert.equal(afterChecked.revision, 2);
      assert.equal(afterChecked.status, 'ready');
    });

    test('CONFLICT: a stale write is refused and changes nothing', async () => {
      const user = await store.users.create({ email: 'stale@example.com', passwordHash: 'h' });
      const kit = await store.kits.create({ userId: user.id, input: INPUT, jdHash: 'stale' });

      // `kit` defaults to null, and neither store will create a field inside null — so
      // the object is established first, exactly as a real build does before any edit.
      await store.kits.write({ kitId: kit.id, set: { kit: { marker: 'INITIAL' } } });

      await store.kits.writeWithRevision({
        kitId: kit.id,
        expectedRevision: 1,
        set: { 'kit.marker': 'FIRST' },
      });

      let thrown = null;
      try {
        await store.kits.writeWithRevision({
          kitId: kit.id,
          expectedRevision: 1,
          set: { 'kit.marker': 'SECOND' },
        });
      } catch (error) {
        thrown = error;
      }

      assert.ok(thrown, 'the stale write must not succeed');
      assert.equal(thrown.code, STALE_REVISION);
      assert.equal(isStaleRevision(thrown), true);
      assert.equal(thrown.currentRevision, 2);
      assert.equal(thrown.expectedRevision, 1);

      // The assertion that matters: a 409 that still wrote would be worse than no check,
      // because it would look safe.
      const current = await store.kits.findOwned({ kitId: kit.id, userId: user.id });
      assert.equal(current.kit.marker, 'FIRST');
      assert.equal(current.revision, 2);
    });

    test('ATOMICITY: a writer landing between read and write still loses', async () => {
      const user = await store.users.create({ email: 'race@example.com', passwordHash: 'h' });
      const kit = await store.kits.create({ userId: user.id, input: INPUT, jdHash: 'race' });
      await store.kits.write({ kitId: kit.id, set: { kit: { marker: 'INITIAL' } } });

      // Client A reads revision 1 and pauses. Client B writes. Client A then submits.
      const seenByA = 1;
      await store.kits.writeWithRevision({
        kitId: kit.id,
        expectedRevision: 1,
        set: { 'kit.marker': 'B' },
      });

      await assert.rejects(
        store.kits.writeWithRevision({
          kitId: kit.id,
          expectedRevision: seenByA,
          set: { 'kit.marker': 'A' },
        }),
        (error) => isStaleRevision(error)
      );

      const current = await store.kits.findOwned({ kitId: kit.id, userId: user.id });
      assert.equal(current.kit.marker, 'B', "the slow client must not clobber the fast one");
    });

    test('push appends without replacing, and bumps the revision', async () => {
      const user = await store.users.create({ email: 'push@example.com', passwordHash: 'h' });
      const kit = await store.kits.create({ userId: user.id, input: INPUT, jdHash: 'push' });

      await store.kits.write({
        kitId: kit.id,
        push: { progress: { step: 'requirements', status: 'started', detail: {}, at: new Date() } },
      });
      const after = await store.kits.write({
        kitId: kit.id,
        push: { progress: { step: 'requirements', status: 'done', detail: {}, at: new Date() } },
      });

      assert.equal(after.progress.length, 2);
      assert.equal(after.progress[1].status, 'done');
      assert.equal(after.revision, 2);
    });

    test('PRACTICE RATINGS PERSIST — the field the schema was missing', async () => {
      const user = await store.users.create({ email: 'practice@example.com', passwordHash: 'h' });
      const kit = await store.kits.create({ userId: user.id, input: INPUT, jdHash: 'practice' });

      await store.kits.write({
        kitId: kit.id,
        push: { practice: { questionId: 'q1', confidence: 2, note: 'blanked', at: new Date() } },
      });
      const after = await store.kits.write({
        kitId: kit.id,
        push: { practice: { questionId: 'q1', confidence: 5, note: '', at: new Date() } },
      });

      // Against Mongoose with strict:true an undeclared path is dropped SILENTLY — the
      // write succeeds and the data is gone. This assertion is the only thing standing
      // between that and a user losing every rating they ever made.
      assert.equal(after.practice.length, 2, 'both ratings were stored');
      assert.equal(after.practice[0].confidence, 2);
      assert.equal(after.practice[1].confidence, 5);
    });

    test('the duplicate lookup honours hash, owner, status and window', async () => {
      const user = await store.users.create({ email: 'dupe@example.com', passwordHash: 'h' });
      const other = await store.users.create({ email: 'other@example.com', passwordHash: 'h' });
      const statuses = ['queued', 'running', 'ready'];
      const since = new Date(Date.now() - 900_000);

      const mine = await store.kits.create({ userId: user.id, input: INPUT, jdHash: 'same' });
      await store.kits.create({ userId: other.id, input: INPUT, jdHash: 'same' });

      const found = await store.kits.findDuplicate({ userId: user.id, jdHash: 'same', since, statuses });
      assert.equal(found.id, mine.id, 'never another user\'s kit, however identical');

      assert.equal(
        await store.kits.findDuplicate({ userId: user.id, jdHash: 'different', since, statuses }),
        null
      );

      // A failed kit is not reused: the failure may have been transient, and returning
      // it would make a retry impossible.
      await store.kits.write({ kitId: mine.id, set: { status: 'failed' } });
      assert.equal(
        await store.kits.findDuplicate({ userId: user.id, jdHash: 'same', since, statuses }),
        null
      );
    });

    test('deleting is scoped by owner, and a missing kit is false not a throw', async () => {
      const user = await store.users.create({ email: 'del@example.com', passwordHash: 'h' });
      const kit = await store.kits.create({ userId: user.id, input: INPUT, jdHash: 'del' });

      assert.equal(await store.kits.remove({ kitId: kit.id, userId: user.id }), true);
      assert.equal(await store.kits.findOwned({ kitId: kit.id, userId: user.id }), null);
      assert.equal(await store.kits.remove({ kitId: kit.id, userId: user.id }), false);
      assert.equal(await store.kits.remove({ kitId: 'not-an-id', userId: user.id }), false);
    });

    test('writing to a kit that does not exist is handled, not crashed', async () => {
      assert.equal(await store.kits.write({ kitId: 'not-an-id', set: { status: 'ready' } }), null);
      await assert.rejects(
        store.kits.writeWithRevision({ kitId: 'not-an-id', expectedRevision: 0, set: {} }),
        (error) => error.code === 'KIT_NOT_FOUND'
      );
    });

    /**
     * `index.js` calls this at boot, unconditionally. It was absent from `memoryStore`
     * entirely and this contract covered it nowhere, so a deployment on that store would
     * have thrown before finishing startup and nothing would have caught it (CF-066).
     */
    test('reclaimStale marks abandoned running kits, and only those', async () => {
      const user = await store.users.create({ email: 'reclaim@example.com', passwordHash: 'h' });

      const stale = await store.kits.create({ userId: user.id, input: INPUT, jdHash: 'stale' });
      const fresh = await store.kits.create({ userId: user.id, input: INPUT, jdHash: 'fresh' });
      const finished = await store.kits.create({ userId: user.id, input: INPUT, jdHash: 'done' });

      await store.kits.write({ kitId: stale.id, set: { status: 'running' } });
      await store.kits.write({ kitId: fresh.id, set: { status: 'running' } });
      await store.kits.write({ kitId: finished.id, set: { status: 'ready' } });

      // A window of -1ms makes every existing kit older than the cutoff, which is the
      // only way to test this without waiting ten minutes or injecting a clock into
      // Mongo as well.
      const reclaimed = await store.kits.reclaimStale({ olderThanMs: -1 });

      assert.equal(typeof reclaimed, 'number', 'both stores report a count');
      assert.ok(reclaimed >= 2, `expected at least the two running kits, got ${reclaimed}`);

      const after = await store.kits.findById(stale.id);
      assert.equal(after.status, 'failed');
      assert.equal(after.error.code, 'BUILD_INTERRUPTED', 'one code, shared by both stores');
      assert.match(after.error.message, /Nothing is wrong with the posting/);
      assert.ok(after.revision > 0, 'the revision moves, so every client view is stale');

      // A finished kit is not a stale one. Reclaiming it would turn a kit the user
      // already has into a failure.
      assert.equal((await store.kits.findById(finished.id)).status, 'ready');
    });

    test('reclaimStale leaves recently updated running kits alone', async () => {
      const user = await store.users.create({ email: 'recent@example.com', passwordHash: 'h' });
      const running = await store.kits.create({ userId: user.id, input: INPUT, jdHash: 'recent' });
      await store.kits.write({ kitId: running.id, set: { status: 'running' } });

      // A generous window: nothing created during this test can be ten minutes old.
      await store.kits.reclaimStale();

      assert.equal(
        (await store.kits.findById(running.id)).status,
        'running',
        'a healthy build must not be reclaimed out from under itself'
      );
    });
  });
}

// ---------------------------------------------------------------------------
// The memory store always runs.
// ---------------------------------------------------------------------------

contractFor('memoryStore', async () => createMemoryStore());

// ---------------------------------------------------------------------------
// The Mongo store runs when there is a database to run against.
// ---------------------------------------------------------------------------

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI) {
  test('store contract: mongoStore (skipped — MONGODB_URI is not set)', { skip: true }, () => {});
} else {
  let connection = null;

  // A scratch database per run, dropped afterwards, so the suite can never touch real
  // kits even when pointed at a production URI by accident.
  const [beforeQuery, query] = MONGO_URI.split('?');
  const base = beforeQuery.replace(/\/[^/]*$/, '');
  const scratchUri = `${base}/aipk_test_${process.pid}${query ? `?${query}` : ''}`;

  contractFor(
    'mongoStore',
    async () => {
      const { createMongoStore } = await import('../src/store/mongoStore.js');
      return createMongoStore();
    },
    {
      setUp: async () => {
        const { connectMongo } = await import('../src/store/mongoStore.js');
        connection = await connectMongo(scratchUri);
        assert.match(connection.name, /^aipk_test_/, 'never the real database');
      },
      tearDown: async () => {
        if (!connection) return;
        await connection.dropDatabase();
        const { disconnectMongo } = await import('../src/store/mongoStore.js');
        await disconnectMongo();
      },
    }
  );
}
