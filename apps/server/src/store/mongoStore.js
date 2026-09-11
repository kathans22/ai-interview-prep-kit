/**
 * mongoStore.js — the store interface, backed by MongoDB.
 *
 * Decides: how the interface `memoryStore.js` defines is satisfied against Mongoose.
 *
 * Does NOT decide: any rule. Every decision this file touches already exists —
 * optimistic concurrency in `models/revisions.js`, the duplicate policy in
 * `models/idempotency.js`, ownership in the shape of the queries. This file translates,
 * it does not legislate. A rule implemented here would be a second copy of a rule, and
 * the two would diverge the first time one was changed.
 *
 * WHY THIS EXISTS AT ALL, AND WHY SO LATE. Stage 8 built the Mongoose models and their
 * helpers. Stage 9 built routes and, to make them testable without a database, an
 * in-memory store. What nobody wrote was the piece joining the two — so the API ran
 * entirely on the Map, the models were imported by nothing, and `writeWithRevision`,
 * `snapshotBeforeMerge` and `findDuplicate` had no production call site for two stages.
 * The database was never connected, so no collection was ever created.
 *
 * THE TWO STORES MUST STAY INTERCHANGEABLE. Every route reads `request.store`; none may
 * know which backing it has. That is what lets 320 tests run with no database while the
 * same routes serve real traffic. The contract test in `store.test.js` runs the identical
 * assertions against both, because two implementations of an interface agree only for as
 * long as someone checks.
 *
 * DOCUMENTS COME BACK AS PLAIN OBJECTS with `id` as a string. Routes already do
 * `String(kit.id ?? kit._id)` defensively, but handing them a Mongoose document would
 * leak `save()`, `toJSON()` and lazy getters into code written against a Map — and the
 * day someone calls one, the memory store stops being a valid substitute.
 */

import mongoose from 'mongoose';

import { User } from '../models/User.js';
import { Kit } from '../models/Kit.js';
import { writeWithRevision, writeUnchecked } from '../models/revisions.js';

/** A Mongoose document as the rest of the system expects to see it. */
function plain(document) {
  if (!document) return null;
  const object = typeof document.toObject === 'function' ? document.toObject() : { ...document };
  object.id = String(object._id ?? document._id);
  delete object._id;
  return object;
}

/**
 * Is this a usable ObjectId?
 *
 * Route params are user input. `Kit.findById('nonsense')` throws a CastError, which the
 * error handler would surface as a 500 — turning "no such kit" into "the server is
 * broken", and telling an attacker probing ids the difference between a malformed one
 * and a real one they do not own. A malformed id is simply not found.
 */
function usableId(value) {
  return mongoose.Types.ObjectId.isValid(String(value));
}

/**
 * Create the store.
 *
 * Takes the models injected so a test can pass fakes, defaulting to the real ones.
 *
 * @param {object} [options]
 * @param {import('mongoose').Model} [options.userModel]
 * @param {import('mongoose').Model} [options.kitModel]
 * @param {() => Date} [options.now]
 */
