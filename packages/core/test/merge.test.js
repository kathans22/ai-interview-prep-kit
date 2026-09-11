/**
 * merge.test.js — regeneration must not destroy a person's work.
 *
 * Decides: that the four merge rules hold, including the case the brief names — a user
 * edits q3, the entire technical category is regenerated, q3 survives with its edit and
 * behavioural is untouched.
 *
 * Does NOT decide: anything about routes, storage or the model. These are pure functions
 * over plain objects, which is why they can be tested before a single route exists — and
 * why a route cannot later change their behaviour without changing them here first.
 *
 * The fixtures are written out by hand rather than produced by buildKit: a generated
 * fixture would let a change in assembly quietly change what these tests assert.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeSection,
  mergeQuestions,
  mergeFlashcards,
  mergeCompanyBrief,
  recomputeDerived,
  MERGEABLE_SECTIONS,
} from '../contracts/merge.js';
import {
  markEdited,
  markManual,
  setPinned,
  isReplaceable,
  isProtected,
  provenanceSummary,
  stampKit,
  ORIGINS,
} from '../contracts/provenance.js';
import { validateKit } from '../contracts/validateKit.js';
import { verifySchedule, SCHEDULE_VIOLATIONS } from '../deterministic/verifySchedule.js';
import { findGaps } from '../deterministic/coverage.js';

const STAMP = '2026-09-11T00:00:00.000Z';
const LATER = '2026-09-11T12:00:00.000Z';

function question(id, requirementId, category, prompt, difficulty = 2) {
  return {
    id,
    requirement_ids: [requirementId],
    category,
    prompt,
    answer_outline: 'what a strong answer contains',
    difficulty,
    origin: ORIGINS.GENERATED,
    pinned: false,
    updatedAt: STAMP,
  };
}

/** A complete, hand-written kit with provenance already stamped. */
function baseKit() {
  return {
    source: {
      company: 'Acme Logistics',
      company_url: 'http://localhost:8099/acme/',
      role: 'Senior Frontend Engineer',
      location: 'Remote (UK)',
      jd_chars: 420,
      researched_at: STAMP,
      pages_used: ['http://localhost:8099/acme/'],
    },
    company_brief: {
      summary: 'Acme builds routing software for third-party logistics providers.',
      what_they_do: 'Dispatch and route planning.',
      sources: ['http://localhost:8099/acme/'],
      provenance: {
        summary: { origin: ORIGINS.GENERATED, pinned: false, updatedAt: STAMP },
        what_they_do: { origin: ORIGINS.GENERATED, pinned: false, updatedAt: STAMP },
      },
    },
    role: {
      title: 'Senior Frontend Engineer',
      seniority: 'senior',
      responsibilities: ['Own the operator console'],
      requirements: [
        { id: 'r1', text: '5+ years with React', kind: 'technical', priority: 'must' },
        { id: 'r2', text: 'Mentoring juniors', kind: 'behavioural', priority: 'must' },
        { id: 'r3', text: 'Postgres at scale', kind: 'technical', priority: 'must' },
      ],
    },
    questions: [
      question('q1', 'r1', 'technical', 'original technical about r1'),
      question('q2', 'r3', 'technical', 'original technical about r3'),
      question('q3', 'r1', 'technical', 'original technical about r1, second'),
      question('q4', 'r2', 'behavioural', 'original behavioural about r2'),
    ],
    flashcards: [
      { id: 'f1', front: 'Optimistic update', back: 'Apply locally, reconcile later.', requirement_ids: ['r1'], origin: ORIGINS.GENERATED, pinned: false, updatedAt: STAMP },
      { id: 'f2', front: 'Partitioning', back: 'Split a table by a key.', requirement_ids: ['r3'], origin: ORIGINS.GENERATED, pinned: false, updatedAt: STAMP },
    ],
    schedule: {
      days_available: 2,
      days: [
        { day: 1, focus: 'Technical depth', question_ids: ['q1', 'q2'], minutes: 45, origin: ORIGINS.GENERATED, pinned: false, updatedAt: STAMP },
        { day: 2, focus: 'Behavioural', question_ids: ['q3', 'q4'], minutes: 30, origin: ORIGINS.GENERATED, pinned: false, updatedAt: STAMP },
      ],
    },
    coverage: { uncovered_requirement_ids: [], passes: 2 },
  };
}

