/**
 * routeCategories.js — which question categories a requirement deserves.
 *
 * Decides: the mapping from one requirement (plus the company's known hiring process)
 * to a set of question categories.
 *
 * Does NOT decide: the questions themselves, how many to generate, or what order they
 * are studied in. It answers "what kinds of question would test this?" and stops.
 *
 * NO MODEL. THIS IS THE POINT OF THE MODULE. Category routing is a rule a person can
 * write down — five years of React deserves technical and system-design questions;
 * mentoring juniors deserves behavioural ones — so per Block A it must not be sent to
 * a model. Three concrete reasons beyond the rule:
 *   - It is free. Routing 15 requirements through a model would be a call per kit at
 *     best, against a 12-call ceiling, for an answer code already knows.
 *   - It is stable. The Stage 6 eval compares runs; a router that answers differently
 *     on a Tuesday makes every comparison noise.
 *   - It is testable. "Does mentoring route to behavioural?" is an assertion, not an
 *     impression.
 *
 * THE HIRING PROCESS CHANGES THE ANSWER, and that is what makes finding the hiring page
 * worth the crawl. A company that runs a system-design round should produce
 * system-design questions for requirements that can carry them, even where the wording
 * alone would not have justified it; a company that runs a values round earns
 * company-fit questions it would not otherwise get. The exit check for this stage is
 * exactly this: the same requirements, a different process, a different category mix.
 *
 * Pure: no I/O, no model, no mutation of its inputs.
 */

import { QUESTION_CATEGORIES } from '../contracts/kitSchema.js';

/**
 * Signals that a requirement is worth a system-design question.
 *
 * Scale, distribution and failure words — the things a design conversation is actually
 * about. Kept as word stems so "architecture", "architected" and "architectural" all
 * hit without a stemmer.
 */
const SYSTEM_DESIGN_SIGNALS = [
  'architect', 'design', 'scale', 'scaling', 'scalab', 'distributed', 'concurren',
  'throughput', 'latency', 'performance', 'real-time', 'realtime', 'streaming',
  'queue', 'event', 'pipeline', 'infrastructure', 'platform', 'microservice',
  'resilien', 'reliability', 'availability', 'failover', 'caching', 'load',
  'database schema', 'data model', 'api design', 'own the', 'ownership of',
];

/** Words that mark a requirement as being about working with people. */
const BEHAVIOURAL_SIGNALS = [
  'mentor', 'coach', 'lead', 'leading', 'leadership', 'collaborat', 'communicat',
  'stakeholder', 'cross-functional', 'team', 'pair', 'review', 'feedback', 'conflict',
  'ownership', 'autonom', 'written', 'documentation', 'onboard', 'hiring', 'interview',
];

/** Words that mark a requirement as being about this company specifically. */
const COMPANY_FIT_SIGNALS = [
  'domain', 'industry', 'regulat', 'compliance', 'customer', 'user research',
  'mission', 'values', 'startup', 'remote', 'culture',
];

/** Seniority levels that justify a design conversation regardless of wording. */
const SENIOR_LEVELS = ['senior', 'staff', 'principal', 'lead', 'head', 'director'];

function hasSignal(text, signals) {
  const haystack = String(text ?? '').toLowerCase();
  return signals.some((signal) => haystack.includes(signal));
}

/**
 * Route one requirement to its categories.
 *
 * @param {{ text?: string, kind?: string, priority?: string }} requirement
 * @param {{ kinds?: string[], stages?: Array<{kind: string}> }|null} [hiringProcess]
 * @param {{ seniority?: string }} [roleContext]
 * @returns {{ categories: string[], reasons: Record<string, string[]> }} `reasons`
 *   records why each category was chosen, so a routing decision can be explained in a
 *   test failure rather than merely observed.
 */
