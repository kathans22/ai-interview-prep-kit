/**
 * coverageLoop.js — close the gaps a deterministic check found, then stop.
 *
 * Decides: how many times to try filling gaps, and when to accept what remains.
 *
 * Does NOT decide: what a gap IS. That is coverage.js — `findGaps` over id sets, a pure
 * function. This module never asks a model what is missing, because a model asked that
 * question will always find something and the loop would never terminate.
 *
 * WHY THE CAP IS THREE, AND WHAT EACH PASS IS FOR:
 *   pass 1  the draft. Questions come from the routed categories; some requirements get
 *           nothing, usually the ones that fell past a per-call batch cap or belonged to
 *           a category whose call failed.
 *   pass 2  the real work. These are genuine gaps with a named cause, and a gap-fill
 *           call aimed at exactly those requirements closes most of them.
 *   pass 3  the stubborn remainder — a requirement so oddly worded that the first
 *           gap-fill also produced nothing usable for it.
 *   beyond  the model begins restating what it already said, in slightly different
 *           words, while each attempt costs a request from a free tier whose daily
 *           ceiling is 20. Three is where the curve flattens and the cost does not.
 *
 * WHAT REMAINS AFTER THE CAP IS REPORTED, NOT HIDDEN. `coverage.uncovered_requirement_ids`
 * carries the survivors and `coverage.passes` records how many passes actually ran — not
 * the cap, not the intention. A kit that admits two uncovered nice-to-haves is honest; a
 * kit that quietly drops them so the number looks clean is not, and the candidate is the
 * one who discovers the gap in the interview.
 *
 * ONLY must-PRIORITY GAPS TRIGGER ANOTHER PASS. A missing nice-to-have is a noted
 * shortfall. Spending a call from a 12-call budget to cover one would take that call away
 * from a must, and must-recall is what the kit is judged on.
 */

import { findGaps } from '../deterministic/coverage.js';
import { fillGaps } from '../generation/fillGaps.js';
import { STEPS, STATUS } from './steps.js';

/**
 * Pass 1 is the draft, pass 2 closes real gaps, pass 3 catches the rare stubborn
 * requirement. Beyond three the model repeats itself while burning free-tier quota.
 */
export const MAX_COVERAGE_PASSES = 3;

/** Passes beyond this one are optional and the time governor may drop them. */
export const OPTIONAL_FROM_PASS = 3;

/**
 * Run the coverage loop.
 *
 * @param {object} options
 * @param {object[]} options.requirements
 * @param {object[]} options.questions mutated by appending, so ids stay stable
 * @param {object} options.deps
 * @param {object} options.reporter
 * @param {object} options.budget
 * @param {object} options.state
 * @param {{ isOverDeadline?: () => boolean }} [options.governor]
 * @returns {Promise<{
 *   questions: object[], uncovered: string[], uncoveredMust: string[],
 *   passes: number, notes: string[]
 * }>}
 */
