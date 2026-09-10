/**
 * fillGaps.js — questions for the requirements that ended up with none.
 *
 * Decides: what to ask about a specific list of uncovered requirements.
 *
 * Does NOT decide: WHICH requirements are uncovered. That is coverage.js, a pure
 * function over id sets, and this module never sees the whole kit.
 *
 * THE NARROW INPUT IS THE DESIGN, NOT AN OVERSIGHT. It would be easy to hand this step
 * the finished kit and ask "what is missing?" — and it would be wrong three ways:
 *   - The model would be answering a question code already answers exactly. Coverage
 *     is set membership: a requirement is covered when a question lists its id. There
 *     is nothing to judge, so per Block A it must not be judged by a model.
 *   - A model asked what is missing will find something. Every pass would report gaps,
 *     the loop would never converge, and the call budget would drain into rounds of
 *     agreeable self-criticism.
 *   - It would see questions it did not write and could rewrite them. This step only
 *     ADDS; nothing it returns can modify or replace an existing question.
 *
 * So the contract is deliberately thin: here are N requirements with no question, in a
 * category each, write questions for exactly those. The deterministic checker decides
 * when to stop calling it.
 */

import { QUESTION_CATEGORIES } from '../contracts/kitSchema.js';
import { routeCategories } from './routeCategories.js';
import { generateQuestionsForCategory } from './generateQuestions.js';
import { badInput } from './errors.js';

const STEP = 'gap-fill';

/**
 * The one category an uncovered requirement most deserves.
 *
 * Taking `categories[0]` would look reasonable and be wrong: routeCategories returns
 * them in contract order (technical, behavioural, system-design, company-fit), so
 * "first" means "technical" for almost everything, and the gap pass would answer every
 * shortfall with a technical question — including domain requirements, where a
 * company-fit question is the point.
 *
 * The requirement's own kind is the honest signal, and it is the one a person would
 * use: a technical requirement wants a technical question, a behavioural one wants a
 * behavioural question, and a domain one is about whether the candidate fits this
 * company's subject matter. The routed set is the fallback for anything unlabelled.
 */
function primaryCategoryFor(requirement, routed) {
  const byKind = { technical: 'technical', behavioural: 'behavioural', domain: 'company-fit' };
  const preferred = byKind[requirement?.kind];

  if (preferred && routed.includes(preferred)) return preferred;
  return routed[0] ?? 'technical';
}

/**
 * Generate questions for uncovered requirements.
 *
 * Groups the gaps by category so one call can cover several — the same batching rule
 * as the normal path, for the same budget reason. A gap-fill pass that spent one call
 * per uncovered requirement would exhaust the budget precisely when the budget is
 * already under pressure, which is the only time this step runs.
 *
 * @param {object[]} uncoveredRequirements the requirements coverage.js flagged, and
 *   nothing else
 * @param {object} context
 * @param {object} [context.roleContext]
 * @param {object|null} [context.hiringProcess]
 * @param {string[]} [context.existingIds] question ids in use, so new ids continue
 * @param {number} [context.maxCalls=2] hard ceiling on calls this pass may spend
 * @param {object} options
 * @param {{ complete: Function }} options.provider
 * @param {() => void} [options.spend]
 * @returns {Promise<{
 *   questions: object[], attemptedCategories: string[], stillUncovered: string[],
 *   callsUsed: number, notes: string[]
 * }>}
 */
export async function fillGaps(
  uncoveredRequirements = [],
  { roleContext = {}, hiringProcess = null, existingIds = [], maxCalls = 2 } = {},
  { provider, spend, onRepair } = {}
) {
  const gaps = (Array.isArray(uncoveredRequirements) ? uncoveredRequirements : []).filter(
    (requirement) =>
      requirement && typeof requirement.id === 'string' && String(requirement.text ?? '').trim() !== ''
  );

  if (gaps.length === 0) {
    return { questions: [], attemptedCategories: [], stillUncovered: [], callsUsed: 0, notes: [] };
  }

  if (!provider || typeof provider.complete !== 'function') {
    throw badInput(STEP, 'A provider is required.');
  }

  // One category per requirement: the gap pass is about coverage, not breadth. Giving
  // an uncovered requirement its single best category costs one question where the
  // normal path might have written four.
  const byCategory = new Map();
  for (const requirement of gaps) {
    const { categories } = routeCategories(requirement, hiringProcess, roleContext);
    const primary = primaryCategoryFor(requirement, categories);
    if (!byCategory.has(primary)) byCategory.set(primary, []);
    byCategory.get(primary).push(requirement);
  }

  // Largest groups first: with a call ceiling, the call that covers four requirements
  // is worth more than the one that covers one.
  const ordered = [...byCategory.entries()]
    .filter(([category]) => QUESTION_CATEGORIES.includes(category))
    .sort((left, right) => right[1].length - left[1].length);

  const questions = [];
  const attemptedCategories = [];
  const notes = [];
  const covered = new Set();
  const idsInUse = [...existingIds];
  let callsUsed = 0;

  for (const [category, requirements] of ordered) {
    if (callsUsed >= maxCalls) {
      notes.push(
        `Stopped after ${callsUsed} call(s): ${requirements.length} requirement(s) in ` +
          `"${category}" were left for a later pass rather than exceeding the gap-fill ceiling.`
      );
      break;
    }

    let result;
    try {
      result = await generateQuestionsForCategory(
        { category, requirements, roleContext, hiringProcess, existingIds: idsInUse },
        { provider, spend, onRepair }
      );
    } catch (cause) {
      // A failed gap-fill leaves the gap. It must never fail the case — an uncovered
      // requirement is a recorded shortfall, not a broken kit.
      notes.push(`The "${category}" gap-fill call failed (${cause.code ?? 'unknown'}): ${cause.message}`);
      callsUsed += 1;
      attemptedCategories.push(category);
      continue;
    }

    callsUsed += 1;
    attemptedCategories.push(category);
    questions.push(...result.questions);
    idsInUse.push(...result.questions.map((question) => question.id));

    for (const question of result.questions) {
      for (const requirementId of question.requirement_ids) covered.add(requirementId);
    }
    if (result.deferred.length > 0) {
      notes.push(
        `${result.deferred.length} "${category}" requirement(s) exceeded the per-call batch size.`
      );
    }
  }

  const stillUncovered = gaps
    .map((requirement) => requirement.id)
    .filter((id) => !covered.has(id));

  return { questions, attemptedCategories, stillUncovered, callsUsed, notes };
}
