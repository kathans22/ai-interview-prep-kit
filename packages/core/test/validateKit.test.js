/**
 * validateKit.test.js — the contract's executable specification.
 *
 * Decides: that a hand-written valid kit passes, and that five deliberately broken kits
 * each fail for their own stated reason with the right code at the right path.
 *
 * Does NOT decide: kit quality. Every kit below is structurally judged only.
 *
 * The valid kit is written out by hand rather than produced by createEmptyKit, so the
 * validator and the factory cannot agree with each other about a shape that is actually
 * wrong. A pairing test at the end checks they agree anyway.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateKit, VALIDATION_CODES, formatValidationErrors } from '../contracts/validateKit.js';
import { createEmptyKit } from '../contracts/emptyKit.js';

/** A complete, hand-written kit that satisfies every rule in the frozen contract. */
function validKit() {
  return {
    source: {
      company: 'Acme',
      company_url: 'http://localhost:8099/acme/',
      role: 'Senior Frontend Engineer',
      location: 'Remote (UK)',
      jd_chars: 1420,
      researched_at: '2026-09-01T09:12:44Z',
      pages_used: ['http://localhost:8099/acme/', 'http://localhost:8099/acme/careers'],
    },
    company_brief: {
      summary: 'Acme builds warehouse routing software.',
      what_they_do: 'Fleet scheduling for third-party logistics providers.',
      sources: ['http://localhost:8099/acme/about'],
    },
    role: {
      title: 'Senior Frontend Engineer',
      seniority: 'senior',
      responsibilities: ['Own the operator console', 'Mentor two engineers'],
      requirements: [
        { id: 'r1', text: '5+ years with React', kind: 'technical', priority: 'must' },
        { id: 'r2', text: 'Mentoring experience', kind: 'behavioural', priority: 'nice' },
        { id: 'r3', text: 'Logistics domain exposure', kind: 'domain', priority: 'nice' },
      ],
    },
    questions: [
      {
        id: 'q1',
        requirement_ids: ['r1'],
        category: 'technical',
        prompt: 'Walk through reconciling optimistic updates with a server rejection.',
        answer_outline: 'Name the rollback strategy, then the user-visible consequence.',
        difficulty: 2,
      },
      {
        id: 'q2',
        requirement_ids: ['r2'],
        category: 'behavioural',
        prompt: 'Describe mentoring someone whose approach you disagreed with.',
        answer_outline: 'Situation, the disagreement, what you changed, the outcome.',
        difficulty: 1,
      },
      {
        id: 'q3',
        requirement_ids: ['r1', 'r3'],
        category: 'system-design',
        prompt: 'Design the operator console for 400 concurrent vehicle updates.',
        answer_outline: 'Transport choice, batching, back-pressure, degradation.',
        difficulty: 3,
      },
      {
        id: 'q4',
        requirement_ids: ['r3'],
        category: 'company-fit',
        prompt: 'Why routing software rather than a consumer product?',
        answer_outline: 'Tie motivation to something specific about the domain.',
        difficulty: 1,
      },
    ],
    flashcards: [
      { id: 'f1', front: 'Optimistic update', back: 'Apply locally, reconcile on response.', requirement_ids: ['r1'] },
      { id: 'f2', front: 'Back-pressure', back: 'Let the consumer bound the producer.', requirement_ids: ['r1'] },
    ],
    schedule: {
      days_available: 3,
      days: [
        { day: 1, focus: 'React depth', question_ids: ['q1'], minutes: 60 },
        { day: 2, focus: 'System design', question_ids: ['q3'], minutes: 90 },
        { day: 3, focus: 'Behavioural and fit', question_ids: ['q2', 'q4'], minutes: 45 },
      ],
    },
    coverage: {
      uncovered_requirement_ids: [],
      passes: 2,
    },
  };
}

/** Deep clone so each broken case starts from a known-good kit. */
function mutate(change) {
  const kit = structuredClone(validKit());
  change(kit);
  return kit;
}

