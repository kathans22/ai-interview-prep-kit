/**
 * validateKit.js — structural validation of a kit against the frozen contract.
 *
 * Decides: whether a kit is shaped correctly — every required key present, every enum
 * spelled exactly, every number the right kind of number, every id reference resolving
 * to something that exists, and the schedule internally consistent.
 *
 * Does NOT decide: whether a kit is any GOOD. Coverage quality, question relevance,
 * evidence strength and schedule sensibility are judged elsewhere, by the deterministic
 * modules. A kit full of empty strings is structurally valid and that is intentional —
 * it is how a degraded run stays "ok" instead of "failed".
 *
 * It reports EVERY error, never just the first. A caller repairing generated output
 * needs the whole list; returning one error per run turns repair into a guessing game
 * and, with retries counted against the LLM call budget, an expensive one.
 *
 * Pure: no I/O, no model, no database, no mutation of the kit passed in.
 */

import {
  REQUIREMENT_KINDS,
  REQUIREMENT_PRIORITIES,
  QUESTION_CATEGORIES,
  DIFFICULTY_RANGE,
  KIT_TOP_LEVEL_KEYS,
  KIT_SECTION_KEYS,
  ID_PREFIXES,
} from './kitSchema.js';
import { isValidId } from './ids.js';

/** Error codes this module can emit. A closed set — nothing invents a code inline. */
export const VALIDATION_CODES = Object.freeze({
  NOT_AN_OBJECT: 'KIT_NOT_AN_OBJECT',
  MISSING_KEY: 'KIT_MISSING_KEY',
  WRONG_TYPE: 'KIT_WRONG_TYPE',
  ENUM_INVALID: 'KIT_ENUM_INVALID',
  NOT_AN_INTEGER: 'KIT_NOT_AN_INTEGER',
  OUT_OF_RANGE: 'KIT_OUT_OF_RANGE',
  ID_MALFORMED: 'KIT_ID_MALFORMED',
  ID_DUPLICATE: 'KIT_ID_DUPLICATE',
  UNKNOWN_REQUIREMENT_REF: 'KIT_UNKNOWN_REQUIREMENT_REF',
  UNKNOWN_QUESTION_REF: 'KIT_UNKNOWN_QUESTION_REF',
  SCHEDULE_LENGTH_MISMATCH: 'KIT_SCHEDULE_LENGTH_MISMATCH',
  DAY_SEQUENCE_INVALID: 'KIT_DAY_SEQUENCE_INVALID',
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collects errors so every check can run without short-circuiting the rest. */
function createReport() {
  const errors = [];
  return {
    errors,
    add(path, code, message) {
      errors.push({ path, code, message });
    },
  };
}

function checkKeys(report, container, keys, basePath) {
  for (const key of keys) {
    if (!(key in container)) {
      report.add(
        basePath ? `${basePath}.${key}` : key,
        VALIDATION_CODES.MISSING_KEY,
        `Required key "${key}" is missing.`
      );
    }
  }
}

function checkString(report, value, path) {
  if (typeof value !== 'string') {
    report.add(path, VALIDATION_CODES.WRONG_TYPE, `Expected a string, got ${describe(value)}.`);
    return false;
  }
  return true;
}

function checkArray(report, value, path) {
  if (!Array.isArray(value)) {
    report.add(path, VALIDATION_CODES.WRONG_TYPE, `Expected an array, got ${describe(value)}.`);
    return false;
  }
  return true;
}

function checkStringArray(report, value, path) {
  if (!checkArray(report, value, path)) return false;
  let ok = true;
  value.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      report.add(
        `${path}[${index}]`,
        VALIDATION_CODES.WRONG_TYPE,
        `Expected a string, got ${describe(entry)}.`
      );
      ok = false;
    }
  });
  return ok;
}

function checkInteger(report, value, path, { min, max } = {}) {
  if (!Number.isInteger(value)) {
    report.add(
      path,
      VALIDATION_CODES.NOT_AN_INTEGER,
      `Expected an integer, got ${describe(value)}. Floats and numeric strings are not accepted.`
    );
    return false;
  }
  if (min !== undefined && value < min) {
    report.add(path, VALIDATION_CODES.OUT_OF_RANGE, `Expected >= ${min}, got ${value}.`);
    return false;
  }
  if (max !== undefined && value > max) {
    report.add(path, VALIDATION_CODES.OUT_OF_RANGE, `Expected <= ${max}, got ${value}.`);
    return false;
  }
  return true;
}

function checkEnum(report, value, path, allowed) {
  if (allowed.includes(value)) return true;

  const hint = nearMissHint(value, allowed);
  report.add(
    path,
    VALIDATION_CODES.ENUM_INVALID,
    `Expected one of ${allowed.map((entry) => `"${entry}"`).join(' | ')}, got ${describe(value)}.${hint}`
  );
  return false;
}