export function createMongoStore({ userModel = User, kitModel = Kit, now = () => new Date() } = {}) {
  const userApi = {
    async create({ email, passwordHash }) {
      try {
        // The schema lowercases and trims, so normalisation is not repeated here — one
        // definition of "the same email" (see User.js).
        const created = await userModel.create({ email, passwordHash, createdAt: now() });
        return plain(created);
      } catch (error) {
        // Mongo's duplicate-key error is the unique index doing its job. Translated to
        // the same code the memory store throws, or the route would have to know which
        // store it is talking to — which is the one thing it must not know.
        if (error?.code === 11000) {
          const duplicate = new Error('duplicate email');
          duplicate.code = 'DUPLICATE_EMAIL';
          throw duplicate;
        }
        throw error;
      }
    },

    async findByEmail(email) {
      const found = await userModel.findOne({ email: String(email).trim().toLowerCase() }).lean();
      return plain(found);
    },

    async findById(id) {
      if (!usableId(id)) return null;
      return plain(await userModel.findById(id).lean());
    },
  };

  const kitApi = {
    async create({ userId, input, jdHash, status = 'queued' }) {
      const created = await kitModel.create({
        userId,
        status,
        input: { ...input, jdHash },
        revision: 0,
        createdAt: now(),
        updatedAt: now(),
      });
      return plain(created);
    },

    /**
     * Owner is part of the FILTER, never a check afterwards.
     *
     * Loading by id and comparing ownership in JavaScript is the shape that leaks: one
     * handler forgets the comparison and another user's kit is served. Here there is
     * nothing to forget — a kit belonging to someone else simply does not exist.
     */
    async findOwned({ kitId, userId }) {
      if (!usableId(kitId)) return null;
      return plain(await kitModel.findOne({ _id: kitId, userId }).lean());
    },

    async listOwned({ userId, limit = 50 }) {
      const found = await kitModel
        .find({ userId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      return found.map(plain);
    },

    /**
     * The duplicate lookup, executed. The POLICY — the hash, the window, which statuses
     * count — arrives already decided from `idempotency.js` via the route.
     */
    async findDuplicate({ userId, jdHash, since, statuses }) {
      const found = await kitModel
        .findOne({
          userId,
          'input.jdHash': jdHash,
          status: { $in: statuses },
          createdAt: { $gte: since },
        })
        .sort({ createdAt: -1 })
        .lean();
      return plain(found);
    },

    /** Optimistic concurrency. Delegated, never reimplemented — see the header. */
    async writeWithRevision({ kitId, expectedRevision, set = {}, push = null }) {
      if (!usableId(kitId)) {
        const error = new Error(`Kit ${kitId} does not exist.`);
        error.code = 'KIT_NOT_FOUND';
        throw error;
      }
      const updated = await writeWithRevision({
        model: kitModel,
        kitId,
        expectedRevision,
        set,
        push,
        now,
      });
      return plain(updated);
    },

    /** A pipeline write: no client revision to check, but the counter still moves. */
    async write({ kitId, set = {}, push = null }) {
      if (!usableId(kitId)) return null;
      const updated = await writeUnchecked({ model: kitModel, kitId, set, push, now });
      return plain(updated);
    },

    async remove({ kitId, userId }) {
      if (!usableId(kitId)) return false;
      const result = await kitModel.deleteOne({ _id: kitId, userId });
      return result.deletedCount > 0;
    },

    /**
     * Jobs orphaned by a restart.
     *
     * The runner is in-process, so a kit left `running` when the process died will stay
     * that way for ever — a spinner nothing will ever finish. Called at boot.
     */
    async reclaimStale({ olderThanMs = 15 * 60 * 1000 } = {}) {
      const cutoff = new Date(now().getTime() - olderThanMs);
      const result = await kitModel.updateMany(
        { status: 'running', updatedAt: { $lt: cutoff } },
        {
          $set: {
            status: 'failed',
            error: {
              code: 'INTERRUPTED',
              message:
                'The server restarted while this kit was being built. Nothing was lost except the run itself — submit it again.',
              at: now(),
            },
            updatedAt: now(),
          },
          $inc: { revision: 1 },
        }
      );
      return result.modifiedCount ?? 0;
    },
  };

  return { users: userApi, kits: kitApi };
}

/**
 * Connect, and fail loudly rather than limping.
 *
 * A server that starts without its database serves 500s that look like application bugs.
 * Refusing to start points at the real problem, at the moment it can still be fixed.
 *
 * `bufferCommands: false` matters: by default Mongoose queues operations issued before a
 * connection exists and resolves them later, so a misconfigured URI produces requests
 * that hang rather than fail. A hang is the hardest failure to diagnose.
 */
export async function connectMongo(uri, { serverSelectionTimeoutMS = 10_000 } = {}) {
  mongoose.set('strictQuery', true);
  mongoose.set('bufferCommands', false);

  await mongoose.connect(uri, { serverSelectionTimeoutMS });

  return mongoose.connection;
}

/** Close the connection. Used by tests and by a clean shutdown. */
export async function disconnectMongo() {
  await mongoose.disconnect();
}
