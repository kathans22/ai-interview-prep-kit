/**
 * coverage.js — which requirements have a question, and which do not.
 *
 * Decides: the gap set. A requirement is covered when at least one question lists its id
 * in requirement_ids. That is the whole rule: id set arithmetic, nothing else. must-
 * priority gaps are reported separately because they are the blocking set — a missing
 * "nice" is a shortfall, a missing "must" is a hole in the deliverable.
 *
 * Does NOT decide: what to do about a gap (the orchestrator's coverage loop), whether a
 * question is any good, or whether its text actually addresses the requirement. There is
 * deliberately NO fuzzy matching here — no keyword overlap, no embedding similarity, no
 * asking a model "does this question cover this requirement?". Two reasons:
 *   1. It is a decision code can make exactly, so per Block A it must not reach a model.
 *   2. Fuzzy coverage is unfalsifiable. A gap loop driven by a similarity score can
 *      oscillate — generate, score 0.59, regenerate, score 0.61 — and burn the call
 *      budget without converging. Set membership terminates.
 * This is precisely why ids are stable and never renumbered.
 *
 * Pure: no I/O, no model, no mutation of the inputs.
 */

/**
 * @typedef {{ id?: string, priority?: string }} RequirementLike
 * @typedef {{ id?: string, requirement_ids?: string[] }} QuestionLike
 */

/**
 * Find coverage gaps.
 *
 * @param {RequirementLike[]} requirements
 * @param {QuestionLike[]} questions
 * @returns {{
 *   uncovered_requirement_ids: string[],
 *   uncovered_must_ids: string[],
 *   covered_map: Record<string, string[]>
 * }} covered_map maps every requirement id to the question ids covering it, in the order
 *   the questions appear. A covered requirement maps to a non-empty array; an uncovered
 *   one maps to an empty array, so the map always has one entry per requirement and a
 *   caller never has to distinguish "absent" from "uncovered".
 */
export function findGaps(requirements, questions) {
  const requirementList = Array.isArray(requirements) ? requirements : [];
  const questionList = Array.isArray(questions) ? questions : [];

  /** @type {Record<string, string[]>} */
  const coveredMap = {};
  /** Preserves requirement order for stable, diff-friendly output. */
  const order = [];
  /** @type {Set<string>} */
  const mustIds = new Set();

  for (const requirement of requirementList) {
    const id = requirement?.id;
    if (typeof id !== 'string' || id === '') continue;
    if (!(id in coveredMap)) {
      coveredMap[id] = [];
      order.push(id);
    }
    if (requirement?.priority === 'must') mustIds.add(id);
  }

  for (const question of questionList) {
    const questionId = question?.id;
    const referenced = Array.isArray(question?.requirement_ids) ? question.requirement_ids : [];

    for (const requirementId of referenced) {
      // A reference to a requirement that does not exist is a dangling id, which is
      // validateKit's business, not coverage's. It must not invent a covered entry.
      if (!(requirementId in coveredMap)) continue;
      if (typeof questionId !== 'string' || questionId === '') continue;
      if (!coveredMap[requirementId].includes(questionId)) {
        coveredMap[requirementId].push(questionId);
      }
    }
  }

  const uncovered = order.filter((id) => coveredMap[id].length === 0);

  return {
    uncovered_requirement_ids: uncovered,
    uncovered_must_ids: uncovered.filter((id) => mustIds.has(id)),
    covered_map: coveredMap,
  };
}

/**
 * Coverage as a ratio, for reporting and for deciding whether another pass is worth a
 * call from the budget.
 *
 * @param {RequirementLike[]} requirements
 * @param {QuestionLike[]} questions
 * @returns {{ total: number, covered: number, ratio: number, mustTotal: number,
 *   mustCovered: number, mustRatio: number }} ratios are 1 when there is nothing to
 *   cover — an empty requirement set is fully covered, not zero percent covered.
 */
export function coverageStats(requirements, questions) {
  const { covered_map: coveredMap, uncovered_must_ids: uncoveredMustIds } = findGaps(
    requirements,
    questions
  );

  const ids = Object.keys(coveredMap);
  const total = ids.length;
  const covered = ids.filter((id) => coveredMap[id].length > 0).length;

  const mustIds = (Array.isArray(requirements) ? requirements : [])
    .filter((requirement) => requirement?.priority === 'must')
    .map((requirement) => requirement?.id)
    .filter((id) => typeof id === 'string' && id in coveredMap);
  const mustTotal = new Set(mustIds).size;
  const mustCovered = mustTotal - uncoveredMustIds.length;

  return {
    total,
    covered,
    ratio: total === 0 ? 1 : covered / total,
    mustTotal,
    mustCovered,
    mustRatio: mustTotal === 0 ? 1 : mustCovered / mustTotal,
  };
}

/**
 * True when nothing blocking is missing. "nice" gaps do not block: a kit that covers
 * every must and misses one nice-to-have is a finished kit with a noted shortfall, and
 * spending another generation call on it is a poor use of a limited budget.
 *
 * @param {RequirementLike[]} requirements
 * @param {QuestionLike[]} questions
 */
export function isBlockingCoverageMet(requirements, questions) {
  return findGaps(requirements, questions).uncovered_must_ids.length === 0;
}