/**
 * Enum failures here are usually an Americanised spelling or an underscored compound,
 * which are hard to spot by eye in a diff. Naming the near miss makes the repair obvious.
 */
function nearMissHint(value, allowed) {
  if (typeof value !== 'string') return '';
  const normalised = value.toLowerCase().replace(/[_\s]+/g, '-');
  const match = allowed.find(
    (entry) => entry === normalised || entry.replace(/behavioural/, 'behavioral') === normalised
  );
  return match ? ` Did you mean "${match}"? The contract spelling is exact.` : '';
}

function describe(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `"${value}"`;
  return `${typeof value} ${String(value)}`;
}

function checkIdList(report, ids, path, { known, code, label }) {
  if (!checkStringArray(report, ids, path)) return;
  ids.forEach((id, index) => {
    if (typeof id !== 'string') return;
    if (!known.has(id)) {
      report.add(
        `${path}[${index}]`,
        code,
        `References ${label} "${id}", which does not exist in this kit.`
      );
    }
  });
}

function validateSource(report, source) {
  if (!isPlainObject(source)) {
    report.add('source', VALIDATION_CODES.WRONG_TYPE, `Expected an object, got ${describe(source)}.`);
    return;
  }
  checkKeys(report, source, KIT_SECTION_KEYS.source, 'source');

  if ('company' in source) checkString(report, source.company, 'source.company');
  if ('company_url' in source) checkString(report, source.company_url, 'source.company_url');
  // source.role is the advertised role STRING — a different field from the role object.
  if ('role' in source) checkString(report, source.role, 'source.role');
  if ('location' in source) checkString(report, source.location, 'source.location');
  if ('researched_at' in source) checkString(report, source.researched_at, 'source.researched_at');
  if ('jd_chars' in source) checkInteger(report, source.jd_chars, 'source.jd_chars', { min: 0 });
  if ('pages_used' in source) checkStringArray(report, source.pages_used, 'source.pages_used');
}

function validateCompanyBrief(report, brief) {
  if (!isPlainObject(brief)) {
    report.add(
      'company_brief',
      VALIDATION_CODES.WRONG_TYPE,
      `Expected an object, got ${describe(brief)}.`
    );
    return;
  }
  checkKeys(report, brief, KIT_SECTION_KEYS.company_brief, 'company_brief');

  if ('summary' in brief) checkString(report, brief.summary, 'company_brief.summary');
  if ('what_they_do' in brief) checkString(report, brief.what_they_do, 'company_brief.what_they_do');
  if ('sources' in brief) checkStringArray(report, brief.sources, 'company_brief.sources');
}

/** @returns {Set<string>} the requirement ids that actually exist */
function validateRole(report, role) {
  const requirementIds = new Set();

  if (!isPlainObject(role)) {
    report.add('role', VALIDATION_CODES.WRONG_TYPE, `Expected an object, got ${describe(role)}.`);
    return requirementIds;
  }
  checkKeys(report, role, KIT_SECTION_KEYS.role, 'role');

  if ('title' in role) checkString(report, role.title, 'role.title');
  if ('seniority' in role) checkString(report, role.seniority, 'role.seniority');
  if ('responsibilities' in role) {
    checkStringArray(report, role.responsibilities, 'role.responsibilities');
  }

  if (!('requirements' in role)) return requirementIds;
  if (!checkArray(report, role.requirements, 'role.requirements')) return requirementIds;

  const seen = new Set();
  role.requirements.forEach((requirement, index) => {
    const path = `role.requirements[${index}]`;
    if (!isPlainObject(requirement)) {
      report.add(path, VALIDATION_CODES.WRONG_TYPE, `Expected an object, got ${describe(requirement)}.`);
      return;
    }
    checkKeys(report, requirement, KIT_SECTION_KEYS.requirement, path);

    if ('id' in requirement) {
      if (!isValidId(requirement.id, ID_PREFIXES.requirement)) {
        report.add(
          `${path}.id`,
          VALIDATION_CODES.ID_MALFORMED,
          `Expected an id like "${ID_PREFIXES.requirement}1", got ${describe(requirement.id)}.`
        );
      } else if (seen.has(requirement.id)) {
        report.add(
          `${path}.id`,
          VALIDATION_CODES.ID_DUPLICATE,
          `Duplicate requirement id "${requirement.id}".`
        );
      } else {
        seen.add(requirement.id);
        requirementIds.add(requirement.id);
      }
    }

    if ('text' in requirement) checkString(report, requirement.text, `${path}.text`);
    if ('kind' in requirement) checkEnum(report, requirement.kind, `${path}.kind`, REQUIREMENT_KINDS);
    if ('priority' in requirement) {
      checkEnum(report, requirement.priority, `${path}.priority`, REQUIREMENT_PRIORITIES);
    }
  });

  return requirementIds;
}

