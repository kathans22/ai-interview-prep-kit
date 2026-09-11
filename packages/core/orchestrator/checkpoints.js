/**
 * checkpoints.js — persist enough to reopen and continue a kit later.
 *
 * Decides: what a checkpoint contains, and which steps a resume may skip.
 *
 * Does NOT decide: where it is stored. A store is injected — Mongo in the server, a file
 * in the CLI, a Map in tests — and this module only shapes what goes in and reads what
 * comes out. Core does not know Mongoose exists.
 *
 * WHY CHECKPOINT AT ALL. Two reasons, both concrete. A build spends up to twelve model
 * calls from a daily allowance of twenty, so losing a run at step 10 to a crash or a 429
 * does not just cost time — it can cost the rest of the day. And the brief asks for a kit
 * you can reopen and continue, which is only meaningful if the expensive parts survive.
 *
 * WHAT IS SAVED IS WHAT WAS EXPENSIVE, NOT EVERYTHING. Requirements, role profile, the
 * crawl's pages, the hiring page, the search result, the brief, the process, questions and
 * flashcards — each the output of work that cost a call or a fetch. What is NOT saved:
 * the schedule and the coverage numbers, because both are pure functions of the rest and
 * recomputing them is free. Storing a derived value is how a resume ends up with a
 * schedule that disagrees with its own questions.
 *
 * A CORRUPT OR UNREADABLE CHECKPOINT IS NOT A FAILURE. It means a full rebuild, which is
 * the behaviour a caller would have had anyway. A resume that refused to start because a
 * stale file could not be parsed would turn a cheap inconvenience into a dead run.
 */

import { STEPS } from './steps.js';

/** Bump when the saved shape changes in a way an older record cannot satisfy. */
export const CHECKPOINT_VERSION = 1;

/**
 * The state keys worth persisting, and the step each one stands for.
 *
 * The mapping is explicit so a resume can report WHICH steps it skipped, rather than
 * silently doing less work than the caller expects.
 */
const PERSISTED = Object.freeze([
  { key: 'requirements', step: STEPS.REQUIREMENTS },
  { key: 'requirementNotes', step: STEPS.REQUIREMENTS },
  { key: 'droppedRequirements', step: STEPS.REQUIREMENTS },
  { key: 'thinJd', step: STEPS.REQUIREMENTS },
  { key: 'roleProfile', step: STEPS.ROLE_PROFILE },
  { key: 'crawl', step: STEPS.CRAWL },
  { key: 'hiringPage', step: STEPS.HIRING_PAGE },
  { key: 'hiringPageReason', step: STEPS.HIRING_PAGE },
  { key: 'search', step: STEPS.PUBLIC_DISCUSSION },
  { key: 'companyBrief', step: STEPS.COMPANY_BRIEF },
  { key: 'hiringProcess', step: STEPS.HIRING_PROCESS },
  { key: 'questions', step: STEPS.QUESTIONS },
  { key: 'flashcards', step: STEPS.FLASHCARDS },
  { key: 'notes', step: null },
]);

/**
 * Shape run state into a record.
 *
 * @param {object} options
 * @param {string} options.kitId
 * @param {object} options.input the build input, so a resume can verify it matches
 * @param {object} options.state
 * @param {{ toJSON: Function }} [options.cache] the page cache, so a resume re-fetches nothing
 * @returns {object}
 */
export function toCheckpoint({ kitId, input, state, cache }) {
  const saved = {};
  for (const { key } of PERSISTED) {
    if (state[key] !== undefined) saved[key] = state[key];
  }

  return {
    version: CHECKPOINT_VERSION,
    kitId,
    at: new Date().toISOString(),
    // The input fingerprint. A checkpoint for a different posting is not a checkpoint
    // for this build, and resuming onto one would silently mix two kits.
    input: {
      jdChars: typeof input?.jd === 'string' ? input.jd.length : 0,
      companyUrl: input?.company_url ?? '',
      days: input?.days ?? null,
    },
    state: saved,
    pageCache: typeof cache?.toJSON === 'function' ? cache.toJSON() : null,
  };
}