/** Three replacement technical questions, as a regeneration would return them. */
function incomingTechnical() {
  return [
    { requirement_ids: ['r1'], category: 'technical', prompt: 'REGENERATED technical about r1', answer_outline: 'notes', difficulty: 3 },
    { requirement_ids: ['r3'], category: 'technical', prompt: 'REGENERATED technical about r3', answer_outline: 'notes', difficulty: 1 },
    { requirement_ids: ['r1'], category: 'technical', prompt: 'REGENERATED extra about r1', answer_outline: 'notes', difficulty: 2 },
  ];
}

// ===========================================================================
// EXIT CHECK — the case the brief names
// ===========================================================================

test('EXIT CHECK: an edited question survives a regeneration of its whole category', () => {
  const kit = baseKit();
  kit.questions[2] = markEdited({ ...kit.questions[2], prompt: 'MY EDIT — I rewrote this myself' }, { updatedAt: STAMP });

  const { kit: after, report } = mergeSection({
    kit,
    section: 'questions',
    category: 'technical',
    incoming: incomingTechnical(),
    updatedAt: LATER,
  });

  const q3 = after.questions.find((entry) => entry.id === 'q3');
  assert.equal(q3.prompt, 'MY EDIT — I rewrote this myself', 'the edit must survive verbatim');
  assert.equal(q3.origin, ORIGINS.EDITED, 'and still be marked as edited');
  assert.equal(q3.updatedAt, STAMP, 'an untouched item keeps its own timestamp');

  // The generated ones were replaced.
  assert.deepEqual(report.replaced.sort(), ['q1', 'q2']);
  assert.deepEqual(report.kept, ['q3']);
  assert.match(after.questions.find((entry) => entry.id === 'q1').prompt, /REGENERATED/);

  // Behavioural was not touched at all.
  const q4 = after.questions.find((entry) => entry.id === 'q4');
  assert.equal(q4.prompt, 'original behavioural about r2');
  assert.equal(q4.updatedAt, STAMP);

  assert.equal(validateKit(after).valid, true);
});

test('EXIT CHECK: a pinned generated question survives, and a hand-written one survives', () => {
  const kit = baseKit();
  kit.questions[0] = setPinned(kit.questions[0], true, { updatedAt: STAMP });
  kit.questions[1] = markManual({ ...kit.questions[1], prompt: 'I wrote this from nothing' }, { updatedAt: STAMP });

  const { kit: after, report } = mergeSection({
    kit,
    section: 'questions',
    category: 'technical',
    incoming: incomingTechnical(),
    updatedAt: LATER,
  });

  const q1 = after.questions.find((entry) => entry.id === 'q1');
  assert.equal(q1.prompt, 'original technical about r1', 'pinned content is not replaced');
  assert.equal(q1.origin, ORIGINS.GENERATED, 'and pinning does not pretend a person wrote it');
  assert.equal(q1.pinned, true);

  const q2 = after.questions.find((entry) => entry.id === 'q2');
  assert.equal(q2.prompt, 'I wrote this from nothing');
  assert.equal(q2.origin, ORIGINS.MANUAL);

  assert.deepEqual(report.kept.sort(), ['q1', 'q2']);
  assert.deepEqual(report.replaced, ['q3'], 'only the unprotected one was replaced');
});

// ===========================================================================
// Rule 3 — ids are reused so references stay valid
// ===========================================================================