/** @returns {Set<string>} the question ids that actually exist */
function validateQuestions(report, questions, requirementIds) {
  const questionIds = new Set();

  if (!checkArray(report, questions, 'questions')) return questionIds;

  const seen = new Set();
  questions.forEach((question, index) => {
    const path = `questions[${index}]`;
    if (!isPlainObject(question)) {
      report.add(path, VALIDATION_CODES.WRONG_TYPE, `Expected an object, got ${describe(question)}.`);
      return;
    }
    checkKeys(report, question, KIT_SECTION_KEYS.question, path);

    if ('id' in question) {
      if (!isValidId(question.id, ID_PREFIXES.question)) {
        report.add(
          `${path}.id`,
          VALIDATION_CODES.ID_MALFORMED,
          `Expected an id like "${ID_PREFIXES.question}1", got ${describe(question.id)}.`
        );
      } else if (seen.has(question.id)) {
        report.add(`${path}.id`, VALIDATION_CODES.ID_DUPLICATE, `Duplicate question id "${question.id}".`);
      } else {
        seen.add(question.id);
        questionIds.add(question.id);
      }
    }

    if ('category' in question) {
      checkEnum(report, question.category, `${path}.category`, QUESTION_CATEGORIES);
    }
    if ('prompt' in question) checkString(report, question.prompt, `${path}.prompt`);
    if ('answer_outline' in question) {
      checkString(report, question.answer_outline, `${path}.answer_outline`);
    }
    if ('difficulty' in question) {
      checkInteger(report, question.difficulty, `${path}.difficulty`, {
        min: DIFFICULTY_RANGE.min,
        max: DIFFICULTY_RANGE.max,
      });
    }
    if ('requirement_ids' in question) {
      checkIdList(report, question.requirement_ids, `${path}.requirement_ids`, {
        known: requirementIds,
        code: VALIDATION_CODES.UNKNOWN_REQUIREMENT_REF,
        label: 'requirement',
      });
    }
  });

  return questionIds;
}

function validateFlashcards(report, flashcards, requirementIds) {
  if (!checkArray(report, flashcards, 'flashcards')) return;

  const seen = new Set();
  flashcards.forEach((flashcard, index) => {
    const path = `flashcards[${index}]`;
    if (!isPlainObject(flashcard)) {
      report.add(path, VALIDATION_CODES.WRONG_TYPE, `Expected an object, got ${describe(flashcard)}.`);
      return;
    }
    checkKeys(report, flashcard, KIT_SECTION_KEYS.flashcard, path);

    if ('id' in flashcard) {
      if (!isValidId(flashcard.id, ID_PREFIXES.flashcard)) {
        report.add(
          `${path}.id`,
          VALIDATION_CODES.ID_MALFORMED,
          `Expected an id like "${ID_PREFIXES.flashcard}1", got ${describe(flashcard.id)}.`
        );
      } else if (seen.has(flashcard.id)) {
        report.add(
          `${path}.id`,
          VALIDATION_CODES.ID_DUPLICATE,
          `Duplicate flashcard id "${flashcard.id}".`
        );
      } else {
        seen.add(flashcard.id);
      }
    }

    if ('front' in flashcard) checkString(report, flashcard.front, `${path}.front`);
    if ('back' in flashcard) checkString(report, flashcard.back, `${path}.back`);
    if ('requirement_ids' in flashcard) {
      checkIdList(report, flashcard.requirement_ids, `${path}.requirement_ids`, {
        known: requirementIds,
        code: VALIDATION_CODES.UNKNOWN_REQUIREMENT_REF,
        label: 'requirement',
      });
    }
  });
}

