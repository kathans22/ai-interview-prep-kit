/**
 * validate.js — check a request body before anything else touches it.
 *
 * Decides: whether a body is usable, and what to say when it is not.
 *
 * Does NOT decide: whether the values make business sense. "Is this a string between 8
 * and 200 characters?" lives here; "is this kit yours?" does not.
 *
 * WHY HAND-WRITTEN AND NOT A SCHEMA LIBRARY. The whole API has five body shapes. A
 * validation dependency would be more code to audit than the code it replaces, and the
 * error messages it produces are written for a developer reading a stack trace rather
 * than a user reading a form. These messages are shown to people.
 *
 * EVERY FIELD IS CHECKED, INCLUDING THE ONES THAT "CANNOT" BE WRONG. A route that trusts
 * `days` to be a number because the form sends a number is a route that breaks when
 * someone uses curl — and `days: "5"` reaching the allocator produces a schedule with
 * NaN minutes three layers down, where the cause is invisible.
 */

import { ApiError } from './errors.js';

/** Collects problems so a caller sees every fault at once, not one per submission. */
function createChecker() {
  const problems = [];

  return {
    problems,
    fail(field, message) {
      problems.push({ field, message });
    },
    /** Throw if anything was collected. */
    done() {
      if (problems.length === 0) return;
      throw new ApiError('VALIDATION_FAILED', problems.map((p) => `${p.field}: ${p.message}`).join(' '), {
        details: { fields: problems },
      });
    },
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A trimmed string, or null when absent/unusable. */
function str(value) {
  return typeof value === 'string' ? value.trim() : null;
}

/**
 * Email, lightly.
 *
 * Deliberately not an RFC 5322 regex: those are famously wrong in both directions, and
 * the only real test of an address is sending to it — which this system does not do,
 * because email verification is out of scope. A shape check catches typos; anything
 * stricter rejects valid addresses.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

/** Registration and login share a body shape. */
export function validateCredentials(body) {
  const check = createChecker();
  if (!isPlainObject(body)) throw new ApiError('VALIDATION_FAILED', 'Request body must be a JSON object.');

  const email = str(body.email);
  const password = typeof body.password === 'string' ? body.password : null;

  if (!email) check.fail('email', 'is required.');
  else if (email.length > 254) check.fail('email', 'is too long.');
  else if (!EMAIL_SHAPE.test(email)) check.fail('email', 'does not look like an email address.');

  if (password === null) check.fail('password', 'is required.');
  else if (password.length < PASSWORD_MIN) check.fail('password', `must be at least ${PASSWORD_MIN} characters.`);
  // An upper bound matters with bcrypt: hashing cost rises with input, so an unbounded
  // password is a cheap way to make the server do expensive work.
  else if (password.length > PASSWORD_MAX) check.fail('password', `must be at most ${PASSWORD_MAX} characters.`);

  check.done();
  return { email: email.toLowerCase(), password };
}

export const JD_MIN = 20;
export const JD_MAX = 200_000;
export const DAYS_MIN = 1;
export const DAYS_MAX = 60;

/**
 * The most cases one batch may carry.
 *
 * A quota ceiling, not a performance one. Each kit costs up to twelve model calls
 * against a free-tier limit of twenty a DAY, so five is already more than a day's
 * budget — and a larger batch would not fail fast, it would fail two-thirds of the way
 * through having spent everything.
 */
export const MAX_BATCH_CASES = 5;

/** The body of POST /api/kits. */
export function validateKitInput(body) {
  const check = createChecker();
  if (!isPlainObject(body)) throw new ApiError('VALIDATION_FAILED', 'Request body must be a JSON object.');

  const jd = str(body.jd);
  const companyUrl = str(body.company_url) ?? '';
  const { days } = body;

  if (!jd) check.fail('jd', 'is required.');
  else if (jd.length < JD_MIN) check.fail('jd', `must be at least ${JD_MIN} characters to extract anything from.`);
  else if (jd.length > JD_MAX) check.fail('jd', `must be at most ${JD_MAX} characters.`);

  // A number, not a numeric string. The allocator takes integers and produces NaN
  // minutes from anything else, three layers away from the cause.
  if (!Number.isInteger(days)) check.fail('days', 'must be a whole number.');
  else if (days < DAYS_MIN || days > DAYS_MAX) check.fail('days', `must be between ${DAYS_MIN} and ${DAYS_MAX}.`);

  if (companyUrl !== '') {
    try {
      const url = new URL(companyUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        check.fail('company_url', 'must be an http or https URL.');
      }
    } catch {
      check.fail('company_url', 'is not a valid URL.');
    }
  }

  check.done();
  return { jd, company_url: companyUrl, days };
}

/** A revision the client claims to have seen. */
export function validateRevision(value, field = 'revision') {
  if (!Number.isInteger(value) || value < 0) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `${field} must be the non-negative integer revision you last read. ` +
        'Without it a write cannot be checked for conflicts.',
      { details: { fields: [{ field, message: 'must be a non-negative integer.' }] } }
    );
  }
  return value;
}