test('a replacement reuses the id it replaces, so schedule references still resolve', () => {
  const kit = baseKit();
  const beforeIds = kit.schedule.days.flatMap((day) => day.question_ids);

  const { kit: after } = mergeSection({
    kit,
    section: 'questions',
    category: 'technical',
    incoming: incomingTechnical(),
    updatedAt: LATER,
  });

  // Every id the old schedule referenced still exists as a question.
  const ids = new Set(after.questions.map((entry) => entry.id));
  for (const id of beforeIds) {
    assert.ok(ids.has(id), `${id} was referenced by the schedule and must still exist`);
  }

  assert.equal(validateKit(after).valid, true, 'no dangling references');
  const semantics = verifySchedule(after);
  const real = semantics.violations.filter((v) => v.code !== SCHEDULE_VIOLATIONS.MUST_HAS_NO_QUESTION);
  assert.deepEqual(real, []);
});

test('a regeneration that returns fewer questions removes the surplus rather than keeping stale ones', () => {
  const kit = baseKit();

  const { kit: after, report } = mergeSection({
    kit,
    section: 'questions',
    category: 'technical',
    // One replacement for three replaceable technical questions.
    incoming: [{ requirement_ids: ['r1'], category: 'technical', prompt: 'only one back', answer_outline: 'n', difficulty: 2 }],
    updatedAt: LATER,
  });

  assert.equal(report.replaced.length, 1);
  assert.ok(report.removed.length >= 1, 'the unfilled slots are removed, not left stale');
  assert.equal(validateKit(after).valid, true, 'and the schedule no longer references them');
});

test('a replacement must be about the same requirement, or the slot is left empty', () => {
  const kit = baseKit();

  // mergeQuestions returns its report fields directly; only mergeSection nests them.
  const result = mergeQuestions({
    kit,
    category: 'technical',
    // Nothing here covers r3, which q2 was about.
    incoming: [{ requirement_ids: ['r1'], category: 'technical', prompt: 'about r1 only', answer_outline: 'n', difficulty: 2 }],
    updatedAt: LATER,
  });

  assert.ok(result.removed.includes('q2'), 'q2 covered r3; reassigning it to r1 would move coverage silently');
  assert.ok(!result.questions.some((entry) => entry.id === 'q2'), 'and the slot is genuinely empty');
});

// ===========================================================================
// Rule 2 — one section never touches another
// ===========================================================================

test('regenerating questions leaves the brief and flashcards alone', () => {
  const kit = baseKit();
  const briefBefore = structuredClone(kit.company_brief);
  const cardsBefore = structuredClone(kit.flashcards);

  const { kit: after } = mergeSection({
    kit,
    section: 'questions',
    category: 'technical',
    incoming: incomingTechnical(),
    updatedAt: LATER,
  });

  assert.deepEqual(after.company_brief, briefBefore);
  assert.deepEqual(after.flashcards, cardsBefore);
});

test('regenerating one category leaves the others untouched', () => {
  const kit = baseKit();

  const { kit: after } = mergeSection({
    kit,
    section: 'questions',
    category: 'behavioural',
    incoming: [{ requirement_ids: ['r2'], category: 'behavioural', prompt: 'new behavioural', answer_outline: 'n', difficulty: 2 }],
    updatedAt: LATER,
  });

  for (const id of ['q1', 'q2', 'q3']) {
    const before = kit.questions.find((entry) => entry.id === id);
    const current = after.questions.find((entry) => entry.id === id);
    assert.equal(current.prompt, before.prompt, `${id} is technical and must be untouched`);
  }
  assert.match(after.questions.find((entry) => entry.id === 'q4').prompt, /new behavioural/);
});

test('an unknown section is refused rather than silently ignored', () => {
  assert.throws(
    () => mergeSection({ kit: baseKit(), section: 'role', incoming: {} }),
    /MERGE_UNKNOWN_SECTION/
  );
  assert.deepEqual(MERGEABLE_SECTIONS, ['company_brief', 'questions', 'flashcards', 'schedule']);
});

// ===========================================================================
// Rule 4 — derived values are recomputed
// ===========================================================================