function validateSchedule(report, schedule, questionIds) {
  if (!isPlainObject(schedule)) {
    report.add('schedule', VALIDATION_CODES.WRONG_TYPE, `Expected an object, got ${describe(schedule)}.`);
    return;
  }
  checkKeys(report, schedule, KIT_SECTION_KEYS.schedule, 'schedule');

  const daysAvailableValid =
    'days_available' in schedule &&
    checkInteger(report, schedule.days_available, 'schedule.days_available', { min: 0 });

  if (!('days' in schedule)) return;
  if (!checkArray(report, schedule.days, 'schedule.days')) return;

  if (daysAvailableValid && schedule.days.length !== schedule.days_available) {
    report.add(
      'schedule.days',
      VALIDATION_CODES.SCHEDULE_LENGTH_MISMATCH,
      `schedule.days has ${schedule.days.length} entries but days_available is ${schedule.days_available}.`
    );
  }

  const seenDays = new Set();
  schedule.days.forEach((day, index) => {
    const path = `schedule.days[${index}]`;
    if (!isPlainObject(day)) {
      report.add(path, VALIDATION_CODES.WRONG_TYPE, `Expected an object, got ${describe(day)}.`);
      return;
    }
    checkKeys(report, day, KIT_SECTION_KEYS.scheduleDay, path);

    if ('day' in day && checkInteger(report, day.day, `${path}.day`, { min: 1 })) {
      if (seenDays.has(day.day)) {
        report.add(
          `${path}.day`,
          VALIDATION_CODES.DAY_SEQUENCE_INVALID,
          `Duplicate day number ${day.day}.`
        );
      }
      seenDays.add(day.day);

      if (day.day > schedule.days.length) {
        report.add(
          `${path}.day`,
          VALIDATION_CODES.DAY_SEQUENCE_INVALID,
          `Day ${day.day} is outside 1..${schedule.days.length}; day numbers must run 1..N with no gaps.`
        );
      }
    }

    if ('focus' in day) checkString(report, day.focus, `${path}.focus`);
    // Minutes are integers by contract. A float here is how a schedule allocator that
    // divided time by day count leaks into the output.
    if ('minutes' in day) checkInteger(report, day.minutes, `${path}.minutes`, { min: 0 });
    if ('question_ids' in day) {
      checkIdList(report, day.question_ids, `${path}.question_ids`, {
        known: questionIds,
        code: VALIDATION_CODES.UNKNOWN_QUESTION_REF,
        label: 'question',
      });
    }
  });

  // A gap (1,2,4) passes the per-entry checks above but is still a broken sequence.
  const expected = schedule.days.length;
  for (let day = 1; day <= expected; day += 1) {
    if (!seenDays.has(day)) {
      report.add(
        'schedule.days',
        VALIDATION_CODES.DAY_SEQUENCE_INVALID,
        `Day ${day} is missing; day numbers must run 1..${expected} with no gaps.`
      );
    }
  }
}

function validateCoverage(report, coverage, requirementIds) {
  if (!isPlainObject(coverage)) {
    report.add('coverage', VALIDATION_CODES.WRONG_TYPE, `Expected an object, got ${describe(coverage)}.`);
    return;
  }
  checkKeys(report, coverage, KIT_SECTION_KEYS.coverage, 'coverage');

  if ('passes' in coverage) checkInteger(report, coverage.passes, 'coverage.passes', { min: 0 });
  if ('uncovered_requirement_ids' in coverage) {
    checkIdList(report, coverage.uncovered_requirement_ids, 'coverage.uncovered_requirement_ids', {
      known: requirementIds,
      code: VALIDATION_CODES.UNKNOWN_REQUIREMENT_REF,
      label: 'requirement',
    });
  }
}

/**
 * Validate a kit against the frozen contract.
 *
 * @param {unknown} kit
 * @returns {{ valid: boolean, errors: Array<{ path: string, code: string, message: string }> }}
 *   Every error found, in document order. Extra fields on the kit are permitted and
 *   never reported — only renamed or missing ones are failures.
 */
export function validateKit(kit) {
  const report = createReport();

  if (!isPlainObject(kit)) {
    report.add('', VALIDATION_CODES.NOT_AN_OBJECT, `A kit must be an object, got ${describe(kit)}.`);
    return { valid: false, errors: report.errors };
  }

  checkKeys(report, kit, KIT_TOP_LEVEL_KEYS, '');

  if ('source' in kit) validateSource(report, kit.source);
  if ('company_brief' in kit) validateCompanyBrief(report, kit.company_brief);

  const requirementIds = 'role' in kit ? validateRole(report, kit.role) : new Set();
  const questionIds =
    'questions' in kit ? validateQuestions(report, kit.questions, requirementIds) : new Set();

  if ('flashcards' in kit) validateFlashcards(report, kit.flashcards, requirementIds);
  if ('schedule' in kit) validateSchedule(report, kit.schedule, questionIds);
  if ('coverage' in kit) validateCoverage(report, kit.coverage, requirementIds);

  return { valid: report.errors.length === 0, errors: report.errors };
}

/** Render errors as a readable block, for logs and CLI output. */
export function formatValidationErrors(errors) {
  if (errors.length === 0) return 'Kit is valid.';
  return errors
    .map(({ path, code, message }) => `  ${path || '<root>'}  [${code}]\n    ${message}`)
    .join('\n');
}