export function routeCategories(requirement, hiringProcess = null, roleContext = {}) {
  const text = String(requirement?.text ?? '');
  const kind = String(requirement?.kind ?? '');
  const seniority = String(roleContext?.seniority ?? '').toLowerCase();

  const processKinds = new Set(
    hiringProcess?.kinds ??
      (Array.isArray(hiringProcess?.stages) ? hiringProcess.stages.map((stage) => stage.kind) : [])
  );

  /** @type {Map<string, string[]>} category -> reasons */
  const chosen = new Map();
  const add = (category, reason) => {
    if (!QUESTION_CATEGORIES.includes(category)) return;
    if (!chosen.has(category)) chosen.set(category, []);
    chosen.get(category).push(reason);
  };

  // --- from the requirement's own kind ---------------------------------------
  if (kind === 'technical') add('technical', 'requirement kind is technical');
  if (kind === 'behavioural') add('behavioural', 'requirement kind is behavioural');
  if (kind === 'domain') {
    add('company-fit', 'domain requirements test fit with this company\'s subject matter');
    add('technical', 'domain knowledge is still examined technically');
  }

  // --- from the wording ------------------------------------------------------
  if (hasSignal(text, SYSTEM_DESIGN_SIGNALS)) {
    add('system-design', 'wording mentions scale, ownership or architecture');
  }
  if (hasSignal(text, BEHAVIOURAL_SIGNALS)) {
    add('behavioural', 'wording mentions working with other people');
  }
  if (hasSignal(text, COMPANY_FIT_SIGNALS)) {
    add('company-fit', 'wording mentions domain, values or ways of working');
  }

  // --- from seniority --------------------------------------------------------
  // A senior technical requirement earns a design conversation even when the posting
  // words it plainly: "React" for a staff engineer is not the same question as "React"
  // for a junior, and the difference is a design discussion.
  if (kind === 'technical' && SENIOR_LEVELS.some((level) => seniority.includes(level))) {
    add('system-design', `seniority "${seniority}" implies design-level questioning`);
  }

  // --- from the company's actual process -------------------------------------
  // This is the part that pays for the crawl.
  if (processKinds.has('system-design') && (kind === 'technical' || kind === 'domain')) {
    add('system-design', 'the company runs a system-design round');
  }
  if (processKinds.has('take-home') && kind === 'technical') {
    add('technical', 'the company sets a take-home, so depth on this is tested directly');
  }
  if (processKinds.has('values') || processKinds.has('behavioural')) {
    add('behavioural', 'the company runs a values or behavioural round');
  }
  if (processKinds.has('values')) {
    add('company-fit', 'the company runs a values round');
  }
  if (processKinds.has('presentation') || processKinds.has('panel')) {
    add('behavioural', 'the company runs a panel or presentation, which tests communication');
  }

  // --- fallback --------------------------------------------------------------
  // Every requirement gets at least one category. A requirement with no question is a
  // coverage gap by construction, and the gap-fill pass would then spend a call
  // correcting something the router could have avoided.
  if (chosen.size === 0) add('technical', 'no stronger signal; technical is the default');

  const categories = QUESTION_CATEGORIES.filter((category) => chosen.has(category));
  const reasons = Object.fromEntries([...chosen.entries()]);

  return { categories, reasons };
}

/**
 * Route a whole requirement set, grouped for the batched generation call.
 *
 * @param {object[]} requirements
 * @param {object|null} hiringProcess
 * @param {{ seniority?: string }} [roleContext]
 * @returns {{
 *   byCategory: Record<string, object[]>,
 *   byRequirement: Record<string, string[]>,
 *   distribution: Record<string, number>
 * }} `byCategory` is what generateQuestionsForCategory consumes; `distribution` is what
 *   the sequencing proof compares.
 */
export function routeAll(requirements = [], hiringProcess = null, roleContext = {}) {
  const byCategory = Object.fromEntries(QUESTION_CATEGORIES.map((category) => [category, []]));
  const byRequirement = {};

  for (const requirement of Array.isArray(requirements) ? requirements : []) {
    if (!requirement || typeof requirement.id !== 'string') continue;
    const { categories } = routeCategories(requirement, hiringProcess, roleContext);
    byRequirement[requirement.id] = categories;
    for (const category of categories) byCategory[category].push(requirement);
  }

  const distribution = Object.fromEntries(
    QUESTION_CATEGORIES.map((category) => [category, byCategory[category].length])
  );

  return { byCategory, byRequirement, distribution };
}