test('coverage and the schedule are recomputed after a merge, never carried over', () => {
  const kit = baseKit();
  // Stale values that must not survive: a gap that no longer exists and a day count of 2
  // while the schedule is about to be rebuilt.
  kit.coverage.uncovered_requirement_ids = ['r1'];

  const { kit: after } = mergeSection({
    kit,
    section: 'questions',
    category: 'technical',
    incoming: incomingTechnical(),
    updatedAt: LATER,
  });

  const gaps = findGaps(after.role.requirements, after.questions);
  assert.deepEqual(
    after.coverage.uncovered_requirement_ids,
    gaps.uncovered_requirement_ids,
    'coverage must match a fresh deterministic check'
  );
  assert.equal(after.coverage.passes, 2, 'a merge is not a generation pass and must not inflate the count');
  assert.equal(after.schedule.days.length, 2);
});

test('a pinned schedule day keeps its arrangement but not references to deleted questions', () => {
  const kit = baseKit();
  kit.schedule.days[1] = setPinned({ ...kit.schedule.days[1], focus: 'MY ARRANGEMENT' }, true, { updatedAt: STAMP });

  const { kit: after } = mergeSection({
    kit,
    section: 'questions',
    category: 'technical',
    // Only r1 comes back, so q2 (r3) is removed entirely.
    incoming: [{ requirement_ids: ['r1'], category: 'technical', prompt: 'one back', answer_outline: 'n', difficulty: 2 }],
    updatedAt: LATER,
  });

  const day2 = after.schedule.days.find((day) => day.day === 2);
  assert.equal(day2.focus, 'MY ARRANGEMENT', 'the pinned arrangement survives');
  assert.equal(day2.pinned, true);

  const ids = new Set(after.questions.map((entry) => entry.id));
  for (const id of day2.question_ids) {
    assert.ok(ids.has(id), `a pinned day must not reference deleted question ${id}`);
  }
  assert.equal(validateKit(after).valid, true);
});

test('recomputeDerived does not mutate the kit it is given', () => {
  const kit = baseKit();
  const snapshot = structuredClone(kit);
  recomputeDerived(kit, { updatedAt: LATER });
  assert.deepEqual(kit, snapshot);
});

// ===========================================================================
// Flashcards and the brief
// ===========================================================================

test('an edited flashcard survives a flashcard regeneration', () => {
  const kit = baseKit();
  kit.flashcards[0] = markEdited({ ...kit.flashcards[0], back: 'MY corrected answer' }, { updatedAt: STAMP });

  const { kit: after, report } = mergeSection({
    kit,
    section: 'flashcards',
    incoming: [
      { front: 'new front A', back: 'new back A', requirement_ids: ['r1'] },
      { front: 'new front B', back: 'new back B', requirement_ids: ['r3'] },
    ],
    updatedAt: LATER,
  });

  assert.equal(after.flashcards.find((card) => card.id === 'f1').back, 'MY corrected answer');
  assert.deepEqual(report.kept, ['f1']);
  assert.deepEqual(report.replaced, ['f2']);
  assert.equal(validateKit(after).valid, true);
});

test('an edited brief field survives while a generated one is replaced', () => {
  const kit = baseKit();
  kit.company_brief.summary = 'MY summary, which I rewrote';
  kit.company_brief.provenance.summary = markEdited(kit.company_brief.provenance.summary, { updatedAt: STAMP });

  const { company_brief: merged, replaced, kept } = mergeCompanyBrief({
    kit,
    incoming: { summary: 'regenerated summary', what_they_do: 'regenerated what they do' },
    updatedAt: LATER,
  });

  assert.equal(merged.summary, 'MY summary, which I rewrote');
  assert.equal(merged.what_they_do, 'regenerated what they do');
  assert.deepEqual(kept, ['summary']);
  assert.deepEqual(replaced, ['what_they_do']);
});

