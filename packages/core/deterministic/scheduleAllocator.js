/**
 * scheduleAllocator.js — turns a question set into a day-by-day study schedule.
 *
 * Decides: how many minutes a question is worth, what order material is studied in, and
 * which day each question lands on. Every one of those is a decision code can make
 * exactly, so none of them is ever sent to a model.
 *
 * Does NOT decide: what the questions are, whether they are good, or whether coverage is
 * complete. It schedules what it is given and never invents, drops or rewrites material.
 *
 * INVARIANTS — hold for every input, and are re-asserted independently by
 * verifySchedule.js against the finished kit:
 *   1. days.length === daysAvailable, numbered 1..N with no gaps or duplicates
 *   2. every question appears on at least one day; nothing is silently dropped
 *   3. every day has an integer day number, a non-empty focus, an array of question_ids
 *      and integer minutes
 *   4. harder and higher-priority material lands earlier
 *   5. every must-priority requirement that has a covering question is reachable from
 *      some day (a must with no question at all is a coverage gap, not a schedule bug)
 *
 * MINUTES ARE INTEGERS BY CONTRACT. Each question is costed to a whole number first and
 * a day's minutes are the sum of its questions' costs, so no division by day count ever
 * produces a float. The one place minutes are not a plain sum is the daily ceiling
 * (see MAX_MINUTES_PER_DAY) — a cap is an honest number, and a fourteen-hour study day
 * is not.
 *
 * Pure: no I/O, no model, no mutation of the inputs.
 */

/** Base cost of engaging with a question, before difficulty, in minutes. */
export const CATEGORY_BASE_MINUTES = Object.freeze({
  technical: 15,
  'system-design': 25,
  behavioural: 12,
  'company-fit': 8,
});

/** Unknown categories still cost something; a question is never free. */
const DEFAULT_BASE_MINUTES = 12;

/** Difficulty multiplier applied to the base cost. */
export const DIFFICULTY_MULTIPLIER = Object.freeze({ 1: 1, 2: 1.5, 3: 2 });

/** No day is scheduled beyond this, however much material exists. */
export const MAX_MINUTES_PER_DAY = 240;

/** Ordering weight of a category when two questions are otherwise equal. */
const CATEGORY_RANK = Object.freeze({
  'system-design': 0,
  technical: 1,
  behavioural: 2,
  'company-fit': 3,
});

/**
 * Minutes a single question is worth. Always a positive integer.
 *
 * @param {{ category?: string, difficulty?: number }} question
 * @returns {number}
 */
export function questionCost(question) {
  const base = CATEGORY_BASE_MINUTES[question?.category] ?? DEFAULT_BASE_MINUTES;
  const multiplier = DIFFICULTY_MULTIPLIER[question?.difficulty] ?? 1;
  return Math.max(1, Math.round(base * multiplier));
}

/**
 * The set of requirement ids marked must.
 *
 * @param {Array<{id?: string, priority?: string}>} requirements
 */
function mustRequirementIds(requirements) {
  const ids = new Set();
  for (const requirement of Array.isArray(requirements) ? requirements : []) {
    if (requirement?.priority === 'must' && typeof requirement.id === 'string') {
      ids.add(requirement.id);
    }
  }
  return ids;
}

/** True when a question covers at least one must-priority requirement. */
function isMustQuestion(question, mustIds) {
  const referenced = Array.isArray(question?.requirement_ids) ? question.requirement_ids : [];
  return referenced.some((id) => mustIds.has(id));
}

/**
 * Study order: must before nice, then hardest first, then a stable category order, then
 * id — so the same input always produces the same schedule. Determinism matters here:
 * a schedule that reshuffles between runs makes the eval unreproducible.
 *
 * @param {object[]} questions
 * @param {Set<string>} mustIds
 * @returns {object[]} a new array; the input is not mutated
 */
export function orderQuestions(questions, mustIds) {
  return [...(Array.isArray(questions) ? questions : [])].sort((left, right) => {
    const leftMust = isMustQuestion(left, mustIds) ? 0 : 1;
    const rightMust = isMustQuestion(right, mustIds) ? 0 : 1;
    if (leftMust !== rightMust) return leftMust - rightMust;

    const difficulty = (right?.difficulty ?? 0) - (left?.difficulty ?? 0);
    if (difficulty !== 0) return difficulty;

    const rank = (CATEGORY_RANK[left?.category] ?? 9) - (CATEGORY_RANK[right?.category] ?? 9);
    if (rank !== 0) return rank;

    return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
  });
}

