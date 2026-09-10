/**
 * verifySchedule.test.js — the semantic invariants, checked against finished kits.
 *
 * Decides: that every allocator output passes, that each invariant fails with its own
 * code when deliberately broken, and that a review day is not mistaken for a failure of
 * front-loading.
 *
 * Does NOT decide: shape — validateKit owns that, and the two are asserted to be
 * independent here (a shape-valid kit can still be a nonsense schedule).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  verifySchedule,
  formatScheduleViolations,
  SCHEDULE_VIOLATIONS,
} from '../deterministic/verifySchedule.js';
import { allocate } from '../deterministic/scheduleAllocator.js';
import { createEmptyKit } from '../contracts/emptyKit.js';
import { validateKit } from '../contracts/validateKit.js';

const CATEGORIES = ['technical', 'system-design', 'behavioural', 'company-fit'];

const requirements = [
  { id: 'r1', text: 'React', kind: 'technical', priority: 'must' },
  { id: 'r2', text: 'Mentoring', kind: 'behavioural', priority: 'must' },
  { id: 'r3', text: 'Logistics', kind: 'domain', priority: 'nice' },
  { id: 'r4', text: 'GraphQL', kind: 'technical', priority: 'nice' },
];

function buildQuestions(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `q${index + 1}`,
    requirement_ids: [`r${(index % 4) + 1}`],
    category: CATEGORIES[index % CATEGORIES.length],
    prompt: `Question ${index + 1}`,
    answer_outline: 'outline',
    difficulty: (index % 3) + 1,
  }));
}

/** A finished kit whose schedule came from the allocator. */
function buildKit(questionCount, daysAvailable) {
  const questions = buildQuestions(questionCount);
  const kit = createEmptyKit({ daysAvailable: 0, company: 'Acme' });
  kit.role.requirements = structuredClone(requirements);
  kit.questions = questions;
  kit.schedule = allocate({ questions, requirements, daysAvailable });
  return kit;
}

function codes(result) {
  return new Set(result.violations.map((violation) => violation.code));
}

// ---------------------------------------------------------------------------
// Agreement with the allocator
// ---------------------------------------------------------------------------

test('EXIT CHECK: a single question over 1..60 days verifies clean', () => {
  // One question can only cover one requirement, so the fixture is narrowed to match.
  // Pairing a one-question kit with four requirements would test extraction coverage,
  // not scheduling.
  const questions = buildQuestions(1);
  const soleRequirement = [{ id: 'r1', text: 'React', kind: 'technical', priority: 'must' }];

  for (let daysAvailable = 1; daysAvailable <= 60; daysAvailable += 1) {
    const kit = createEmptyKit({ daysAvailable: 0 });
    kit.role.requirements = structuredClone(soleRequirement);
    kit.questions = questions;
    kit.schedule = allocate({ questions, requirements: soleRequirement, daysAvailable });

    const result = verifySchedule(kit);
    assert.equal(result.ok, true, `@ ${daysAvailable} days:\n${formatScheduleViolations(result.violations)}`);
  }
});

test('EXIT CHECK: every allocator schedule from 1 to 60 days verifies clean', () => {
  for (const questionCount of [4, 12, 40]) {
    for (let daysAvailable = 1; daysAvailable <= 60; daysAvailable += 1) {
      const kit = buildKit(questionCount, daysAvailable);
      const result = verifySchedule(kit);
      assert.equal(
        result.ok,
        true,
        `${questionCount} questions @ ${daysAvailable} days:\n${formatScheduleViolations(result.violations)}`
      );
    }
  }
});

test('EXIT CHECK: with zero questions the only complaint is coverage, never scheduling', () => {
  // A kit with must-priority requirements and no questions IS faulty — but the fault is
  // extraction, not allocation. The schedule itself must be beyond reproach, and the
  // codes must let the orchestrator route the problem to the gap-fill pass.
  for (let daysAvailable = 1; daysAvailable <= 60; daysAvailable += 1) {
    const kit = buildKit(0, daysAvailable);
    const result = verifySchedule(kit);

    assert.deepEqual(
      [...codes(result)],
      [SCHEDULE_VIOLATIONS.MUST_HAS_NO_QUESTION],
      `@ ${daysAvailable} days:\n${formatScheduleViolations(result.violations)}`
    );
    assert.ok(
      result.violations.every((violation) => violation.path === 'coverage'),
      'a coverage gap must not be reported against the schedule'
    );
  }
});

