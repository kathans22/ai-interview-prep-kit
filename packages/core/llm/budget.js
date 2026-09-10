/**
 * budget.js — how many model calls one kit is allowed.
 *
 * Decides: whether the next call may be made, and what was spent on what.
 *
 * Does NOT decide: the rate those calls go out at (limiter.js — a different question:
 * the limiter protects the free tier across the whole process, this protects one kit
 * from running away), nor what to do when the budget is gone (the orchestrator catches
 * BUDGET_EXHAUSTED and degrades).
 *
 * THE NORMAL PATH IS ELEVEN CALLS, THE CEILING IS TWELVE:
 *    1  extract requirements        1  extract role profile
 *    1  confirm hiring page         1  extract hiring process (only if a page was found)
 *    1  company brief               4  questions, one per category
 *    1  flashcards                  1  gap fill (second pass)
 *   = 11, with the twelfth reserved for an optional third coverage pass.
 * Building the counter to "12 normal" would silently permit one extra call per kit —
 * five per batch run, against a daily ceiling that is the binding constraint.
 *
 * REPAIRS SPEND. A repair re-prompt is a request like any other: it consumes RPD, it
 * consumes tokens, and it takes time from the 150s case deadline. Excluding repairs
 * would make the budget describe an idealised run rather than the real one, and the
 * failure mode — a repair loop quietly doubling every step — is exactly what a budget
 * exists to catch.
 *
 * Pure bookkeeping: no I/O, no clock, no model.
 */

/** Thrown when a kit asks for more calls than it may have. */
export class BudgetExhaustedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BudgetExhaustedError';
    this.code = 'BUDGET_EXHAUSTED';
    this.details = details;
  }
}

/** The call budget for one kit, per Block C. */
export const DEFAULT_MAX_CALLS_PER_KIT = 12;

/** What the normal path is expected to spend, for reporting against the ceiling. */
export const EXPECTED_NORMAL_PATH_CALLS = 11;

/**
 * Create a budget for one kit.
 *
 * @param {number} [maxCalls]
 * @param {{ onSpend?: (event: object) => void }} [options] onSpend fires for every unit
 *   spent. Core does not log; this is how the adapter sees the burn rate.
 * @returns {{
 *   spend: (label?: string) => number,
 *   canSpend: (units?: number) => boolean,
 *   remaining: () => number,
 *   spent: () => number,
 *   report: () => object
 * }}
 */
export function createBudget(maxCalls = DEFAULT_MAX_CALLS_PER_KIT, { onSpend } = {}) {
  if (!Number.isInteger(maxCalls) || maxCalls < 0) {
    throw new BudgetExhaustedError(
      `BUDGET_INVALID: maxCalls must be a non-negative integer, got ${maxCalls}.`,
      { maxCalls }
    );
  }

  let used = 0;
  /** @type {Map<string, number>} calls per step label, for the post-run report */
  const perLabel = new Map();

  /**
   * Spend one unit.
   *
   * @param {string} [label] the step spending it, e.g. "questions:technical" or
   *   "company-brief:repair"
   * @returns {number} units remaining after the spend
   * @throws {BudgetExhaustedError}
   */
  function spend(label = 'unlabelled') {
    if (used >= maxCalls) {
      throw new BudgetExhaustedError(
        `Call budget exhausted: ${used}/${maxCalls} model calls already spent, and ` +
          `"${label}" wanted another. Assemble the kit with what exists rather than ` +
          'continuing — a partial kit is "ok" with recorded gaps, not a failure.',
        { label, maxCalls, spent: used, breakdown: Object.fromEntries(perLabel) }
      );
    }

    used += 1;
    perLabel.set(label, (perLabel.get(label) ?? 0) + 1);

    if (typeof onSpend === 'function') {
      onSpend({ label, spent: used, remaining: maxCalls - used, maxCalls });
    }

    return maxCalls - used;
  }

  /** Would `units` more calls fit? Lets a caller skip an optional step before starting it. */
  function canSpend(units = 1) {
    return used + units <= maxCalls;
  }

  function remaining() {
    return maxCalls - used;
  }

  function spent() {
    return used;
  }

  /** A post-run summary: what was spent, on what, and whether it beat the normal path. */
  function report() {
    const breakdown = Object.fromEntries([...perLabel.entries()].sort());
    const repairs = [...perLabel.entries()]
      .filter(([label]) => label.includes('repair'))
      .reduce((total, [, count]) => total + count, 0);

    return {
      maxCalls,
      spent: used,
      remaining: maxCalls - used,
      repairs,
      overNormalPath: Math.max(0, used - EXPECTED_NORMAL_PATH_CALLS),
      breakdown,
    };
  }

  return { spend, canSpend, remaining, spent, report };
}

/**
 * A budget that never refuses, for the fake provider and for tests that are not about
 * budgeting. Named so its use is obvious in a diff — a real run must never take this.
 */
export function createUnlimitedBudget() {
  let used = 0;
  return {
    spend: () => {
      used += 1;
      return Number.POSITIVE_INFINITY;
    },
    canSpend: () => true,
    remaining: () => Number.POSITIVE_INFINITY,
    spent: () => used,
    report: () => ({ maxCalls: Infinity, spent: used, remaining: Infinity, unlimited: true }),
  };
}