/**
 * Which steps does this checkpoint let a resume skip?
 *
 * A step counts as complete only if the key it produces is present AND non-empty. A
 * crawl that recorded zero pages is complete — it genuinely ran and found nothing — but
 * an absent `crawl` key is not. The distinction matters because the first is a fact
 * worth keeping and the second is work that never happened.
 */
export function completedSteps(checkpoint) {
  const state = checkpoint?.state ?? {};
  const done = new Set();

  if (Array.isArray(state.requirements) && state.requirements.length > 0) done.add(STEPS.REQUIREMENTS);
  if (state.roleProfile) done.add(STEPS.ROLE_PROFILE);
  if (state.crawl) done.add(STEPS.CRAWL);
  if (state.hiringPage !== undefined) done.add(STEPS.HIRING_PAGE);
  if (state.search) done.add(STEPS.PUBLIC_DISCUSSION);
  if (state.companyBrief) done.add(STEPS.COMPANY_BRIEF);
  if (state.hiringProcess !== undefined) done.add(STEPS.HIRING_PROCESS);
  if (Array.isArray(state.questions) && state.questions.length > 0) done.add(STEPS.QUESTIONS);
  if (Array.isArray(state.flashcards) && state.flashcards.length > 0) done.add(STEPS.FLASHCARDS);

  return [...done];
}

/**
 * Rehydrate run state from a record, refusing one that does not belong to this build.
 *
 * @param {object} checkpoint
 * @param {object} input the current build input
 * @returns {{ ok: boolean, state: object|null, reason: string, completed: string[] }}
 */
export function fromCheckpoint(checkpoint, input) {
  if (!checkpoint || typeof checkpoint !== 'object') {
    return { ok: false, state: null, reason: 'CHECKPOINT_ABSENT', completed: [] };
  }
  if (checkpoint.version !== CHECKPOINT_VERSION) {
    return { ok: false, state: null, reason: 'CHECKPOINT_VERSION_MISMATCH', completed: [] };
  }

  // The guard that matters. Resuming a checkpoint taken from a different posting would
  // produce a kit whose requirements came from one job and whose questions came from
  // another — valid against the contract, and wrong in a way nothing downstream checks.
  const fingerprint = checkpoint.input ?? {};
  const currentChars = typeof input?.jd === 'string' ? input.jd.length : 0;
  if (fingerprint.jdChars !== currentChars || fingerprint.companyUrl !== (input?.company_url ?? '')) {
    return { ok: false, state: null, reason: 'CHECKPOINT_INPUT_MISMATCH', completed: [] };
  }

  const state = {};
  for (const { key } of PERSISTED) {
    if (checkpoint.state?.[key] !== undefined) state[key] = checkpoint.state[key];
  }

  return {
    ok: true,
    state,
    reason: 'CHECKPOINT_RESTORED',
    completed: completedSteps(checkpoint),
  };
}

/**
 * Wrap a store so a save failure cannot fail a build.
 *
 * Checkpointing is insurance, not the product. A database that refuses a write should
 * cost the run its ability to resume — which is a loss — but not the kit it is in the
 * middle of producing, which is the thing of value.
 *
 * @param {{ save?: Function, load?: Function }} [store]
 */
export function createCheckpointer(store, { onError } = {}) {
  const saves = [];

  return {
    async save(record) {
      saves.push({ at: record.at, keys: Object.keys(record.state ?? {}) });
      if (typeof store?.save !== 'function') return { saved: false, reason: 'NO_STORE' };
      try {
        await store.save(record);
        return { saved: true, reason: 'SAVED' };
      } catch (cause) {
        if (typeof onError === 'function') onError(cause);
        return { saved: false, reason: 'SAVE_FAILED', message: cause?.message };
      }
    },

    async load(kitId) {
      if (typeof store?.load !== 'function') return null;
      try {
        return await store.load(kitId);
      } catch {
        // Unreadable is the same as absent: rebuild from scratch.
        return null;
      }
    },

    history: () => [...saves],
  };
}

/** An in-memory store, for tests and for a CLI that does not need durability. */
export function createMemoryCheckpointStore() {
  const records = new Map();
  return {
    async save(record) {
      records.set(record.kitId, structuredClone(record));
    },
    async load(kitId) {
      const found = records.get(kitId);
      return found ? structuredClone(found) : null;
    },
    size: () => records.size,
  };
}
