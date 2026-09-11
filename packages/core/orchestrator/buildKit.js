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

import { createEmptyKit } from '../contracts/emptyKit.js';
import { createBudget } from '../llm/budget.js';
import { createSourceLedger } from '../retrieval/sourceLedger.js';
import { createPageCache } from '../retrieval/pageCache.js';
import { allocate } from '../deterministic/scheduleAllocator.js';
import { STEPS, STATUS, createReporter } from './steps.js';
import { researchFromJd, researchCompany, generateQuestions } from './research.js';
import { runCoverageLoop } from './coverageLoop.js';

/** Defaults matching Block C, overridable by the adapter's config. */
export const BUILD_DEFAULTS = Object.freeze({
  maxLlmCallsPerKit: 12,
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
  const budget = deps.budget ?? createBudget(deps.maxLlmCallsPerKit ?? BUILD_DEFAULTS.maxLlmCallsPerKit);
  const ledger = deps.ledger ?? createSourceLedger();
  const cache = deps.cache ?? createPageCache();

  const resolved = {
    ...BUILD_DEFAULTS,
    ...deps,
    budget,
    ledger,
    cache,
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
  await researchCompany({ companyUrl, deps: resolved, reporter, budget, state, governor: deps.governor });

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
    governor: deps.governor,
  });

  state.questions = coverage.questions;
  state.coveragePasses = coverage.passes;
  state.uncovered = coverage.uncovered;
  state.notes.push(...coverage.notes);

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
  const kit = createEmptyKit({
    daysAvailable: days,
    company: state.roleProfile.company,
    companyUrl: companyUrl ?? '',
    role: state.roleProfile.title,
    location: state.roleProfile.location,
    jdChars: jd.length,
  });

  kit.source.pages_used = ledger.pagesUsed();
  kit.company_brief = state.companyBrief;
  kit.role.title = state.roleProfile.title;
  kit.role.seniority = state.roleProfile.seniority;
  kit.role.responsibilities = state.roleProfile.responsibilities;
  kit.role.requirements = state.requirements;
  kit.questions = state.questions;
  kit.flashcards = state.flashcards;
  kit.schedule = schedule;
  // Reality, not intention: the passes that actually ran, and the gaps that actually
  // remain. Both are the kit telling the truth about itself.
  kit.coverage = {
    uncovered_requirement_ids: state.uncovered ?? [],
    passes: state.coveragePasses,
  };

  reporter.emit(STEPS.ASSEMBLE, STATUS.DONE, {
    requirements: kit.role.requirements.length,
    questions: kit.questions.length,
  });

  return {
    kit,
    notes: state.notes,
    events: reporter.events(),
    budget: budget.report(),
    state,
  };
}