function codesAt(result, path) {
  return result.errors.filter((error) => error.path === path).map((error) => error.code);
}

function allCodes(result) {
  return new Set(result.errors.map((error) => error.code));
}

// ---------------------------------------------------------------------------
// The valid kit
// ---------------------------------------------------------------------------

test('the hand-written valid kit passes with no errors', () => {
  const result = validateKit(validKit());
  assert.deepEqual(result.errors, [], formatValidationErrors(result.errors));
  assert.equal(result.valid, true);
});

test('extra fields are permitted; only renamed or missing ones fail', () => {
  const kit = mutate((draft) => {
    draft.notes = 'internal';
    draft.role.requirements[0].confidence = 0.9;
    draft.questions[0].source_pass = 2;
  });
  assert.equal(validateKit(kit).valid, true);
});

test('an empty kit from the factory is valid, so a degraded run stays "ok"', () => {
  for (const daysAvailable of [0, 5]) {
    const result = validateKit(createEmptyKit({ daysAvailable, minutesPerDay: 60 }));
    assert.equal(result.valid, true, formatValidationErrors(result.errors));
  }
});

// ---------------------------------------------------------------------------
// Broken kit 1 — missing keys
// ---------------------------------------------------------------------------

test('broken 1: missing top-level and nested keys are each reported', () => {
  const kit = mutate((draft) => {
    delete draft.coverage;
    delete draft.flashcards;
    delete draft.source.researched_at;
    delete draft.schedule.days_available;
  });

  const result = validateKit(kit);
  assert.equal(result.valid, false);
  assert.deepEqual(codesAt(result, 'coverage'), [VALIDATION_CODES.MISSING_KEY]);
  assert.deepEqual(codesAt(result, 'flashcards'), [VALIDATION_CODES.MISSING_KEY]);
  assert.deepEqual(codesAt(result, 'source.researched_at'), [VALIDATION_CODES.MISSING_KEY]);
  assert.deepEqual(codesAt(result, 'schedule.days_available'), [VALIDATION_CODES.MISSING_KEY]);
  assert.ok(result.errors.length >= 4, 'all four must be reported, not just the first');
});

test('broken 1b: a non-object is rejected outright', () => {
  for (const value of [null, undefined, 'kit', 42, []]) {
    const result = validateKit(value);
    assert.equal(result.valid, false);
    assert.deepEqual(codesAt(result, ''), [VALIDATION_CODES.NOT_AN_OBJECT]);
  }
});

// ---------------------------------------------------------------------------
// Broken kit 2 — enum spellings
// ---------------------------------------------------------------------------

test('broken 2: Americanised, underscored and capitalised enums all fail', () => {
  const kit = mutate((draft) => {
    draft.role.requirements[1].kind = 'behavioral'; // American spelling
    draft.role.requirements[2].priority = 'required'; // not in the enum
    draft.questions[2].category = 'system_design'; // underscore, not hyphen
    draft.questions[1].category = 'System-Design'; // wrong case, and wrong value for this question
  });

  const result = validateKit(kit);
  assert.equal(result.valid, false);
  assert.deepEqual(codesAt(result, 'role.requirements[1].kind'), [VALIDATION_CODES.ENUM_INVALID]);
  assert.deepEqual(codesAt(result, 'role.requirements[2].priority'), [VALIDATION_CODES.ENUM_INVALID]);
  assert.deepEqual(codesAt(result, 'questions[2].category'), [VALIDATION_CODES.ENUM_INVALID]);
  assert.deepEqual(codesAt(result, 'questions[1].category'), [VALIDATION_CODES.ENUM_INVALID]);
});

test('broken 2b: the near-miss hint names the correct spelling', () => {
  const kit = mutate((draft) => {
    draft.role.requirements[1].kind = 'behavioral';
  });
  const [error] = validateKit(kit).errors.filter((e) => e.path === 'role.requirements[1].kind');
  assert.match(error.message, /Did you mean "behavioural"\?/);
});

