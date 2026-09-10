/**
 * scheduleAllocator.test.js — the allocator's invariants, asserted for every day count
 * from 1 to 60 against several question sets including the empty one.
 *
 * Decides: that the invariants in the module header hold for every input, not just the
 * convenient ones. The loop is the point — a schedule bug that only appears at 47 days
 * is exactly the bug nobody finds by hand.
 *
 * Does NOT decide: whether a finished kit's schedule is consistent — that is
 * verifySchedule's job, and it re-checks these properties independently so an allocator
 * bug cannot ship on the strength of the allocator's own opinion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allocate,
  questionCost,
  orderQuestions,
  MAX_MINUTES_PER_DAY,
  NO_MATERIAL_FOCUS,
} from '../deterministic/scheduleAllocator.js';

const requirements = [
  { id: 'r1', priority: 'must' },
  { id: 'r2', priority: 'must' },
  { id: 'r3', priority: 'nice' },
  { id: 'r4', priority: 'nice' },
];

const CATEGORIES = ['technical', 'system-design', 'behavioural', 'company-fit'];

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

/** The question sets the invariant loop runs against. */
const QUESTION_SETS = [
  { label: 'zero questions', questions: [] },
  { label: 'one question', questions: buildQuestions(1) },
  { label: 'typical kit', questions: buildQuestions(12) },
  { label: 'large kit', questions: buildQuestions(40) },
];

/** Assert every invariant for one produced schedule. Returns nothing; throws on failure. */
function assertInvariants(schedule, { questions, daysAvailable, label }) {
  const where = `${label} @ ${daysAvailable} day(s)`;

  // 1. day count, numbering, no gaps or duplicates
  assert.equal(schedule.days_available, daysAvailable, `${where}: days_available`);
  assert.equal(schedule.days.length, daysAvailable, `${where}: days.length`);
  assert.deepEqual(
    schedule.days.map((day) => day.day),
    Array.from({ length: daysAvailable }, (_, index) => index + 1),
    `${where}: day numbers must run 1..N`
  );

  const knownIds = new Set(questions.map((question) => question.id));
  const scheduledIds = new Set();

  for (const day of schedule.days) {
    // 3. per-day shape
    assert.ok(Number.isInteger(day.day), `${where}: day.day integer`);
    assert.equal(typeof day.focus, 'string', `${where}: focus is a string`);
    assert.ok(day.focus.length > 0, `${where}: day ${day.day} focus must be non-empty`);
    assert.ok(Array.isArray(day.question_ids), `${where}: question_ids array`);
    assert.ok(
      Number.isInteger(day.minutes),
      `${where}: day ${day.day} minutes must be an integer, got ${day.minutes}`
    );
    assert.ok(day.minutes >= 0, `${where}: minutes non-negative`);
    assert.ok(day.minutes <= MAX_MINUTES_PER_DAY, `${where}: day ${day.day} exceeds the cap`);

    for (const id of day.question_ids) {
      assert.ok(knownIds.has(id), `${where}: day ${day.day} references unknown question ${id}`);
      scheduledIds.add(id);
    }

    // no day is filler: either it has material, or the whole kit has none
    if (questions.length > 0) {
      assert.ok(
        day.question_ids.length > 0,
        `${where}: day ${day.day} is empty filler although material exists`
      );
    } else {
      assert.equal(day.focus, NO_MATERIAL_FOCUS, `${where}: empty days must say why`);
      assert.equal(day.minutes, 0, `${where}: empty days cost nothing`);
    }
  }

  // 2. nothing silently dropped
  assert.equal(
    scheduledIds.size,
    knownIds.size,
    `${where}: ${knownIds.size - scheduledIds.size} question(s) were dropped`
  );

  // 5. every must requirement with a covering question is reachable from some day
  const scheduledRequirementIds = new Set();
  for (const question of questions) {
    if (!scheduledIds.has(question.id)) continue;
    for (const requirementId of question.requirement_ids) scheduledRequirementIds.add(requirementId);
  }
  for (const requirement of requirements) {
    if (requirement.priority !== 'must') continue;
    const hasCoveringQuestion = questions.some((question) =>
      question.requirement_ids.includes(requirement.id)
    );
    if (!hasCoveringQuestion) continue;
    assert.ok(
      scheduledRequirementIds.has(requirement.id),
      `${where}: must requirement ${requirement.id} is not reachable from any day`
    );
  }
}

