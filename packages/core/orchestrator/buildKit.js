/**
 * buildKit.js — the one entry point that produces a kit.
 *
 * Decides: the sequence, and what a partial result is allowed to look like.
 *
 * Does NOT decide: where the input came from, where the output goes, or how progress is
 * displayed. It knows nothing about Express, MongoDB or the CLI — it takes an input
 * object and a set of injected dependencies, and returns a kit.
 *
 * THIS IS WHY THE MONOREPO EXISTS. The HTTP route and the batch CLI both call this
 * function, so "the same code your application uses, not a parallel implementation" is
 * structural rather than a claim. Anything either adapter needs that this does not
 * provide belongs here, not in the adapter.
 *
 * DEGRADE, NEVER ABORT. Exactly one failure is fatal: being unable to extract any
 * requirements from the job description, because a kit with no requirements has nothing
 * to generate, cover or schedule. Every other failure — an unreachable company site, a
 * missing hiring page, a blocked category call, an exhausted budget, an expired clock —
 * records what happened and carries on with less. A kit that says what it could not do
 * is worth more than an exception, and the contract agrees: those cases are "ok" with
 * gaps recorded, not "failed".
 */

import { createBudget } from '../llm/budget.js';
import { createSourceLedger } from '../retrieval/sourceLedger.js';
import { createPageCache } from '../retrieval/pageCache.js';
import { allocate } from '../deterministic/scheduleAllocator.js';
import { STEPS, STATUS, createReporter, describeStepFailure } from './steps.js';
import { researchFromJd, researchCompany, generateQuestions } from './research.js';
import { runCoverageLoop } from './coverageLoop.js';
import { assembleKit } from './assemble.js';
import { createTimeGovernor, DEFAULT_SOFT_DEADLINE_MS } from './timeGovernor.js';
import { generateFlashcards } from '../generation/generateFlashcards.js';
import {
  createCheckpointer,
  toCheckpoint,
  fromCheckpoint,
} from './checkpoints.js';
import { restorePageCache } from '../retrieval/pageCache.js';
import { validateKit, formatValidationErrors } from '../contracts/validateKit.js';
import {
  verifySchedule,
  formatScheduleViolations,
  SCHEDULE_VIOLATIONS,
} from '../deterministic/verifySchedule.js';

/** Defaults matching Block C, overridable by the adapter's config. */
export const BUILD_DEFAULTS = Object.freeze({
  maxLlmCallsPerKit: 12,
  caseSoftDeadlineMs: DEFAULT_SOFT_DEADLINE_MS,
  crawlMaxPages: 12,
  crawlMaxDepth: 2,
  crawlConcurrency: 3,
  minutesPerDay: 60,
});

/** Thrown only when no kit can be produced at all. */
export class BuildFailedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BuildFailedError';
    this.code = details.code ?? 'BUILD_FAILED';
    this.details = details;
  }
}

/**
 * Build a kit.
 *
 * @param {object} input
 * @param {string} input.jd the pasted job description
 * @param {string} input.company_url
 * @param {number} input.days days the candidate has to prepare
 * @param {string} [input.kitId]
 * @param {object} deps injected collaborators — provider, fetcher, robots, cache,
 *   ledger, searchProvider, budget, plus the numeric limits
 * @param {{ onProgress?: Function }} [hooks]
 * @returns {Promise<{ kit: object, notes: string[], events: object[], budget: object }>}
 */