export async function runCoverageLoop({
  requirements,
  questions,
  deps,
  reporter,
  budget,
  state,
  governor,
}) {
  const notes = [];
  let working = [...questions];
  let passes = 0;

  for (let pass = 1; pass <= MAX_COVERAGE_PASSES; pass += 1) {
    // The gap set is recomputed every pass from the questions as they now stand. This
    // is the loop's termination guarantee: ids either get covered or they do not, and
    // the set can only shrink.
    const gaps = findGaps(requirements, working);
    passes = pass;

    reporter.emit(STEPS.COVERAGE, STATUS.DONE, {
      pass,
      uncovered: gaps.uncovered_requirement_ids.length,
      uncoveredMust: gaps.uncovered_must_ids.length,
    });

    if (gaps.uncovered_must_ids.length === 0) {
      // Nice-to-have gaps may remain here, deliberately. They are recorded, not chased.
      if (gaps.uncovered_requirement_ids.length > 0) {
        notes.push(
          `${gaps.uncovered_requirement_ids.length} nice-to-have requirement(s) have no question. ` +
            'Blocking coverage is complete; these are recorded rather than chased, because a ' +
            'call spent here is a call taken from a must.'
        );
      }
      return {
        questions: working,
        uncovered: gaps.uncovered_requirement_ids,
        uncoveredMust: [],
        passes,
        notes,
      };
    }

    // A further pass is needed. Three reasons not to take it, each recorded honestly.
    if (pass === MAX_COVERAGE_PASSES) {
      notes.push(
        `${gaps.uncovered_must_ids.length} must-priority requirement(s) remain uncovered after ` +
          `${MAX_COVERAGE_PASSES} passes: ${gaps.uncovered_must_ids.join(', ')}. Reported rather ` +
          'than hidden; further passes produce restatements, not coverage.'
      );
      reporter.emit(STEPS.GAP_FILL, STATUS.SKIPPED, { reason: 'MAX_PASSES_REACHED', pass });
      return {
        questions: working,
        uncovered: gaps.uncovered_requirement_ids,
        uncoveredMust: gaps.uncovered_must_ids,
        passes,
        notes,
      };
    }

    if (pass + 1 >= OPTIONAL_FROM_PASS && governor?.isOverDeadline?.()) {
      notes.push(
        `The third coverage pass was skipped: the case deadline had passed and ` +
          `${gaps.uncovered_must_ids.length} must-priority gap(s) remain.`
      );
      reporter.emit(STEPS.GAP_FILL, STATUS.SKIPPED, { reason: 'TIME_GOVERNOR', pass: pass + 1 });
      return {
        questions: working,
        uncovered: gaps.uncovered_requirement_ids,
        uncoveredMust: gaps.uncovered_must_ids,
        passes,
        notes,
      };
    }

    if (!budget.canSpend(1)) {
      notes.push(
        `Gap filling stopped after pass ${pass}: the call budget is exhausted and ` +
          `${gaps.uncovered_must_ids.length} must-priority gap(s) remain.`
      );
      reporter.emit(STEPS.GAP_FILL, STATUS.SKIPPED, { reason: 'BUDGET_EXHAUSTED', pass });
      return {
        questions: working,
        uncovered: gaps.uncovered_requirement_ids,
        uncoveredMust: gaps.uncovered_must_ids,
        passes,
        notes,
      };
    }

    // --- fill exactly the gaps, and nothing else ----------------------------
    const uncoveredRequirements = requirements.filter((requirement) =>
      gaps.uncovered_must_ids.includes(requirement.id)
    );

    reporter.emit(STEPS.GAP_FILL, STATUS.STARTED, {
      pass: pass + 1,
      requirements: uncoveredRequirements.map((requirement) => requirement.id),
    });

    let filled;
    try {
      filled = await fillGaps(
        uncoveredRequirements,
        {
          roleContext: { ...state.roleProfile, whatTheyDo: state.companyBrief?.what_they_do ?? '' },
          hiringProcess: state.hiringProcess,
          existingIds: working.map((question) => question.id),
          // One call per pass: the loop, not the call, is what converges.
          maxCalls: 1,
        },
        { provider: deps.provider, spend: () => budget.spend(STEPS.GAP_FILL) }
      );
    } catch (error) {
      notes.push(`Gap fill on pass ${pass + 1} failed (${error.code ?? 'error'}): ${error.message}`);
      reporter.emit(STEPS.GAP_FILL, STATUS.FAILED, { pass: pass + 1, code: error.code });
      return {
        questions: working,
        uncovered: gaps.uncovered_requirement_ids,
        uncoveredMust: gaps.uncovered_must_ids,
        passes,
        notes,
      };
    }

    if (filled.questions.length === 0) {
      // A pass that produced nothing will not produce anything next time either: the
      // input and the prompt are identical. Stop rather than spend the rest of the cap.
      notes.push(
        `Gap fill on pass ${pass + 1} produced no usable questions; ` +
          `${gaps.uncovered_must_ids.length} must-priority gap(s) remain.`
      );
      reporter.emit(STEPS.GAP_FILL, STATUS.DEGRADED, { pass: pass + 1, produced: 0 });
      return {
        questions: working,
        uncovered: gaps.uncovered_requirement_ids,
        uncoveredMust: gaps.uncovered_must_ids,
        passes: pass + 1,
        notes,
      };
    }

    working = [...working, ...filled.questions];
    notes.push(...filled.notes);

    reporter.emit(STEPS.GAP_FILL, STATUS.DONE, {
      pass: pass + 1,
      produced: filled.questions.length,
      closed: uncoveredRequirements.length - filled.stillUncovered.length,
    });
  }

  // Unreachable: every branch above returns. Kept so a future edit that changes the loop
  // shape cannot fall through to an undefined result.
  const finalGaps = findGaps(requirements, working);
  return {
    questions: working,
    uncovered: finalGaps.uncovered_requirement_ids,
    uncoveredMust: finalGaps.uncovered_must_ids,
    passes,
    notes,
  };
}