test('EXIT CHECK: invariants hold for every day count 1..60, including no questions', () => {
  for (const { label, questions } of QUESTION_SETS) {
    for (let daysAvailable = 1; daysAvailable <= 60; daysAvailable += 1) {
      const schedule = allocate({ questions, requirements, daysAvailable });
      assertInvariants(schedule, { questions, daysAvailable, label });
    }
  }
});

test('harder and higher-priority material lands earlier', () => {
  const questions = buildQuestions(24);
  const schedule = allocate({ questions, requirements, daysAvailable: 6 });
  const byId = new Map(questions.map((question) => [question.id, question]));

  const newDays = schedule.days.filter((day) => day.kind === 'new');
  const averageDifficulty = newDays.map((day) => {
    const values = day.question_ids.map((id) => byId.get(id).difficulty);
    return values.reduce((total, value) => total + value, 0) / values.length;
  });

  const half = Math.floor(averageDifficulty.length / 2);
  const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
  assert.ok(
    mean(averageDifficulty.slice(0, half)) >= mean(averageDifficulty.slice(half)),
    `front half should be at least as hard: ${averageDifficulty.join(', ')}`
  );

  // Every must-covering question is scheduled before every nice-only question.
  const mustIds = new Set(['r1', 'r2']);
  const order = schedule.days.flatMap((day) => day.question_ids);
  const isMust = (id) => byId.get(id).requirement_ids.some((rid) => mustIds.has(rid));
  const lastMust = order.reduce((last, id, index) => (isMust(id) ? index : last), -1);
  const firstNice = order.findIndex((id) => !isMust(id));
  assert.ok(firstNice === -1 || lastMust < firstNice, 'must material must precede nice material');
});

test('one day: everything lands on day 1 and nothing is dropped to fit the cap', () => {
  const questions = buildQuestions(20);
  const schedule = allocate({ questions, requirements, daysAvailable: 1 });

  assert.equal(schedule.days.length, 1);
  assert.equal(schedule.days[0].question_ids.length, 20, 'all ids present despite the cap');
  assert.equal(schedule.days[0].minutes, MAX_MINUTES_PER_DAY, 'minutes capped, not inflated');
});

test('long horizon: surplus days are real review days, never filler', () => {
  const questions = buildQuestions(12);
  const schedule = allocate({ questions, requirements, daysAvailable: 60 });

  const reviewDays = schedule.days.filter((day) => day.kind === 'review');
  assert.equal(reviewDays.length, 48, 'one pass of 12 new days, then 48 review days');

  for (const day of reviewDays) {
    assert.ok(day.question_ids.length > 0, `review day ${day.day} has no ids`);
    assert.match(day.focus, /^Review — /);
    assert.ok(day.minutes > 0, `review day ${day.day} costs nothing`);
  }

  // Consecutive review days differ, so the schedule is not the same day repeated.
  assert.notDeepEqual(reviewDays[0].question_ids, reviewDays[1].question_ids);

  // Review is weighted to must-priority and difficulty 3.
  const byId = new Map(questions.map((question) => [question.id, question]));
  const firstReview = reviewDays[0].question_ids.map((id) => byId.get(id));
  assert.ok(
    firstReview.some((question) => question.difficulty === 3),
    'the first review day should surface the hardest material'
  );
  assert.ok(
    firstReview.every((question) =>
      question.requirement_ids.some((id) => ['r1', 'r2'].includes(id))
    ),
    'the first review day should be must-weighted'
  );
});