test('with zero questions and no must requirements, the schedule verifies clean', () => {
  const kit = buildKit(0, 14);
  kit.role.requirements = kit.role.requirements.map((requirement) => ({
    ...requirement,
    priority: 'nice',
  }));

  const result = verifySchedule(kit);
  assert.equal(result.ok, true, formatScheduleViolations(result.violations));
});

test('allocator output is also shape-valid, so both checks pass together', () => {
  const kit = buildKit(12, 7);
  const shape = validateKit(kit);
  assert.equal(shape.valid, true);
  assert.equal(verifySchedule(kit).ok, true);
});

// ---------------------------------------------------------------------------
// Each invariant, broken on purpose
// ---------------------------------------------------------------------------

test('day count mismatch is caught', () => {
  const kit = buildKit(9, 5);
  kit.schedule.days.pop();
  assert.ok(codes(verifySchedule(kit)).has(SCHEDULE_VIOLATIONS.DAY_COUNT_MISMATCH));
});

test('duplicate and missing day numbers are caught', () => {
  const kit = buildKit(9, 5);
  kit.schedule.days[3].day = 2;
  const found = codes(verifySchedule(kit));
  assert.ok(found.has(SCHEDULE_VIOLATIONS.DAY_SEQUENCE_INVALID));
  assert.ok(
    verifySchedule(kit).violations.some((violation) => /Day 4 is missing/.test(violation.message))
  );
});

test('float minutes are caught, and the message names the usual cause', () => {
  const kit = buildKit(9, 3);
  kit.schedule.days[0].minutes = 62.5;

  const result = verifySchedule(kit);
  assert.ok(codes(result).has(SCHEDULE_VIOLATIONS.MINUTES_NOT_INTEGER));
  assert.match(
    result.violations.find((v) => v.code === SCHEDULE_VIOLATIONS.MINUTES_NOT_INTEGER).message,
    /Dividing total time by day count/
  );
});

test('an empty focus is caught', () => {
  const kit = buildKit(9, 3);
  kit.schedule.days[1].focus = '   ';
  assert.ok(codes(verifySchedule(kit)).has(SCHEDULE_VIOLATIONS.FOCUS_EMPTY));
});

test('a day referencing a question the kit does not have is caught', () => {
  const kit = buildKit(9, 3);
  kit.schedule.days[0].question_ids.push('q999');
  assert.ok(codes(verifySchedule(kit)).has(SCHEDULE_VIOLATIONS.UNKNOWN_QUESTION_REF));
});

test('a question that appears on no day is caught', () => {
  const kit = buildKit(9, 3);
  kit.schedule.days = kit.schedule.days.map((day) => ({
    ...day,
    question_ids: day.question_ids.filter((id) => id !== 'q5'),
  }));

  const result = verifySchedule(kit);
  assert.ok(codes(result).has(SCHEDULE_VIOLATIONS.QUESTION_NOT_SCHEDULED));
  assert.ok(result.violations.some((violation) => /"q5"/.test(violation.message)));
});

test('an empty day while material exists is filler, and is caught', () => {
  const kit = buildKit(9, 3);
  kit.schedule.days[2].question_ids = [];
  assert.ok(codes(verifySchedule(kit)).has(SCHEDULE_VIOLATIONS.EMPTY_DAY_WITH_MATERIAL));
});

test('a must requirement with a question but no scheduled day is caught', () => {
  const kit = buildKit(8, 4);
  // Strip every question covering r2 from the schedule, but leave them in the kit.
  const r2Questions = kit.questions
    .filter((question) => question.requirement_ids.includes('r2'))
    .map((question) => question.id);
  kit.schedule.days = kit.schedule.days.map((day) => ({
    ...day,
    question_ids: day.question_ids.filter((id) => !r2Questions.includes(id)),
  }));

  const found = codes(verifySchedule(kit));
  assert.ok(found.has(SCHEDULE_VIOLATIONS.MUST_NOT_SCHEDULED), 'the must is unreachable');
  assert.ok(found.has(SCHEDULE_VIOLATIONS.QUESTION_NOT_SCHEDULED), 'and its questions were dropped');
});

