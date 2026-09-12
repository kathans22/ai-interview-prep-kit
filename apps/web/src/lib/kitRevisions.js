/**
 * kitRevisions.js — the one place that knows what revision each kit is at.
 *
 * Decides: which revision number the client sends with a write, and how that number is
 * kept current.
 *
 * Does NOT decide: what to do when a write is refused. Recovery is the caller's, and it
 * has what it needs — a refused write carries both revisions and the current kit.
 *
 * WHY THIS IS ONE PLACE AND NOT A PIECE OF COMPONENT STATE. Every kit write the server
 * accepts — edit, regenerate, undo — takes the revision the client believes it holds and
 * refuses the write if the server has moved on. That number therefore has to be right in
 * whichever component happens to fire the next write, and components that each keep
 * their own copy go stale independently: the kit page regenerates, its revision moves,
 * and a modal opened before that still holds the old one and fails for no reason the
 * user can see.
 *
 * So the rule is: nothing reads a revision out of a component's state. Every response
 * that carries one is recorded here by `api.js`, including the 409 that just refused a
 * write, and every write reads it back from here. One writer, one reader, no drift.
 *
 * A ledger rather than a single value, because a page can hold several kits (the listing
 * shows many, each with its own revision).
 */

export function createKitRevisions() {
  /** @type {Map<string, number>} kit id -> the newest revision seen for it */
  const seen = new Map();

  return {
    /**
     * Record a revision. Older numbers are ignored rather than written: responses can
     * land out of order — a slow GET finishing after a fast PATCH is ordinary — and
     * letting the late one win would send a stale number with the next write.
     */
    record(kitId, revision) {
      if (!kitId || !Number.isInteger(revision)) return;
      const current = seen.get(String(kitId));
      if (current === undefined || revision > current) seen.set(String(kitId), revision);
    },

    /** The revision to send with a write, or null when this kit has never been read. */
    get(kitId) {
      const revision = seen.get(String(kitId));
      return revision === undefined ? null : revision;
    },

    /** Forget a kit — after a delete, so a recreated id cannot inherit a stale number. */
    forget(kitId) {
      seen.delete(String(kitId));
    },

    /** Drop everything. Called on sign-out: another account's revisions are not ours. */
    clear() {
      seen.clear();
    },

    /** Read-only view, for tests and for showing the number in a debug panel. */
    snapshot() {
      return Object.fromEntries(seen);
    },
  };
}

/**
 * The process-wide ledger. A browser tab serves one signed-in person, so a single
 * instance is correct here — unlike on the server, where two concurrent builds sharing
 * mutable module state would contaminate each other.
 */
export const kitRevisions = createKitRevisions();