test('broken 2c: "system-design" is a question category, never a requirement kind', () => {
  const kit = mutate((draft) => {
    draft.role.requirements[0].kind = 'system-design';
  });
  assert.deepEqual(codesAt(validateKit(kit), 'role.requirements[0].kind'), [
    VALIDATION_CODES.ENUM_INVALID,
  ]);
});

// ---------------------------------------------------------------------------
// Broken kit 3 — numbers
// ---------------------------------------------------------------------------

test('broken 3: difficulty out of range, difficulty as a string, and float minutes', () => {
  const kit = mutate((draft) => {
    draft.questions[0].difficulty = 4; // above the range
    draft.questions[1].difficulty = '2'; // a numeric string is not an integer
    draft.questions[2].difficulty = 2.5; // a float is not an integer
    draft.schedule.days[0].minutes = 45.5; // the classic total/days division leak
    draft.source.jd_chars = 1420.5;
  });

  const result = validateKit(kit);
  assert.equal(result.valid, false);
  assert.deepEqual(codesAt(result, 'questions[0].difficulty'), [VALIDATION_CODES.OUT_OF_RANGE]);
  assert.deepEqual(codesAt(result, 'questions[1].difficulty'), [VALIDATION_CODES.NOT_AN_INTEGER]);
  assert.deepEqual(codesAt(result, 'questions[2].difficulty'), [VALIDATION_CODES.NOT_AN_INTEGER]);
  assert.deepEqual(codesAt(result, 'schedule.days[0].minutes'), [VALIDATION_CODES.NOT_AN_INTEGER]);
  assert.deepEqual(codesAt(result, 'source.jd_chars'), [VALIDATION_CODES.NOT_AN_INTEGER]);
});

test('broken 3b: difficulty 1, 2 and 3 are all accepted', () => {
  for (const difficulty of [1, 2, 3]) {
    const kit = mutate((draft) => {
      draft.questions[0].difficulty = difficulty;
    });
    assert.equal(validateKit(kit).valid, true, `difficulty ${difficulty} should be valid`);
  }
});

// ---------------------------------------------------------------------------
// Broken kit 4 — schedule shape
// ---------------------------------------------------------------------------

test('broken 4: days length must equal days_available', () => {
  const kit = mutate((draft) => {
    draft.schedule.days_available = 5; // three days are present
  });

  const result = validateKit(kit);
  assert.equal(result.valid, false);
  assert.ok(codesAt(result, 'schedule.days').includes(VALIDATION_CODES.SCHEDULE_LENGTH_MISMATCH));
});

test('broken 4b: duplicate day numbers are caught, and the resulting gap with them', () => {
  const kit = mutate((draft) => {
    draft.schedule.days[2].day = 2; // now 1, 2, 2 — day 3 is missing
  });

  const result = validateKit(kit);
  assert.equal(result.valid, false);
  assert.ok(codesAt(result, 'schedule.days[2].day').includes(VALIDATION_CODES.DAY_SEQUENCE_INVALID));
  assert.ok(
    result.errors.some(
      (error) => error.path === 'schedule.days' && /Day 3 is missing/.test(error.message)
    ),
    'the gap left by the duplicate must be reported too'
  );
});

test('broken 4c: a gap in the sequence fails even when every entry is well formed', () => {
  const kit = mutate((draft) => {
    draft.schedule.days[2].day = 4; // 1, 2, 4 over three entries
  });

  const result = validateKit(kit);
  assert.equal(result.valid, false);
  assert.ok(allCodes(result).has(VALIDATION_CODES.DAY_SEQUENCE_INVALID));
});

// ---------------------------------------------------------------------------
// Broken kit 5 — dangling references
// ---------------------------------------------------------------------------