test('a must with no question at all is a coverage gap, under its own code', () => {
  const kit = buildKit(8, 4);
  kit.role.requirements.push({ id: 'r9', text: 'Kafka', kind: 'technical', priority: 'must' });

  const result = verifySchedule(kit);
  assert.ok(codes(result).has(SCHEDULE_VIOLATIONS.MUST_HAS_NO_QUESTION));
  assert.equal(
    codes(result).has(SCHEDULE_VIOLATIONS.MUST_NOT_SCHEDULED),
    false,
    'a missing question must not be reported as an allocator fault'
  );
});

test('a schedule with the hard material last is caught', () => {
  const kit = buildKit(12, 4);
  kit.schedule.days = [...kit.schedule.days]
    .reverse()
    .map((day, index) => ({ ...day, day: index + 1, kind: 'new' }));

  assert.ok(codes(verifySchedule(kit)).has(SCHEDULE_VIOLATIONS.NOT_FRONT_LOADED));
});

test('review days bringing hard material back late are NOT a front-loading violation', () => {
  const kit = buildKit(6, 30);
  const result = verifySchedule(kit);

  assert.ok(kit.schedule.days.some((day) => day.kind === 'review'), 'the fixture must have review days');
  assert.equal(result.ok, true, formatScheduleViolations(result.violations));
});

test('review days are still detected when the kind field is absent', () => {
  const kit = buildKit(6, 30);
  kit.schedule.days = kit.schedule.days.map(({ kind, ...day }) => day);

  const result = verifySchedule(kit);
  assert.equal(
    result.ok,
    true,
    `re-derived review detection failed:\n${formatScheduleViolations(result.violations)}`
  );
});

// ---------------------------------------------------------------------------
// Independence from validateKit, and reporting
// ---------------------------------------------------------------------------

test('a shape-valid kit can still be a nonsense schedule', () => {
  const kit = buildKit(9, 3);
  // Reverse the day order in place: every field is still the right type and every
  // reference still resolves, so validateKit is content — but day 1 is now day 3.
  kit.schedule.days = [
    { ...kit.schedule.days[2], day: 1 },
    { ...kit.schedule.days[1], day: 2 },
    { ...kit.schedule.days[0], day: 3 },
  ];

  assert.equal(validateKit(kit).valid, true, 'shape is fine');
  assert.equal(verifySchedule(kit).ok, false, 'semantics are not');
});

test('a kit with no schedule fails without throwing', () => {
  assert.equal(verifySchedule({}).ok, false);
  assert.equal(verifySchedule(null).ok, false);
  assert.ok(codes(verifySchedule(undefined)).has(SCHEDULE_VIOLATIONS.NOT_AN_OBJECT));
});

test('all violations are returned together, not one per run', () => {
  const kit = buildKit(9, 4);
  kit.schedule.days[0].minutes = 30.5;
  kit.schedule.days[1].focus = '';
  kit.schedule.days[2].question_ids.push('q404');

  const found = codes(verifySchedule(kit));
  assert.ok(found.has(SCHEDULE_VIOLATIONS.MINUTES_NOT_INTEGER));
  assert.ok(found.has(SCHEDULE_VIOLATIONS.FOCUS_EMPTY));
  assert.ok(found.has(SCHEDULE_VIOLATIONS.UNKNOWN_QUESTION_REF));
});

test('every violation carries a code, a path and a message', () => {
  const kit = buildKit(9, 3);
  kit.schedule.days[0].minutes = 1.5;

  for (const violation of verifySchedule(kit).violations) {
    assert.match(violation.code, /^SCHEDULE_[A-Z_]+$/);
    assert.equal(typeof violation.path, 'string');
    assert.ok(violation.message.length > 0);
  }
});

test('formatScheduleViolations renders something actionable', () => {
  assert.equal(formatScheduleViolations([]), 'Schedule is consistent.');
  const kit = buildKit(9, 3);
  kit.schedule.days[0].focus = '';
  assert.match(formatScheduleViolations(verifySchedule(kit).violations), /SCHEDULE_FOCUS_EMPTY/);
});

test('the kit is never mutated by verification', () => {
  const kit = buildKit(9, 5);
  const snapshot = structuredClone(kit);
  verifySchedule(kit);
  assert.deepEqual(kit, snapshot);
});
