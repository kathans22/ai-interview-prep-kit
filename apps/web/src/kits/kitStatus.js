/**
 * kitStatus.js — what state a kit is in, as a reader needs it.
 *
 * Decides: the five states the UI distinguishes, their wording, and which action each
 * one offers next.
 *
 * Does NOT decide: what the server does about any of it. The five are derived from what
 * the API already returns — `status` plus `error.code` — and nothing here is guessed.
 *
 * THE SERVER HAS FOUR STATUSES; THE READER NEEDS FIVE. `queued`, `running`, `ready` and
 * `failed` are the whole of `KIT_STATUS`. But "failed" covers two situations that call
 * for different words and the same action for different reasons:
 *
 *   - The build was INTERRUPTED. `reclaimStale` marks a kit whose process died with
 *     `error.code = 'BUILD_INTERRUPTED'` at boot. Nothing is wrong with the posting or
 *     the kit; the server restarted. Telling that user their kit "failed" invites them
 *     to change an input that was never the problem.
 *   - The build genuinely FAILED. No requirements could be extracted, or the assembled
 *     kit did not satisfy its own contract. The reason matters and is shown.
 *
 * That distinction is the whole of what the brief means by "failed and interrupted kits
 * visibly distinct", and it is available because the server records a code rather than
 * just a status.
 *
 * CONTINUING AND STARTING OVER ARE NOW TWO REAL ACTIONS. They were not: the server had a
 * single mechanism whose behaviour depended on hidden state — resume from a checkpoint
 * when one exists, start over when it does not — so a client could offer one button and
 * explain afterwards which had happened, and nothing more honest than that. Two buttons
 * calling one endpoint would have been a lie about what they do.
 *
 * `POST /api/kits/:id/resume` now takes `fresh: true`, which ignores any checkpoint and
 * discards it, and the kit read reports `hasCheckpoint`. Between them the client can
 * offer the choice AND only offer it when there is something to choose between. The
 * `primary` action below is still one action, because a LIST row wants one obvious next
 * thing; the detail page is where the choice belongs.
 */

/**
 * The codes that mean "a process died mid-build", and there are TWO of them because the
 * server has two reclaim implementations that disagree.
 *
 *   - `INTERRUPTED` is written by `mongoStore.kits.reclaimStale()`, which is the one
 *     `index.js` actually calls at boot. This is the code a real interrupted kit carries.
 *   - `BUILD_INTERRUPTED` is written by `createJobRunner().reclaimStale()`, which has no
 *     production call site and depends on a `findStaleRunning` that neither store
 *     implements.
 *
 * Matching only the second — which is the one the job runner's own comments describe —
 * would show every interrupted kit as "Failed", telling a user whose server restarted
 * that their job posting was the problem. Both are accepted here, and the server-side
 * duplication is recorded as a carry-forward rather than papered over: the client
 * tolerating two codes is a workaround, not the fix.
 */
export const INTERRUPTED_CODES = Object.freeze(['INTERRUPTED', 'BUILD_INTERRUPTED']);

/** The code the live path writes. Kept for callers that need one name. */
export const INTERRUPTED_CODE = 'INTERRUPTED';

export const KIT_VIEW = Object.freeze({
  queued: 'queued',
  building: 'building',
  ready: 'ready',
  interrupted: 'interrupted',
  failed: 'failed',
});

/**
 * Describe a kit for a list row or a detail page.
 *
 * @param {{status?: string, error?: {code?: string, message?: string}|null}} kit
 */
export function describeKit(kit) {
  const status = kit?.status ?? null;
  const code = kit?.error?.code ?? null;

  if (status === 'ready') {
    return {
      view: KIT_VIEW.ready,
      label: 'Ready',
      tone: 'ok',
      detail: null,
      // "Open" rather than "View": it is a thing to work through, not to look at.
      primary: { kind: 'open', label: 'Open' },
      canResume: false,
    };
  }

  if (status === 'queued') {
    return {
      view: KIT_VIEW.queued,
      label: 'Queued',
      tone: 'busy',
      detail: 'Waiting for a build slot. Two kits build at once so they share the model quota fairly.',
      primary: { kind: 'open', label: 'Watch' },
      canResume: false,
    };
  }

  if (status === 'running') {
    return {
      view: KIT_VIEW.building,
      label: 'Building',
      tone: 'busy',
      detail: null,
      primary: { kind: 'open', label: 'Watch' },
      canResume: false,
    };
  }

  if (status === 'failed' && INTERRUPTED_CODES.includes(code)) {
    return {
      view: KIT_VIEW.interrupted,
      label: 'Interrupted',
      tone: 'warn',
      // Deliberately not the server's sentence here: the row is a summary, and the
      // point to convey is that the posting was fine.
      detail: 'The server restarted while this kit was building. Nothing is wrong with the posting.',
      primary: { kind: 'resume', label: 'Continue building' },
      canResume: true,
    };
  }

  if (status === 'failed') {
    return {
      view: KIT_VIEW.failed,
      label: 'Failed',
      tone: 'bad',
      // The server's message, because it was written to be read and it says what to do.
      detail: kit?.error?.message ?? 'This kit could not be built.',
      primary: { kind: 'resume', label: 'Try again' },
      canResume: true,
    };
  }

  return {
    view: KIT_VIEW.queued,
    label: 'Unknown',
    tone: 'busy',
    detail: null,
    primary: { kind: 'open', label: 'Open' },
    canResume: false,
  };
}

/** Is this kit finished, one way or the other? */
export function isSettled(kit) {
  return kit?.status === 'ready' || kit?.status === 'failed';
}

/**
 * What the server did when asked to continue a kit, in plain words.
 *
 * `resumedFrom` is either 'checkpoint' or 'the beginning', and the difference is worth
 * saying: one skips work already paid for out of a daily model quota, the other does not.
 */
export function describeResume(response) {
  // The server's own sentence first: it distinguishes three outcomes this function
  // cannot see apart — resumed, nothing to resume from, and started over on request —
  // and it was written to be read.
  if (typeof response?.message === 'string' && response.message !== '') return response.message;

  if (response?.resumedFrom === 'checkpoint') {
    return 'Continuing from the last checkpoint — the steps that already finished will not run again.';
  }
  return 'No checkpoint was saved for this kit, so it is building again from the start.';
}
