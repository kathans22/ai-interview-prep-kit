/**
 * steps.js — the named steps of a kit build, and what each one is allowed to cost.
 *
 * Decides: the step vocabulary. Every progress event, checkpoint and budget label comes
 * from here, so the API, the CLI and the resume store all name the same thing the same
 * way.
 *
 * Does NOT decide: the order they run in (sequence.js), or what any of them does.
 *
 * WHY A TABLE RATHER THAN STRINGS AT THE CALL SITE. Three consumers read these names: a
 * progress stream the UI renders, a checkpoint file a resume reads back, and a budget
 * ledger. A typo in any one of them is silent — the UI shows a step that never
 * completes, or a resume re-runs work it already paid for. A single table makes the
 * names checkable.
 *
 * OPTIONAL means the time governor may skip it. Exactly two things are optional:
 * flashcards, and the third coverage pass. Everything else runs, degraded if necessary.
 * The public discussion search is explicitly NOT optional — under pressure it narrows to
 * one short query, but it always executes, because "attempted and empty" scores and
 * "never attempted" does not.
 */

/** Every step, in the order they are sequenced. */
export const STEPS = Object.freeze({
  REQUIREMENTS: 'requirements',
  ROLE_PROFILE: 'role-profile',
  CRAWL: 'crawl',
  HIRING_PAGE: 'hiring-page',
  PUBLIC_DISCUSSION: 'public-discussion',
  COMPANY_BRIEF: 'company-brief',
  HIRING_PROCESS: 'hiring-process',
  QUESTIONS: 'questions',
  COVERAGE: 'coverage',
  GAP_FILL: 'gap-fill',
  FLASHCARDS: 'flashcards',
  SCHEDULE: 'schedule',
  ASSEMBLE: 'assemble',
  VALIDATE: 'validate',
});

/** Status values a progress event can carry. */
export const STATUS = Object.freeze({
  STARTED: 'started',
  DONE: 'done',
  /** Ran, but produced less than it might have. The run continues. */
  DEGRADED: 'degraded',
  /** Did not run: the governor, the budget, or a resume that already had it. */
  SKIPPED: 'skipped',
  /** Ran and failed. Only fatal for steps with no degraded path. */
  FAILED: 'failed',
});

/**
 * Steps the time governor may drop.
 *
 * The third coverage pass is handled inside the coverage loop rather than listed here,
 * because "the third pass" is a pass number, not a step.
 */
export const OPTIONAL_STEPS = Object.freeze([STEPS.FLASHCARDS]);

/**
 * Steps that spend from the per-kit call budget, and how many calls each needs on the
 * normal path. Kept beside the step names so the 12-call arithmetic from Block C can be
 * checked against the code rather than trusted.
 *
 *   requirements 1 + role-profile 1 + hiring-page 1 + hiring-process 1 +
 *   company-brief 1 + questions 4 + flashcards 1 + gap-fill 1  =  11
 *
 * The twelfth is reserved for a third coverage pass.
 */
export const NORMAL_PATH_CALLS = Object.freeze({
  [STEPS.REQUIREMENTS]: 1,
  [STEPS.ROLE_PROFILE]: 1,
  [STEPS.HIRING_PAGE]: 1,
  [STEPS.HIRING_PROCESS]: 1,
  [STEPS.COMPANY_BRIEF]: 1,
  [STEPS.QUESTIONS]: 4,
  [STEPS.FLASHCARDS]: 1,
  [STEPS.GAP_FILL]: 1,
});

/** A progress event, shaped once so every consumer can rely on it. */
export function progressEvent(step, status, detail = {}) {
  return { step, status, at: new Date().toISOString(), ...detail };
}

/**
 * Wrap a caller's hook so a throwing or missing hook cannot break a build.
 *
 * Progress reporting is decoration. A UI callback that throws — a closed SSE stream, a
 * CLI writing to a broken pipe — must not take the kit down with it, because the kit is
 * the thing of value and the progress line is not.
 */
export function createReporter(onProgress) {
  const events = [];

  return {
    emit(step, status, detail = {}) {
      const event = progressEvent(step, status, detail);
      events.push(event);
      if (typeof onProgress === 'function') {
        try {
          onProgress(step, status, event);
        } catch {
          // A broken listener is the listener's problem.
        }
      }
      return event;
    },
    events: () => [...events],
  };
}
