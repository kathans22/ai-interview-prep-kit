/**
 * Kit.js — a stored kit, its progress, and enough history to undo one step.
 *
 * Decides: the persisted shape. What a kit record holds, what indexes exist, and which
 * fields a stale write can collide on.
 *
 * Does NOT decide: how a kit is built (`@aipk/core/orchestrator/buildKit.js`), how
 * sections merge (`@aipk/core/contracts/merge.js`), or what makes a kit valid
 * (`validateKit`). The model stores; core decides. A schema that validated kit semantics
 * would be a second implementation of the contract, free to drift from the first.
 *
 * THE KIT OBJECT IS STORED LOOSELY ON PURPOSE. `kit` is `Schema.Types.Mixed`, not a
 * mirrored Mongoose schema. Mirroring it would mean two definitions of the frozen
 * contract — one in `kitSchema.js` and one here — and the day they disagree, the database
 * silently wins. `validateKit` is the single authority, and it runs before a write.
 *
 * STATUS IS THE LIFECYCLE, NOT THE QUALITY. `ready` means a kit exists and passed its
 * checks, including a degraded one with recorded gaps. `failed` means no kit could be
 * produced at all — the same line the batch contract draws, so the two cannot disagree.
 */

import mongoose from 'mongoose';

/** The lifecycle a kit moves through. */
export const KIT_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  READY: 'ready',
  FAILED: 'failed',
});

/**
 * A progress event, stored as it was emitted.
 *
 * `detail` is Mixed because each step reports different things — page counts, skip
 * reasons, coverage numbers — and a schema narrow enough to type them all would have to
 * change every time a step learned to say something new.
 */
const progressSchema = new mongoose.Schema(
  {
    step: { type: String, required: true },
    status: { type: String, required: true },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

/**
 * One practice rating.
 *
 * Beside the kit, never inside it: a regeneration replaces questions, and a merge has no
 * business deleting a record of what a person actually did. Append-only, because "a 2,
 * then later a 4" is the interesting shape and overwriting destroys it.
 *
 * This field's ABSENCE was a real defect. `practiceRoutes` has pushed to `practice`
 * since Stage 9, and Mongoose is `strict: true` by default — a `$push` to an undeclared
 * path is discarded with no error. Against MongoDB every rating would have returned 201
 * and saved nothing. Invisible until now only because nothing had ever connected.
 */
const practiceSchema = new mongoose.Schema(
  {
    questionId: { type: String, required: true },
    confidence: { type: Number, required: true, min: 1, max: 5 },
    note: { type: String, default: '' },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

const kitSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: Object.values(KIT_STATUS),
      default: KIT_STATUS.QUEUED,
      index: true,
    },

    /** What was asked for. Kept verbatim so a rebuild uses the same input. */
    input: {
      jd: { type: String, required: true },
      company_url: { type: String, default: '' },
      days: { type: Number, required: true },
      /**
       * sha256 of the normalised input. Indexed with userId so "has this person already
       * asked for this?" is one lookup rather than a scan.
       */
      jdHash: { type: String, required: true, index: true },
    },

    /** The Appendix A object. Mixed by design — see the header. */
    kit: { type: mongoose.Schema.Types.Mixed, default: null },

    /**
     * Bumped on EVERY write, and the basis of optimistic concurrency.
     *
     * Mongoose's own `versionKey` is not used for this: it only increments on certain
     * array operations, so a document could be rewritten without it moving. A counter
     * this system controls is one it can reason about.
     */
    revision: { type: Number, default: 0, min: 0 },

    progress: { type: [progressSchema], default: [] },

    /**
     * One snapshot per section, for a single-step undo.
     *
     * Deliberately not an unbounded history: the brief asks to undo a regeneration, and
     * a growing array of every prior state would make a kit document grow without limit
     * while answering a question nobody asked.
     */
    previousSections: {
      company_brief: { type: mongoose.Schema.Types.Mixed, default: null },
      questions: { type: mongoose.Schema.Types.Mixed, default: null },
      flashcards: { type: mongoose.Schema.Types.Mixed, default: null },
      schedule: { type: mongoose.Schema.Types.Mixed, default: null },
    },

    /** Serialised page cache, so a resume re-fetches nothing. */
    pageCache: { type: mongoose.Schema.Types.Mixed, default: null },

    /** Practice ratings, append-only. See `practiceSchema`. */
    practice: { type: [practiceSchema], default: [] },

    /** Set only when status is `failed`. Carries the code the caller can act on. */
    error: {
      code: { type: String, default: null },
      message: { type: String, default: null },
      at: { type: Date, default: null },
    },

    createdAt: { type: Date, default: () => new Date() },
    updatedAt: { type: Date, default: () => new Date() },
  },
  {
    // `updatedAt` is maintained alongside `revision` so the two can never disagree about
    // whether a write happened.
    timestamps: false,
    versionKey: false,
  }
);

/**
 * Idempotency lookup: the same posting, from the same person, asked again.
 *
 * Compound and ordered userId-first because every query filters by owner — one person's
 * duplicate submission must never match another person's kit, however identical the
 * posting.
 */
kitSchema.index({ userId: 1, 'input.jdHash': 1, createdAt: -1 });

/** Listing a user's kits, newest first. */
kitSchema.index({ userId: 1, createdAt: -1 });

/** A kit the caller may see, with the bulky internals left out. */
kitSchema.methods.toSummary = function toSummary() {
  return {
    id: String(this._id),
    status: this.status,
    revision: this.revision,
    input: {
      company_url: this.input?.company_url ?? '',
      days: this.input?.days ?? null,
      jdChars: this.input?.jd?.length ?? 0,
    },
    hasKit: Boolean(this.kit),
    error: this.error?.code ? { code: this.error.code, message: this.error.message } : null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

/**
 * The full record, minus the two fields a client has no use for.
 *
 * `pageCache` is an implementation detail measured in hundreds of kilobytes, and the raw
 * `input.jd` is already in the client's hands — it sent it.
 */
kitSchema.methods.toJSON = function toJSON() {
  return {
    id: String(this._id),
    status: this.status,
    revision: this.revision,
    input: {
      company_url: this.input?.company_url ?? '',
      days: this.input?.days ?? null,
      jdChars: this.input?.jd?.length ?? 0,
    },
    kit: this.kit,
    progress: this.progress,
    canUndo: Object.fromEntries(
      ['company_brief', 'questions', 'flashcards', 'schedule'].map((section) => [
        section,
        Boolean(this.previousSections?.[section]),
      ])
    ),
    error: this.error?.code ? { code: this.error.code, message: this.error.message, at: this.error.at } : null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const Kit = mongoose.models.Kit ?? mongoose.model('Kit', kitSchema);
