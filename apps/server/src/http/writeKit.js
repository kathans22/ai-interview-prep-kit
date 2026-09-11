/**
 * writeKit.js — a revision-checked write that loses nothing when it loses.
 *
 * Decides: what a client gets back when its write is refused as stale.
 *
 * Does NOT decide: whether the write is stale — that is the store's compare-and-set,
 * and it stays one atomic operation.
 *
 * WHY THIS EXISTS. Stage 9's brief is explicit: a mismatch returns 409 STALE_REVISION
 * "with the current kit in the body so the client reapplies rather than losing the
 * edit." The 409 carried `currentRevision` and `expectedRevision` but not the kit, so a
 * client had to fire a second GET before it could recover — and a client that does not
 * know to do that simply drops the user's work. The revision number alone tells you that
 * you are behind; the kit tells you what to reapply onto.
 *
 * THE FRESH KIT IS RE-READ, NOT TAKEN FROM THE REQUEST. `withOwnedKit` loaded a copy
 * before the write was attempted, and that copy is exactly the stale one the client
 * already has. Returning it would be worse than returning nothing: it looks like
 * recovery data and is the same thing that just failed.
 *
 * IT IS SCOPED BY OWNER like every other read. A conflict response must not become the
 * one endpoint that hands back a kit without checking who is asking.
 */

import { isStaleRevision } from '../models/revisions.js';

/**
 * Write with a revision check, enriching a conflict with the current state.
 *
 * @param {object} request the Express request, for `store` and `session`
 * @param {object} options passed through to the store
 * @param {string} options.kitId
 * @param {number} options.expectedRevision
 * @param {object} [options.set]
 * @param {object} [options.push]
 * @returns {Promise<object>} the updated kit document
 * @throws {StaleRevisionError} carrying `kit` and a refreshed `currentRevision`
 */
export async function writeKitChecked(request, { kitId, expectedRevision, set = {}, push = null }) {
  try {
    return await request.store.kits.writeWithRevision({ kitId, expectedRevision, set, push });
  } catch (error) {
    if (!isStaleRevision(error)) throw error;

    // Best effort: if this read fails the conflict is still correct, just less useful.
    // A failure to build a better error must never replace the error.
    try {
      const fresh = await request.store.kits.findOwned({
        kitId,
        userId: request.session.userId,
      });
      if (fresh) {
        error.kit = fresh.kit;
        // The revision from the read is newer than the one the failed write reported if
        // a third writer landed in between, and the client needs the one that matches
        // the kit it is being handed.
        error.currentRevision = fresh.revision;
      }
    } catch {
      /* keep the original conflict */
    }

    throw error;
  }
}