test('a regenerated brief cannot introduce a source nobody fetched', () => {
  const kit = baseKit();

  const { company_brief: merged } = mergeCompanyBrief({
    kit,
    incoming: {
      summary: 'regenerated',
      what_they_do: 'regenerated',
      sources: ['http://invented.test/about'],
    },
    updatedAt: LATER,
  });

  assert.deepEqual(merged.sources, ['http://localhost:8099/acme/'], 'the ledger decides sources, not a regeneration');
});

// ===========================================================================
// Provenance itself
// ===========================================================================

test('the replaceability rule covers every combination', () => {
  assert.equal(isReplaceable({ origin: ORIGINS.GENERATED, pinned: false }), true);
  assert.equal(isReplaceable({ origin: ORIGINS.GENERATED, pinned: true }), false);
  assert.equal(isReplaceable({ origin: ORIGINS.EDITED, pinned: false }), false);
  assert.equal(isReplaceable({ origin: ORIGINS.MANUAL, pinned: false }), false);
  assert.equal(isReplaceable({}), true, 'an unstamped item predates provenance; no human claimed it');
  assert.equal(isReplaceable({ origin: 'gibberish' }), true, 'an unknown origin reads as generated');
  assert.equal(isProtected({ origin: ORIGINS.EDITED }), true);
});

test('editing a hand-written item leaves it manual', () => {
  assert.equal(markEdited({ origin: ORIGINS.MANUAL }).origin, ORIGINS.MANUAL);
  assert.equal(markEdited({ origin: ORIGINS.GENERATED }).origin, ORIGINS.EDITED);
});

test('stampKit gives every item provenance and keeps the kit valid', () => {
  const bare = baseKit();
  for (const entry of bare.questions) {
    delete entry.origin;
    delete entry.pinned;
    delete entry.updatedAt;
  }

  stampKit(bare, { updatedAt: STAMP });

  assert.ok(bare.questions.every((entry) => entry.origin === ORIGINS.GENERATED && entry.pinned === false));
  assert.ok(bare.schedule.days.every((day) => day.origin === ORIGINS.GENERATED));
  assert.deepEqual(Object.keys(bare.company_brief.provenance).sort(), ['summary', 'what_they_do']);
  assert.equal(validateKit(bare).valid, true);
});

test('provenanceSummary answers how much the model wrote', () => {
  const kit = baseKit();
  kit.questions[0] = markEdited(kit.questions[0]);
  kit.questions[1] = markManual(kit.questions[1]);
  kit.questions[2] = setPinned(kit.questions[2], true);

  const tally = provenanceSummary(kit);
  assert.equal(tally.edited, 1);
  assert.equal(tally.manual, 1);
  assert.equal(tally.pinned, 1);
  assert.equal(tally.total, kit.questions.length + kit.flashcards.length + kit.schedule.days.length);
});

test('merging into a kit never mutates the original', () => {
  const kit = baseKit();
  const snapshot = structuredClone(kit);

  mergeSection({ kit, section: 'questions', category: 'technical', incoming: incomingTechnical(), updatedAt: LATER });

  assert.deepEqual(kit, snapshot, 'a caller holding the old kit must still hold the old kit');
});

test('repeated regenerations keep converging on a valid kit', () => {
  let kit = baseKit();
  kit.questions[2] = markEdited(kit.questions[2], { updatedAt: STAMP });

  for (let round = 0; round < 5; round += 1) {
    const result = mergeSection({
      kit,
      section: 'questions',
      category: 'technical',
      incoming: incomingTechnical(),
      updatedAt: LATER,
    });
    kit = result.kit;

    assert.equal(validateKit(kit).valid, true, `round ${round} produced an invalid kit`);
    assert.equal(
      kit.questions.find((entry) => entry.id === 'q3').origin,
      ORIGINS.EDITED,
      `round ${round} lost the edit`
    );
  }

  // Ids must not grow without bound across rounds.
  assert.ok(kit.questions.length <= 8, `question count ran away: ${kit.questions.length}`);
});
