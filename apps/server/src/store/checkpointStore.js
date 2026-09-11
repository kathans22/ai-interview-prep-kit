/**
 * checkpointStore.js — durable checkpoints, on the kit they belong to.
 *
 * Decides: where a build's checkpoint lives.
 *
 * Does NOT decide: what a checkpoint contains, when one is taken, or whether one may be
 * resumed onto. All three belong to `@aipk/core/orchestrator/checkpoints.js`, which also
 * owns the fingerprint guard that refuses a checkpoint from a different posting.
 *
 * WHY ON THE KIT DOCUMENT, NOT IN ITS OWN COLLECTION. A checkpoint has exactly the
 * lifetime of the kit it belongs to: it is meaningless without one, and deleting a kit
 * must not leave it behind. A separate collection would need its own cleanup, its own
 * ownership check, and a foreign key nothing enforces. One embedded field needs none of
 * that, and `remove()` already takes it with the kit.
 *
 * IT SATISFIES THE `{ save, load }` SHAPE `createCheckpointer` EXPECTS, which is what
 * makes this injectable into `buildKit` without core knowing a database exists (CF-038).
 *
 * A SAVE FAILURE IS SWALLOWED BY THE CHECKPOINTER, NOT HERE. `createCheckpointer` wraps
 * this and turns a throw into `{ saved: false }`, because checkpointing is insurance and
 * insurance must not cost you the thing it insures. This module reports honestly and
 * lets that wrapper decide.
 */

/**
 * Create a checkpoint store backed by the kit documents themselves.
 *
 * @param {object} store any object satisfying the kit store interface
 */
export function createKitCheckpointStore(store) {
  return {
    /**
     * Persist a checkpoint.
     *
     * Written UNCHECKED — no revision. A checkpoint is the build writing about its own
     * progress, not a user edit, so there is no "revision the author last saw" to check
     * against. It still bumps the revision, which is correct: a client holding an older
     * view of this kit genuinely is behind.
     */
    async save(record) {
      await store.kits.write({
        kitId: record.kitId,
        set: { checkpoint: record },
      });
    },

    async load(kitId) {
      // Loaded without an owner scope on purpose: this is called by the build, which
      // already knows which kit it is building. The ownership check belongs at the
      // route that decided to resume, not here — and doing it in both places would mean
      // the build needed a userId it has no other use for.
      const kit = await store.kits.findById?.(kitId);
      if (kit) return kit.checkpoint ?? null;

      // Stores that expose no unscoped read simply cannot resume, which is a
      // degradation rather than a fault: `createCheckpointer` reports NO_STORE and the
      // build starts from the beginning.
      return null;
    },
  };
}