test('broken 5: every dangling reference is reported at its own path', () => {
  const kit = mutate((draft) => {
    draft.questions[0].requirement_ids = ['r1', 'r99']; // r99 does not exist
    draft.flashcards[0].requirement_ids = ['r42'];
    draft.schedule.days[0].question_ids = ['q1', 'q99'];
    draft.coverage.uncovered_requirement_ids = ['r7'];
  });

  const result = validateKit(kit);
  assert.equal(result.valid, false);
  assert.deepEqual(codesAt(result, 'questions[0].requirement_ids[1]'), [
    VALIDATION_CODES.UNKNOWN_REQUIREMENT_REF,
  ]);
  assert.deepEqual(codesAt(result, 'flashcards[0].requirement_ids[0]'), [
    VALIDATION_CODES.UNKNOWN_REQUIREMENT_REF,
  ]);
  assert.deepEqual(codesAt(result, 'schedule.days[0].question_ids[1]'), [
    VALIDATION_CODES.UNKNOWN_QUESTION_REF,
  ]);
  assert.deepEqual(codesAt(result, 'coverage.uncovered_requirement_ids[0]'), [
    VALIDATION_CODES.UNKNOWN_REQUIREMENT_REF,
  ]);
  assert.equal(result.errors.length, 4, 'exactly the four dangling references');
});

test('broken 5b: malformed and duplicate ids are distinguished', () => {
  const kit = mutate((draft) => {
    draft.role.requirements[1].id = 'requirement-2'; // malformed
    draft.questions[1].id = 'q1'; // duplicate of questions[0]
    draft.flashcards[1].id = 'r9'; // right shape, wrong prefix for a flashcard
  });

  const result = validateKit(kit);
  assert.deepEqual(codesAt(result, 'role.requirements[1].id'), [VALIDATION_CODES.ID_MALFORMED]);
  assert.deepEqual(codesAt(result, 'questions[1].id'), [VALIDATION_CODES.ID_DUPLICATE]);
  assert.deepEqual(codesAt(result, 'flashcards[1].id'), [VALIDATION_CODES.ID_MALFORMED]);
});

test('broken 5c: a requirement with a malformed id cannot satisfy a reference', () => {
  // r2 is malformed, so questions[1] citing "r2" is now dangling — both are reported.
  const kit = mutate((draft) => {
    draft.role.requirements[1].id = 'R2';
  });

  const result = validateKit(kit);
  assert.deepEqual(codesAt(result, 'role.requirements[1].id'), [VALIDATION_CODES.ID_MALFORMED]);
  assert.deepEqual(codesAt(result, 'questions[1].requirement_ids[0]'), [
    VALIDATION_CODES.UNKNOWN_REQUIREMENT_REF,
  ]);
});

// ---------------------------------------------------------------------------
// Reporting behaviour
// ---------------------------------------------------------------------------

test('all errors are returned together, not one per run', () => {
  const kit = mutate((draft) => {
    delete draft.coverage;
    draft.role.requirements[0].kind = 'behavioral';
    draft.questions[0].difficulty = 9;
    draft.schedule.days[1].minutes = 30.5;
    draft.questions[1].requirement_ids = ['r404'];
  });

  const result = validateKit(kit);
  assert.equal(result.errors.length, 5, formatValidationErrors(result.errors));
  assert.deepEqual(
    allCodes(result),
    new Set([
      VALIDATION_CODES.MISSING_KEY,
      VALIDATION_CODES.ENUM_INVALID,
      VALIDATION_CODES.OUT_OF_RANGE,
      VALIDATION_CODES.NOT_AN_INTEGER,
      VALIDATION_CODES.UNKNOWN_REQUIREMENT_REF,
    ])
  );
});

test('every error carries a path, a code and a message', () => {
  const { errors } = validateKit({});
  assert.ok(errors.length > 0);
  for (const error of errors) {
    assert.equal(typeof error.path, 'string');
    assert.match(error.code, /^KIT_[A-Z_]+$/);
    assert.ok(error.message.length > 0, 'a code without a message is not actionable');
  }
});

test('formatValidationErrors renders something a human can act on', () => {
  assert.equal(formatValidationErrors([]), 'Kit is valid.');
  const text = formatValidationErrors(validateKit({}).errors);
  assert.match(text, /KIT_MISSING_KEY/);
  assert.match(text, /<root>|source/);
});
