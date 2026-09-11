/**
 * memoryStore.js — persistence that lives in a Map.
 *
 * Decides: nothing about behaviour. It implements the same store interface the Mongoose
 * store does, in memory.
 *
 * Does NOT decide: durability. Everything vanishes when the process does.
 *
 * WHY THIS IS PRODUCTION CODE AND NOT A TEST FIXTURE. It defines the store INTERFACE —
 * the set of operations routes are allowed to perform. Writing it first, and making the
 * Mongoose store conform to it, means routes cannot reach for a Mongoose-specific
 * escape hatch, and the whole HTTP surface can be tested in-process with no database.
 *
 * It also enforces the same invariants the real store must:
 *   - `findOwned` filters by owner IN THE LOOKUP, so another user's kit is never
 *     returned and never has to be filtered out afterwards
 *   - every write bumps `revision`, and a revision-checked write applies atomically
 *     against a snapshot, mirroring `findOneAndUpdate`'s compare-and-set
 * A fake that is looser than the real thing proves nothing; this one is deliberately as
 * strict.
 */

import { StaleRevisionError } from '../models/revisions.js';

let counter = 0;
const nextId = (prefix) => `${prefix}_${(counter += 1).toString(36)}${Date.now().toString(36)}`;

/** Deep copy on the way in and out, so a caller cannot mutate stored state by accident. */
const copy = (value) => (value === undefined ? undefined : structuredClone(value));

export function createMemoryStore({ now = () => new Date() } = {}) {
  const users = new Map();
  const usersByEmail = new Map();
  const kits = new Map();

  const userApi = {
    async create({ email, passwordHash }) {
      const normalised = String(email).trim().toLowerCase();
      if (usersByEmail.has(normalised)) {
        const error = new Error('duplicate email');
        error.code = 'DUPLICATE_EMAIL';
        throw error;
      }
      const user = { id: nextId('u'), email: normalised, passwordHash, createdAt: now() };
      users.set(user.id, user);
      usersByEmail.set(normalised, user);
      return copy(user);
    },

    async findByEmail(email) {
      return copy(usersByEmail.get(String(email).trim().toLowerCase()) ?? null);
    },

    async findById(id) {
      return copy(users.get(String(id)) ?? null);
    },
  };

  const kitApi = {
    async create({ userId, input, jdHash, status = 'queued' }) {
      const kit = {
        id: nextId('k'),
        userId: String(userId),
        status,
        input: { ...input, jdHash },
        kit: null,
        revision: 0,
        progress: [],
        previousSections: { company_brief: null, questions: null, flashcards: null, schedule: null },
        pageCache: null,
        practice: [],
        error: { code: null, message: null, at: null },
        createdAt: now(),
        updatedAt: now(),
      };
      kits.set(kit.id, kit);
      return copy(kit);
    },

    /** Owner is part of the lookup. A kit belonging to someone else is simply not found. */
    async findOwned({ kitId, userId }) {
      const kit = kits.get(String(kitId));
      if (!kit || kit.userId !== String(userId)) return null;
      return copy(kit);
    },

    async listOwned({ userId, limit = 50 }) {
      return [...kits.values()]
        .filter((kit) => kit.userId === String(userId))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map(copy);
    },

    async findDuplicate({ userId, jdHash, since, statuses }) {
      const matches = [...kits.values()].filter(
        (kit) =>
          kit.userId === String(userId) &&
          kit.input.jdHash === jdHash &&
          statuses.includes(kit.status) &&
          kit.createdAt >= since
      );
      return copy(matches.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null);
    },

    /** Compare-and-set, mirroring findOneAndUpdate with the revision in the filter. */
    async writeWithRevision({ kitId, expectedRevision, set = {}, push = null }) {
      const kit = kits.get(String(kitId));
      if (!kit) {
        const error = new Error(`Kit ${kitId} does not exist.`);
        error.code = 'KIT_NOT_FOUND';
        throw error;
      }
      if (kit.revision !== expectedRevision) {
        throw new StaleRevisionError({ expected: expectedRevision, current: kit.revision, kitId });
      }
      applyWrite(kit, set, push, now);
      return copy(kit);
    },

    /** A pipeline write: no client revision to check, but the counter still moves. */
    async write({ kitId, set = {}, push = null }) {
      const kit = kits.get(String(kitId));
      if (!kit) return null;
      applyWrite(kit, set, push, now);
      return copy(kit);
    },

    async remove({ kitId, userId }) {
      const kit = kits.get(String(kitId));
      if (!kit || kit.userId !== String(userId)) return false;
      kits.delete(String(kitId));
      return true;
    },
  };

  return {
    users: userApi,
    kits: kitApi,
    /** Test affordance, never used by routes. */
    _raw: { users, kits },
  };
}

/** Apply dotted-path `$set` and `$push`, as Mongo would. */
function applyWrite(kit, set, push, now) {
  for (const [path, value] of Object.entries(set)) {
    setPath(kit, path, copy(value));
  }
  for (const [path, value] of Object.entries(push ?? {})) {
    const existing = getPath(kit, path);
    setPath(kit, path, [...(Array.isArray(existing) ? existing : []), copy(value)]);
  }
  kit.revision += 1;
  kit.updatedAt = now();
}

function setPath(target, path, value) {
  const keys = path.split('.');
  let cursor = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    cursor[keys[index]] = cursor[keys[index]] ?? {};
    cursor = cursor[keys[index]];
  }
  cursor[keys.at(-1)] = value;
}

function getPath(target, path) {
  return path.split('.').reduce((cursor, key) => cursor?.[key], target);
}