/** The body of POST /api/kits/:id/regenerate. */
export function validateRegenerate(body, { sections, categories }) {
  const check = createChecker();
  if (!isPlainObject(body)) throw new ApiError('VALIDATION_FAILED', 'Request body must be a JSON object.');

  const section = str(body.section);
  const category = str(body.category);

  if (!section) check.fail('section', 'is required.');
  else if (!sections.includes(section)) check.fail('section', `must be one of ${sections.join(', ')}.`);

  if (category !== null && category !== '' && !categories.includes(category)) {
    check.fail('category', `must be one of ${categories.join(', ')}.`);
  }
  if (category && section !== 'questions') {
    check.fail('category', 'only applies when regenerating questions.');
  }

  check.done();
  return { section, category: category || null, revision: validateRevision(body.revision) };
}

/** The body of POST /api/kits/:id/practice. */
export function validatePractice(body) {
  const check = createChecker();
  if (!isPlainObject(body)) throw new ApiError('VALIDATION_FAILED', 'Request body must be a JSON object.');

  const questionId = str(body.questionId);
  const { confidence } = body;

  if (!questionId) check.fail('questionId', 'is required.');
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) {
    check.fail('confidence', 'must be a whole number from 1 to 5.');
  }

  check.done();
  return { questionId, confidence, note: str(body.note) ?? '' };
}

/**
 * Validate a batch of cases.
 *
 * Every fault in every case, reported at once. A batch that reports one error per
 * submission takes as many round trips as it has typos, and the whole point of
 * uploading a file is not to correct it one line at a time.
 *
 * The per-case shape is `validateKitInput`'s, not a second definition of it — a batch
 * case that was allowed to differ from a single submission would be a second contract
 * for the same thing.
 *
 * @param {unknown} body `{ cases: [...] }` or a bare array
 * @param {{ maxCases?: number }} [options]
 * @returns {{ id: string, jd: string, company_url: string, days: number }[]}
 */
export function validateBatchInput(body, { maxCases = MAX_BATCH_CASES } = {}) {
  const cases = Array.isArray(body) ? body : body?.cases;

  if (!Array.isArray(cases)) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'Send a JSON array of cases, or an object with a "cases" array. Each case is ' +
        '{ id, jd, company_url?, days }.'
    );
  }
  if (cases.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'The batch contains no cases.');
  }
  if (cases.length > maxCases) {
    // A quota guard, not a performance one. Each kit costs up to twelve model calls
    // against a ceiling of twenty a DAY, so an unbounded batch is a whole day's quota
    // spent in one request — and the user would not learn that until the failures came.
    throw new ApiError(
      'VALIDATION_FAILED',
      `A batch may contain at most ${maxCases} cases. Each kit costs up to ` +
        `${12} model calls against a small daily quota, so a larger batch would ` +
        'exhaust it before finishing.'
    );
  }

  const problems = [];
  const seen = new Set();
  const validated = [];

  cases.forEach((entry, index) => {
    const where = `cases[${index}]`;

    // The id keys the result, so a duplicate makes two kits indistinguishable to the
    // client that asked for them.
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (id === '') problems.push({ field: `${where}.id`, message: 'is required — it keys the result.' });
    else if (seen.has(id)) problems.push({ field: `${where}.id`, message: `"${id}" is duplicated; ids must be unique.` });
    else seen.add(id);

    try {
      const input = validateKitInput(entry);
      validated.push({ id, ...input });
    } catch (error) {
      for (const field of error?.details?.fields ?? [{ field: 'case', message: error.message }]) {
        problems.push({ field: `${where}.${field.field}`, message: field.message });
      }
    }
  });

  if (problems.length > 0) {
    throw new ApiError('VALIDATION_FAILED', 'The batch is not usable.', { details: { fields: problems } });
  }

  return validated;
}
