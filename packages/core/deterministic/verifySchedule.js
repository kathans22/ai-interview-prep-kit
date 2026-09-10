/**
 * verifySchedule.js — re-asserts the allocator's SEMANTIC invariants against a finished
 * kit.
 *
 * Decides: whether a completed kit's schedule is internally coherent — the right number
 * of days, every must requirement reachable through a scheduled question, integer
 * minutes, no question left unscheduled, and harder material earlier.
 *
 * Does NOT decide: shape. validateKit answers "is this the contract?"; this module
 * answers "does this schedule make sense?". A kit can be perfectly shaped and still
 * schedule day 3 before day 1, drop half the questions, or never mention a must-have.
 *
 * WHY IT IS SEPARATE FROM THE ALLOCATOR. If the allocator were the only judge of its own
 * output, every allocator bug would be self-certifying — the same wrong assumption would
 * write the schedule and approve it. This module re-derives the properties from the
 * finished kit alone, importing nothing from scheduleAllocator, so the two can disagree.
 * The orchestrator runs validateKit AND verifySchedule; disagreement is a caught bug
 * rather than a shipped one.
 *
 * A kit assembled by hand, by an older version, or by a repaired LLM response is checked
 * exactly the same way — nothing here assumes the allocator produced the input, including
 * the optional `kind` field, which is used when present and re-derived when absent.
 *
 * Pure: no I/O, no model, no mutation of the input.
 */

