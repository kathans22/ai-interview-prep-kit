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
import { STEPS, STATUS, createReporter } from './steps.js';
import { researchFromJd, researchCompany, generateQuestions } from './research.js';
import { runCoverageLoop } from './coverageLoop.js';
import { assembleKit } from './assemble.js';
import { createTimeGovernor, DEFAULT_SOFT_DEADLINE_MS } from './timeGovernor.js';
import { generateFlashcards } from '../generation/generateFlashcards.js';

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
  const { jd, company_url: companyUrl, days, kitId = null } = input ?? {};

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

  // --- steps 3-7: the company. Everything here degrades. --------------------
  await researchCompany({ companyUrl, deps: resolved, reporter, budget, state, governor });

  // --- step 8: questions ----------------------------------------------------
  await generateQuestions({ deps: resolved, reporter, budget, state });

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
        { provider: resolved.provider, spend: () => budget.spend(STEPS.FLASHCARDS) }
      );
      state.flashcards = result.flashcards;
      reporter.emit(STEPS.FLASHCARDS, result.flashcards.length > 0 ? STATUS.DONE : STATUS.DEGRADED, {
        count: result.flashcards.length,
        rejected: result.rejected.length,
      });
      if (result.skipped) state.notes.push(result.skipped);
    } catch (error) {
      // Flashcards are the one piece of content the kit is explicitly complete without.
      state.notes.push(`Flashcard generation failed (${error.code ?? 'error'}); the kit has none.`);
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

  return {
    kit,
    notes: state.notes,
    events: reporter.events(),
    budget: budget.report(),
    governor: governor.report(),
    state,
  };
}