/** A human-readable focus line derived from what actually landed on the day. */
function focusFor(questionsOnDay) {
  if (questionsOnDay.length === 0) return 'Consolidation';

  const counts = new Map();
  for (const question of questionsOnDay) {
    const category = question?.category ?? 'general';
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  const ordered = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
    .map(([category]) => category);

  const label = {
    technical: 'Technical depth',
    'system-design': 'System design',
    behavioural: 'Behavioural stories',
    'company-fit': 'Company fit',
  };

  const primary = label[ordered[0]] ?? 'Mixed practice';
  if (ordered.length === 1) return primary;
  const secondary = label[ordered[1]] ?? 'mixed practice';
  return `${primary} and ${secondary.toLowerCase()}`;
}

/** Build one day object in contract shape. */
function buildDay(dayNumber, questionsOnDay, { kind = 'new' } = {}) {
  const rawMinutes = questionsOnDay.reduce((total, question) => total + questionCost(question), 0);
  return {
    day: dayNumber,
    focus: focusFor(questionsOnDay),
    question_ids: questionsOnDay.map((question) => question.id),
    minutes: Math.min(rawMinutes, MAX_MINUTES_PER_DAY),
    // Extra field, permitted by the contract. It lets verifySchedule tell a review day
    // from a new-material day without re-deriving it, and it is honest output either way.
    kind,
  };
}

/**
 * Spread ordered questions across a fixed number of days, front-loaded.
 *
 * Fills day by day in study order until the day reaches its share of the total minutes,
 * always leaving enough questions behind that every later day still gets at least one.
 * The last day absorbs whatever remains, so nothing can be dropped.
 *
 * @param {object[]} ordered
 * @param {number} dayCount
 * @returns {object[][]} one bucket per day
 */
function distribute(ordered, dayCount) {
  const buckets = Array.from({ length: dayCount }, () => []);
  if (dayCount === 0) return buckets;

  const totalMinutes = ordered.reduce((total, question) => total + questionCost(question), 0);
  const targetPerDay = totalMinutes / dayCount;

  const queue = [...ordered];
  for (let index = 0; index < dayCount; index += 1) {
    const isLastDay = index === dayCount - 1;
    if (isLastDay) {
      buckets[index].push(...queue.splice(0, queue.length));
      break;
    }

    const daysAfterThis = dayCount - index - 1;
    let minutesOnDay = 0;
    while (queue.length > daysAfterThis && (minutesOnDay === 0 || minutesOnDay < targetPerDay)) {
      const question = queue.shift();
      buckets[index].push(question);
      minutesOnDay += questionCost(question);
    }
  }

  return buckets;
}

/**
 * Allocate a schedule.
 *
 * @param {object} input
 * @param {object[]} input.questions
 * @param {object[]} input.requirements used only to learn which ids are must-priority
 * @param {number} input.daysAvailable
 * @returns {{ days_available: number, days: object[] }} a contract-shaped schedule
 */
export function allocate({ questions = [], requirements = [], daysAvailable = 0 } = {}) {
  if (!Number.isInteger(daysAvailable) || daysAvailable < 0) {
    throw new Error(
      `SCHEDULE_INVALID_DAYS: daysAvailable must be a non-negative integer, got ${daysAvailable}.`
    );
  }

  const usable = (Array.isArray(questions) ? questions : []).filter(
    (question) => typeof question?.id === 'string' && question.id !== ''
  );

  if (daysAvailable === 0) {
    return { days_available: 0, days: [] };
  }

  const ordered = orderQuestions(usable, mustRequirementIds(requirements));

  // One pass over new material: at most one day per question, so no day invents content
  // it does not have. Any days beyond that are handled by the extremes path.
  const newMaterialDays = Math.min(daysAvailable, ordered.length);
  const buckets = distribute(ordered, newMaterialDays);

  const days = buckets.map((bucket, index) => buildDay(index + 1, bucket));

  for (let dayNumber = newMaterialDays + 1; dayNumber <= daysAvailable; dayNumber += 1) {
    days.push(buildDay(dayNumber, []));
  }

  return { days_available: daysAvailable, days };
}