/** Violation codes. A closed set; nothing invents a code inline. */
export const SCHEDULE_VIOLATIONS = Object.freeze({
  NOT_AN_OBJECT: 'SCHEDULE_NOT_AN_OBJECT',
  DAY_COUNT_MISMATCH: 'SCHEDULE_DAY_COUNT_MISMATCH',
  DAY_SEQUENCE_INVALID: 'SCHEDULE_DAY_SEQUENCE_INVALID',
  MINUTES_NOT_INTEGER: 'SCHEDULE_MINUTES_NOT_INTEGER',
  MINUTES_NEGATIVE: 'SCHEDULE_MINUTES_NEGATIVE',
  FOCUS_EMPTY: 'SCHEDULE_FOCUS_EMPTY',
  UNKNOWN_QUESTION_REF: 'SCHEDULE_UNKNOWN_QUESTION_REF',
  QUESTION_NOT_SCHEDULED: 'SCHEDULE_QUESTION_NOT_SCHEDULED',
  MUST_NOT_SCHEDULED: 'SCHEDULE_MUST_NOT_SCHEDULED',
  MUST_HAS_NO_QUESTION: 'SCHEDULE_MUST_HAS_NO_QUESTION',
  NOT_FRONT_LOADED: 'SCHEDULE_NOT_FRONT_LOADED',
  EMPTY_DAY_WITH_MATERIAL: 'SCHEDULE_EMPTY_DAY_WITH_MATERIAL',
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Which days present new material, as opposed to re-surfacing earlier questions.
 *
 * Uses the `kind` field when the producer supplied one, and otherwise re-derives it: a
 * day is review when it has ids and every one of them already appeared on an earlier day.
 * Re-deriving matters because front-loading is a claim about first encounters — a review
 * day deliberately brings hard material back late, and judging it as new material would
 * report a false violation.
 *
 * @param {Array<object>} days days in day-number order
 * @returns {boolean[]} parallel array, true where the day is new material
 */
function markNewMaterialDays(days) {
  const seen = new Set();
  return days.map((day) => {
    const ids = Array.isArray(day?.question_ids) ? day.question_ids : [];
    const declared = typeof day?.kind === 'string' ? day.kind : null;
    const allSeen = ids.length > 0 && ids.every((id) => seen.has(id));
    for (const id of ids) seen.add(id);

    if (declared === 'review') return false;
    if (declared === 'new') return true;
    return !allSeen;
  });
}

/**
 * Verify a finished kit's schedule.
 *
 * @param {object} kit a full kit; only role.requirements, questions and schedule are read
 * @returns {{ ok: boolean, violations: Array<{ code: string, path: string, message: string }> }}
 *   every violation found, in document order — like validateKit, it never stops at the
 *   first, because a caller fixing a schedule needs the whole picture.
 */
export function verifySchedule(kit) {
  const violations = [];
  const add = (code, path, message) => violations.push({ code, path, message });

  if (!isPlainObject(kit) || !isPlainObject(kit.schedule)) {
    add(
      SCHEDULE_VIOLATIONS.NOT_AN_OBJECT,
      'schedule',
      'The kit has no schedule object to verify.'
    );
    return { ok: false, violations };
  }

  const { schedule } = kit;
  const days = Array.isArray(schedule.days) ? schedule.days : [];
  const questions = Array.isArray(kit.questions) ? kit.questions : [];
  const requirements = Array.isArray(kit.role?.requirements) ? kit.role.requirements : [];

  const questionById = new Map();
  for (const question of questions) {
    if (typeof question?.id === 'string' && question.id !== '') questionById.set(question.id, question);
  }

  // --- day count and numbering -------------------------------------------------
  if (Number.isInteger(schedule.days_available) && days.length !== schedule.days_available) {
    add(
      SCHEDULE_VIOLATIONS.DAY_COUNT_MISMATCH,
      'schedule.days',
      `schedule.days has ${days.length} entries but days_available is ${schedule.days_available}.`
    );
  }

  const dayNumbers = days.map((day) => day?.day);
  const seenDays = new Set();
  dayNumbers.forEach((number, index) => {
    if (!Number.isInteger(number)) {
      add(
        SCHEDULE_VIOLATIONS.DAY_SEQUENCE_INVALID,
        `schedule.days[${index}].day`,
        `Day number must be an integer, got ${String(number)}.`
      );
      return;
    }
    if (seenDays.has(number)) {
      add(
        SCHEDULE_VIOLATIONS.DAY_SEQUENCE_INVALID,
        `schedule.days[${index}].day`,
        `Duplicate day number ${number}.`
      );
    }
    seenDays.add(number);
  });
  for (let expected = 1; expected <= days.length; expected += 1) {
    if (!seenDays.has(expected)) {
      add(
        SCHEDULE_VIOLATIONS.DAY_SEQUENCE_INVALID,
        'schedule.days',
        `Day ${expected} is missing; day numbers must run 1..${days.length} with no gaps.`
      );
    }
  }

  // --- per-day content ---------------------------------------------------------
  const scheduledIds = new Set();
  days.forEach((day, index) => {
    const path = `schedule.days[${index}]`;

    if (typeof day?.focus !== 'string' || day.focus.trim() === '') {
      add(
        SCHEDULE_VIOLATIONS.FOCUS_EMPTY,
        `${path}.focus`,
        'Every day needs a focus saying what it is for, including a day with no material.'
      );
    }

    if (!Number.isInteger(day?.minutes)) {
      add(
        SCHEDULE_VIOLATIONS.MINUTES_NOT_INTEGER,
        `${path}.minutes`,
        `Minutes must be an integer, got ${String(day?.minutes)}. Dividing total time by day count is the usual cause.`
      );
    } else if (day.minutes < 0) {
      add(SCHEDULE_VIOLATIONS.MINUTES_NEGATIVE, `${path}.minutes`, `Minutes cannot be negative.`);
    }

    const ids = Array.isArray(day?.question_ids) ? day.question_ids : [];
    ids.forEach((id, position) => {
      if (!questionById.has(id)) {
        add(
          SCHEDULE_VIOLATIONS.UNKNOWN_QUESTION_REF,
          `${path}.question_ids[${position}]`,
          `Day ${day?.day} references question "${id}", which is not in the kit.`
        );
        return;
      }
      scheduledIds.add(id);
    });

    if (ids.length === 0 && questionById.size > 0) {
      add(
        SCHEDULE_VIOLATIONS.EMPTY_DAY_WITH_MATERIAL,
        `${path}.question_ids`,
        `Day ${day?.day} is empty although the kit has ${questionById.size} question(s). A day with nothing on it is filler.`
      );
    }
  });

  // --- nothing dropped ---------------------------------------------------------
  for (const id of questionById.keys()) {
    if (!scheduledIds.has(id)) {
      add(
        SCHEDULE_VIOLATIONS.QUESTION_NOT_SCHEDULED,
        'schedule.days',
        `Question "${id}" exists in the kit but appears on no day.`
      );
    }
  }

  // --- must requirements are reachable ----------------------------------------
  const reachableRequirementIds = new Set();
  for (const id of scheduledIds) {
    const question = questionById.get(id);
    for (const requirementId of Array.isArray(question?.requirement_ids)
      ? question.requirement_ids
      : []) {
      reachableRequirementIds.add(requirementId);
    }
  }

  for (const requirement of requirements) {
    if (requirement?.priority !== 'must') continue;
    const requirementId = requirement?.id;
    if (typeof requirementId !== 'string' || requirementId === '') continue;

    const hasCoveringQuestion = questions.some((question) =>
      Array.isArray(question?.requirement_ids)
        ? question.requirement_ids.includes(requirementId)
        : false
    );

    if (!hasCoveringQuestion) {
      // A coverage gap, not a scheduling fault. It gets its own code so the orchestrator
      // can route it to the gap-fill pass instead of blaming the allocator.
      add(
        SCHEDULE_VIOLATIONS.MUST_HAS_NO_QUESTION,
        'coverage',
        `Must-priority requirement "${requirementId}" has no question at all; nothing can schedule it.`
      );
      continue;
    }

    if (!reachableRequirementIds.has(requirementId)) {
      add(
        SCHEDULE_VIOLATIONS.MUST_NOT_SCHEDULED,
        'schedule.days',
        `Must-priority requirement "${requirementId}" has a question, but no scheduled day reaches it.`
      );
    }
  }

  // --- front-loading -----------------------------------------------------------
  const inDayOrder = [...days].sort((left, right) => (left?.day ?? 0) - (right?.day ?? 0));
  const isNewMaterial = markNewMaterialDays(inDayOrder);
  const newMaterialDifficulty = inDayOrder
    .map((day, index) => {
      if (!isNewMaterial[index]) return null;
      const ids = Array.isArray(day?.question_ids) ? day.question_ids : [];
      const values = ids
        .map((id) => questionById.get(id)?.difficulty)
        .filter((value) => Number.isInteger(value));
      return values.length === 0 ? null : mean(values);
    })
    .filter((value) => value !== null);

  if (newMaterialDifficulty.length >= 2) {
    const half = Math.floor(newMaterialDifficulty.length / 2);
    const front = mean(newMaterialDifficulty.slice(0, half));
    const back = mean(newMaterialDifficulty.slice(half));
    // A tolerance, not a loophole: with few days per half, one easy question can tip an
    // otherwise correctly ordered schedule. A real inversion is much larger than this.
    if (front + 0.001 < back) {
      add(
        SCHEDULE_VIOLATIONS.NOT_FRONT_LOADED,
        'schedule.days',
        `Later days are harder than earlier ones (front half ${front.toFixed(2)}, back half ${back.toFixed(2)}). Harder material must land earlier.`
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

/** Render violations for logs and CLI output. */
export function formatScheduleViolations(violations) {
  if (violations.length === 0) return 'Schedule is consistent.';
  return violations
    .map(({ code, path, message }) => `  ${path}  [${code}]\n    ${message}`)
    .join('\n');
}
