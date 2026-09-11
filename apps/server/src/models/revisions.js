/**
 * revisions.js — optimistic concurrency for kit writes.
 *
 * Decides: whether a write may land, given the revision its author last saw.
 *
 * Does NOT decide: what the write contains, or how to resolve a conflict. A rejected
 * write comes back with the current revision so the client can re-read and decide; this
 * module never merges on the client's behalf, because guessing what someone meant is how
 * an edit gets silently overwritten by a "helpful" resolution.
 *
 * THE CONFLICT THIS EXISTS FOR IS NOT HYPOTHETICAL. A user opens a kit at revision 4 and
 * starts editing q3. A background regeneration finishes and writes revision 5. The user
 * submits, still carrying 4. Without a check, their edit lands on top of a kit they never
 * saw — or worse, the regeneration lands on top of their edit. The merge rules protect
 * the CONTENT of an edit; this protects the ACT of editing from happening against stale
 * state in the first place.
 *
 * WHY NOT MONGOOSE'S versionKey. `__v` increments only on certain array operations, so a
 * document can be rewritten without it moving — which makes it useless as a "has anything
 * changed?" signal. `revision` is bumped by this module on every write, unconditionally.
 *
 * THE COMPARE-AND-SET IS ONE ATOMIC OPERATION. `findOneAndUpdate` with the expected
 * revision in the FILTER means the database performs the check and the write together.
 * Reading, comparing in JavaScript, then writing would leave a window between the two in
 * which another writer can land — the exact race this is supposed to close, reintroduced
 * by the code meant to close it.
 */

/** Returned to a client whose write was based on a revision that has since moved. */
export const STALE_REVISION = 'STALE_REVISION';

/** Thrown when a write is refused. Carries what the client needs to recover. */
export class StaleRevisionError extends Error {
  constructor({ expected, current, kitId }) {
    super(
      `This kit has changed since you loaded it: you sent revision ${expected}, ` +
        `the current revision is ${current}. Re-read the kit and apply your change again.`
    );
    this.name = 'StaleRevisionError';
    this.code = STALE_REVISION;
    this.expectedRevision = expected;
    this.currentRevision = current;
    this.kitId = kitId;
  }

  /** The structured conflict body an HTTP layer returns verbatim. */
  toResponse() {
    return {
      code: this.code,
      message: this.message,
      currentRevision: this.currentRevision,
      expectedRevision: this.expectedRevision,
    };
  }
}

/**
 * Apply a write only if the kit is still at `expectedRevision`.
 *
 * @param {object} options
 * @param {import('mongoose').Model} options.model the Kit model
 * @param {string} options.kitId
 * @param {number} options.expectedRevision the revision the client last saw
 * @param {object} options.set fields to write, excluding `revision` and `updatedAt`
 * @param {object} [options.push] `$push` operations, e.g. a progress event
 * @param {() => Date} [options.now]
 * @returns {Promise<object>} the updated document
 * @throws {StaleRevisionError} when the revision has moved
 */
export async function writeWithRevision({
  model,
  kitId,
  expectedRevision,
  set = {},
  push = null,
  now = () => new Date(),
}) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError(
      `expectedRevision must be a non-negative integer, got ${JSON.stringify(expectedRevision)}. ` +
        'A write with no revision is a write that cannot be checked.'
    );
  }

  const update = {
    // Both bumped together, always, so "did this change?" has one answer and not two.
    $set: { ...set, updatedAt: now() },
    $inc: { revision: 1 },
  };
  if (push) update.$push = push;

  // Filter INCLUDES the revision: the check and the write are one operation, so no other
  // writer can land between them.
  const updated = await model.findOneAndUpdate(
    { _id: kitId, revision: expectedRevision },
    update,
    { returnDocument: 'after' }
  );

  if (updated) return updated;

  // The write did not land. Either the kit is gone or its revision moved — and the two
  // need different answers, so find out which rather than guessing.
  const current = await model.findById(kitId).select('revision').lean();
  if (!current) {
    const error = new Error(`Kit ${kitId} does not exist.`);
    error.code = 'KIT_NOT_FOUND';
    error.kitId = kitId;
    throw error;
  }

  throw new StaleRevisionError({ expected: expectedRevision, current: current.revision, kitId });
}

/**
 * A write the pipeline makes on its own behalf, with no client revision to check.
 *
 * Progress events and status changes during a build are not user edits: there is no
 * "revision the author last saw", because the author is the build itself. These still
 * bump `revision`, so a client editing mid-build is correctly told its view is stale.
 *
 * @returns {Promise<object|null>} the updated document, or null if the kit is gone
 */
export async function writeUnchecked({ model, kitId, set = {}, push = null, now = () => new Date() }) {
  const update = {
    $set: { ...set, updatedAt: now() },
    $inc: { revision: 1 },
  };
  if (push) update.$push = push;

  return model.findByIdAndUpdate(kitId, update, { returnDocument: 'after' });
}

/**
 * Is this error a revision conflict? Saves every call site from string-matching a code.
 */
export function isStaleRevision(error) {
  return error?.code === STALE_REVISION;
}