test('review minutes are cheaper than the same material seen for the first time', () => {
  const questions = buildQuestions(4);
  const schedule = allocate({ questions, requirements, daysAvailable: 8 });

  const firstPassCost = questions.reduce((total, question) => total + questionCost(question), 0);
  const reviewDay = schedule.days.find((day) => day.kind === 'review');

  assert.ok(reviewDay.minutes > 0);
  assert.ok(reviewDay.minutes < firstPassCost, 'recall must cost less than first contact');
});

test('zero questions still produces a full schedule that says why it is empty', () => {
  for (const daysAvailable of [1, 5, 60]) {
    const schedule = allocate({ questions: [], requirements, daysAvailable });
    assert.equal(schedule.days.length, daysAvailable);
    for (const day of schedule.days) {
      assert.equal(day.focus, NO_MATERIAL_FOCUS);
      assert.deepEqual(day.question_ids, []);
      assert.equal(day.minutes, 0);
    }
  }
});

test('zero days available produces an empty schedule rather than throwing', () => {
  assert.deepEqual(allocate({ questions: buildQuestions(3), requirements, daysAvailable: 0 }), {
    days_available: 0,
    days: [],
  });
});

test('a non-integer or negative day count fails loudly', () => {
  for (const daysAvailable of [-1, 2.5, '5', null]) {
    assert.throws(
      () => allocate({ questions: [], requirements, daysAvailable }),
      /SCHEDULE_INVALID_DAYS/,
      `daysAvailable=${String(daysAvailable)} should be rejected`
    );
  }
});

test('questions without a usable id are excluded rather than crashing the schedule', () => {
  const questions = [...buildQuestions(3), { category: 'technical', difficulty: 1 }, { id: '' }];
  const schedule = allocate({ questions, requirements, daysAvailable: 3 });

  const ids = schedule.days.flatMap((day) => day.question_ids);
  assert.deepEqual([...ids].sort(), ['q1', 'q2', 'q3']);
});

test('allocation is deterministic — the same input yields the same schedule', () => {
  const questions = buildQuestions(15);
  const first = allocate({ questions, requirements, daysAvailable: 7 });
  const second = allocate({ questions: [...questions].reverse(), requirements, daysAvailable: 7 });

  assert.deepEqual(first, second, 'input order must not change the output');
});

test('questionCost is a positive integer for every category and difficulty', () => {
  for (const category of [...CATEGORIES, 'unknown-category']) {
    for (const difficulty of [1, 2, 3, undefined]) {
      const cost = questionCost({ category, difficulty });
      assert.ok(Number.isInteger(cost) && cost > 0, `${category}/${difficulty} → ${cost}`);
    }
  }
  assert.ok(
    questionCost({ category: 'system-design', difficulty: 3 }) >
      questionCost({ category: 'company-fit', difficulty: 1 }),
    'a hard system-design question must cost more than an easy fit question'
  );
});

test('orderQuestions does not mutate its input', () => {
  const questions = buildQuestions(5);
  const snapshot = questions.map((question) => question.id);
  orderQuestions(questions, new Set(['r1']));
  assert.deepEqual(
    questions.map((question) => question.id),
    snapshot
  );
});

test('day minutes equal the sum of that day\'s question costs when under the cap', () => {
  const questions = buildQuestions(6);
  const byId = new Map(questions.map((question) => [question.id, question]));
  const schedule = allocate({ questions, requirements, daysAvailable: 6 });

  for (const day of schedule.days.filter((entry) => entry.kind === 'new')) {
    const expected = day.question_ids.reduce((total, id) => total + questionCost(byId.get(id)), 0);
    if (expected <= MAX_MINUTES_PER_DAY) {
      assert.equal(day.minutes, expected, `day ${day.day} minutes must be the sum of its costs`);
    }
  }
});