export async function buildKit(input, deps = {}, hooks = {}) {
  const { jd, company_url: companyUrl, days, kitId = null, resumeFrom = null } = input ?? {};

  if (typeof jd !== 'string' || jd.trim() === '') {
    throw new BuildFailedError('A job description is required to build a kit.', { code: 'BUILD_NO_JD' });
  }
  if (!Number.isInteger(days) || days < 1) {
    throw new BuildFailedError(`days must be a positive integer, got ${days}.`, { code: 'BUILD_BAD_DAYS' });
  }

  const reporter = createReporter(hooks.onProgress);
  // The clock starts at entry, not at the first call: time spent setting up, crawling
  // and waiting on the limiter all counts against the case, because it all counts
  // against the fifteen minutes the batch command has for five cases.
  const governor =
    deps.governor ??
    createTimeGovernor({ softDeadlineMs: deps.caseSoftDeadlineMs ?? BUILD_DEFAULTS.caseSoftDeadlineMs });
  const budget = deps.budget ?? createBudget(deps.maxLlmCallsPerKit ?? BUILD_DEFAULTS.maxLlmCallsPerKit);
  const ledger = deps.ledger ?? createSourceLedger();
  const cache = deps.cache ?? createPageCache();

  const resolved = {
    ...BUILD_DEFAULTS,
    ...deps,
    budget,
    ledger,
    cache,
    governor,
  };

  /** Everything accumulated so far. Shaped so a resume can be handed the same object. */
  const state = {
    kitId,
    notes: [],
    requirements: null,
    roleProfile: null,
    crawl: null,
    hiringPage: undefined,
    hiringProcess: undefined,
    search: null,
    companyBrief: null,
    questions: null,
    flashcards: [],
    coveragePasses: 0,
  };

  // --- resume ---------------------------------------------------------------
  // Every research step is written as "if this is not already in state, do it", so a
  // resume is an overlay rather than a second code path. There is no separate resume
  // sequence that could drift from the normal one.
  const checkpointer = createCheckpointer(deps.checkpointStore, {
    onError: (error) => state.notes.push(`Checkpoint save failed: ${error?.message ?? error}`),
  });

  if (resumeFrom) {
    const record = typeof resumeFrom === 'object' ? resumeFrom : await checkpointer.load(resumeFrom);
    const restored = fromCheckpoint(record, { jd, company_url: companyUrl, days });

    if (restored.ok) {
      Object.assign(state, restored.state);
      state.notes = Array.isArray(restored.state.notes) ? [...restored.state.notes] : [];

      // Merge the saved pages INTO the live cache rather than swapping in a new one:
      // `cache` is already shared with every dependency, so replacing the binding here
      // would leave the fetcher using an empty cache and re-fetching the whole site —
      // which is precisely the cost a resume exists to avoid.
      if (record.pageCache) {
        const saved = restorePageCache(record.pageCache);
        for (const url of saved.keys()) {
          const entry = saved.get(url);
          if (entry !== undefined) cache.set(url, entry);
        }
      }

      for (const step of restored.completed) {
        reporter.emit(step, STATUS.SKIPPED, { reason: 'RESUMED_FROM_CHECKPOINT' });
      }
      state.notes.push(
        `Resumed from a checkpoint taken at ${record.at}; ${restored.completed.length} step(s) were already complete.`
      );
    } else {
      // A mismatched or unreadable checkpoint means a full rebuild, which is what the
      // caller would have got without one. It is recorded, not raised.
      state.notes.push(`Checkpoint not used (${restored.reason}); rebuilding from scratch.`);
      reporter.emit(STEPS.REQUIREMENTS, STATUS.DEGRADED, { reason: restored.reason });
    }
  }

  /** Save after each expensive step. Failures are noted, never fatal. */
  const checkpoint = () =>
    checkpointer.save(toCheckpoint({ kitId, input: { jd, company_url: companyUrl, days }, state, cache }));

  // --- steps 1-2: the floor. Fatal only here. -------------------------------
  try {
    await researchFromJd({ jd, deps: resolved, reporter, budget, state });
  } catch (error) {
    throw new BuildFailedError(
      `Could not extract requirements from the job description: ${error.message}`,
      { code: error.code ?? 'BUILD_NO_REQUIREMENTS', cause: error }
    );
  }

  if (!Array.isArray(state.requirements) || state.requirements.length === 0) {
    throw new BuildFailedError(
      'The job description yielded no requirements, so there is nothing to build a kit from.',
      { code: 'BUILD_NO_REQUIREMENTS' }
    );
  }

  await checkpoint();

  // --- steps 3-7: the company. Everything here degrades. --------------------
  await researchCompany({ companyUrl, deps: resolved, reporter, budget, state, governor });
  await checkpoint();

  // --- step 8: questions ----------------------------------------------------
  await generateQuestions({ deps: resolved, reporter, budget, state });
  await checkpoint();

  // --- steps 9-10: coverage, in code, then fill exactly what is missing -----
  const coverage = await runCoverageLoop({
    requirements: state.requirements,
    questions: state.questions,
    deps: resolved,
    reporter,
    budget,
    state,
    governor,
  });

  state.questions = coverage.questions;
  state.coveragePasses = coverage.passes;
  state.uncovered = coverage.uncovered;
  state.notes.push(...coverage.notes);
  await checkpoint();

  // --- step 11: flashcards — OPTIONAL under the governor --------------------
  if (!governor.mayRun(STEPS.FLASHCARDS)) {
    governor.recordSkip(STEPS.FLASHCARDS);
    state.notes.push(
      `Flashcards were skipped: the ${governor.report().softDeadlineMs}ms case deadline had ` +
        `passed (${governor.elapsedMs()}ms elapsed). The kit is complete without them.`
    );
    reporter.emit(STEPS.FLASHCARDS, STATUS.SKIPPED, { reason: 'TIME_GOVERNOR', elapsedMs: governor.elapsedMs() });
  } else if (!budget.canSpend(1)) {
    governor.recordSkip(STEPS.FLASHCARDS, 'BUDGET_EXHAUSTED');
    state.notes.push('Flashcards were skipped: the call budget was exhausted.');
    reporter.emit(STEPS.FLASHCARDS, STATUS.SKIPPED, { reason: 'BUDGET_EXHAUSTED' });
  } else {
    reporter.emit(STEPS.FLASHCARDS, STATUS.STARTED);
    try {
      const result = await generateFlashcards(
        {
          requirements: state.requirements,
          questions: state.questions,
          existingIds: state.flashcards.map((card) => card.id),
        },
        {
          // The LIGHT model when configured: a flashcard restates material the kit
          // already contains as a front and a back. It is the most mechanical call
          // in the pipeline and the cheapest to move off the scored model.
          provider: resolved.providerLight ?? resolved.provider,
          spend: () => budget.spend(STEPS.FLASHCARDS),
        }
      );
      state.flashcards = result.flashcards;
      reporter.emit(STEPS.FLASHCARDS, result.flashcards.length > 0 ? STATUS.DONE : STATUS.DEGRADED, {
        count: result.flashcards.length,
        rejected: result.rejected.length,
      });
      if (result.skipped) state.notes.push(result.skipped);
    } catch (error) {
      // Flashcards are the one piece of content the kit is explicitly complete without.
      state.notes.push(`Flashcard generation failed (${describeStepFailure(error)}); the kit has none.`);
      reporter.emit(STEPS.FLASHCARDS, STATUS.FAILED, { code: error.code });
    }
  }

  // --- step 12: schedule (code, never a prompt) -----------------------------
  reporter.emit(STEPS.SCHEDULE, STATUS.STARTED, { days });
  const schedule = allocate({
    questions: state.questions,
    requirements: state.requirements,
    daysAvailable: days,
  });
  reporter.emit(STEPS.SCHEDULE, STATUS.DONE, { days: schedule.days.length });

  // --- step 13: assemble ----------------------------------------------------
  reporter.emit(STEPS.ASSEMBLE, STATUS.STARTED);
  const kit = assembleKit({ input: { jd, company_url: companyUrl, days }, state, schedule, ledger });

  reporter.emit(STEPS.ASSEMBLE, STATUS.DONE, {
    requirements: kit.role.requirements.length,
    questions: kit.questions.length,
  });

  // --- step 14: BOTH checks, and both must pass -----------------------------
  //
  // validateKit answers "is this the contract?" — every key present, every enum spelled
  // exactly, every id reference resolving. verifySchedule answers a different question:
  // "does this schedule make sense?" — the right number of days, every must reachable,
  // integer minutes, harder material earlier.
  //
  // Running only one leaves a whole class of fault able to ship. A kit can be perfectly
  // shaped and still schedule day 3 before day 1, drop half its questions, or never
  // mention a must-have; and a semantically sensible schedule can still carry an
  // Americanised enum that fails the contract. verifySchedule imports nothing from the
  // allocator, so agreement between them is evidence rather than a tautology.
  //
  // This is the last gate before a kit is handed to a caller, so a failure here IS
  // fatal. Everything else in this pipeline degrades, but a kit that does not satisfy
  // its own contract is not a degraded kit — it is a wrong one, and returning it would
  // push the fault downstream into the batch output where it is someone else's problem.
  reporter.emit(STEPS.VALIDATE, STATUS.STARTED);

  const shape = validateKit(kit);
  const semantics = verifySchedule(kit);

  // A must with no question at all is a coverage gap the loop already reported honestly,
  // not a scheduling fault — the kit says so in coverage.uncovered_requirement_ids. It
  // must not fail validation, or an honestly-degraded kit would become a failed case.
  const schedulingViolations = semantics.violations.filter(
    (violation) => violation.code !== SCHEDULE_VIOLATIONS.MUST_HAS_NO_QUESTION
  );

  if (!shape.valid || schedulingViolations.length > 0) {
    reporter.emit(STEPS.VALIDATE, STATUS.FAILED, {
      shapeErrors: shape.errors.length,
      scheduleViolations: schedulingViolations.length,
    });

    throw new BuildFailedError(
      'The assembled kit did not pass its own checks, so it was not returned.\n' +
        (shape.valid ? '' : `${formatValidationErrors(shape.errors)}\n`) +
        (schedulingViolations.length === 0 ? '' : formatScheduleViolations(schedulingViolations)),
      {
        code: 'BUILD_INVALID_KIT',
        shapeErrors: shape.errors,
        scheduleViolations: schedulingViolations,
      }
    );
  }

  const coverageViolations = semantics.violations.filter(
    (violation) => violation.code === SCHEDULE_VIOLATIONS.MUST_HAS_NO_QUESTION
  );
  if (coverageViolations.length > 0) {
    reporter.emit(STEPS.VALIDATE, STATUS.DEGRADED, { uncoveredMusts: coverageViolations.length });
  } else {
    reporter.emit(STEPS.VALIDATE, STATUS.DONE, {});
  }

  return {
    kit,
    validation: { shape, schedule: semantics },
    notes: state.notes,
    events: reporter.events(),
    budget: budget.report(),
    governor: governor.report(),
    state,
  };
}
