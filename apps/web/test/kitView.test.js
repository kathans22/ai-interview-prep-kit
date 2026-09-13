/**
 * kitView.test.js — arranging a finished kit for reading.
 *
 * Two assertions matter more than the rest. The mirrored enum strings must equal the
 * contract's — imported from core here, where a test may, because the client itself does
 * not import core. And the coverage panel must never report fewer gaps than the kit
 * recorded, including gaps whose requirement no longer resolves.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUESTION_CATEGORIES,
  REQUIREMENT_KINDS,
  REQUIREMENT_PRIORITIES,
} from '@aipk/core/contracts/kitSchema.js';

import {
  CATEGORY_LABELS,
  KIND_LABELS,
  PRIORITY_LABELS,
  QUESTION_CATEGORY_ORDER,
  SECTION_MISSING,
  deriveSectionState,
  describeCoverage,
  describeSchedule,
  formatMinutes,
  groupQuestions,
  provenanceBadges,
} from '../src/kits/kitView.js';

const values = (enumLike) => (Array.isArray(enumLike) ? [...enumLike] : Object.values(enumLike));

test('the mirrored enums are exactly the contract enums', () => {
  assert.deepEqual([...QUESTION_CATEGORY_ORDER].sort(), values(QUESTION_CATEGORIES).sort());
  assert.deepEqual(Object.keys(CATEGORY_LABELS).sort(), values(QUESTION_CATEGORIES).sort());
  assert.deepEqual(Object.keys(KIND_LABELS).sort(), values(REQUIREMENT_KINDS).sort());
  assert.deepEqual(Object.keys(PRIORITY_LABELS).sort(), values(REQUIREMENT_PRIORITIES).sort());
});

test('questions group in contract order, and all four groups come back even when empty', () => {
  const groups = groupQuestions([
    { id: 'q1', category: 'system-design' },
    { id: 'q2', category: 'technical' },
    { id: 'q3', category: 'technical' },
  ]);

  assert.deepEqual(
    groups.map((group) => group.category),
    ['technical', 'behavioural', 'system-design', 'company-fit']
  );
  assert.deepEqual(groups[0].questions.map((q) => q.id), ['q2', 'q3'], 'order within a category is kept');
  assert.equal(groups[1].questions.length, 0, 'an empty category is still a place to add into');
});

test('a question in an unknown category is shown under its own name, never dropped', () => {
  const groups = groupQuestions([{ id: 'q1', category: 'mystery' }]);
  assert.equal(groups.length, 5);
  assert.equal(groups[4].label, 'mystery');
  assert.equal(groups[4].questions.length, 1);
});

test('generated items carry no badge; edited, manual and pinned do', () => {
  assert.deepEqual(provenanceBadges({ origin: 'generated', pinned: false }), []);
  assert.deepEqual(
    provenanceBadges({ origin: 'edited', pinned: true }).map((b) => b.text),
    ['Edited', 'Pinned']
  );
  assert.deepEqual(provenanceBadges({ origin: 'manual' }).map((b) => b.text), ['Added by you']);
});

test('minutes read as hours and minutes', () => {
  assert.equal(formatMinutes(50), '50 min');
  assert.equal(formatMinutes(120), '2 h');
  assert.equal(formatMinutes(130), '2 h 10 min');
  assert.equal(formatMinutes(undefined), '0 min');
});

const REQUIREMENTS = [
  { id: 'r1', text: 'React', kind: 'technical', priority: 'nice' },
  { id: 'r2', text: 'Mentoring', kind: 'behavioural', priority: 'must' },
];

test('no gaps reads as full coverage, with the passes counted', () => {
  const view = describeCoverage({ uncovered_requirement_ids: [], passes: 2 }, REQUIREMENTS);
  assert.equal(view.summary, 'Every requirement has at least one question.');
  assert.equal(view.passesText, '2 coverage passes were run.');
  assert.equal(view.gaps.length, 0);
});

test('gaps are sentences naming the requirement, must-haves first', () => {
  const view = describeCoverage({ uncovered_requirement_ids: ['r1', 'r2'], passes: 1 }, REQUIREMENTS);

  assert.deepEqual(view.gaps.map((gap) => gap.id), ['r2', 'r1'], 'the must-have leads');
  assert.match(view.gaps[0].sentence, /Mentoring/);
  assert.match(view.gaps[0].sentence, /must-have/);
  assert.doesNotMatch(view.gaps[0].sentence, /\br2\b/, 'the id is not the sentence');
  assert.match(view.summary, /2 requirements have no question yet, 1 of them must-haves/);
  assert.equal(view.passesText, '1 coverage pass was run.');
});

test('a gap whose requirement no longer resolves is still reported', () => {
  const view = describeCoverage({ uncovered_requirement_ids: ['r9'], passes: 1 }, REQUIREMENTS);
  assert.equal(view.gaps.length, 1, 'never fewer gaps than the kit recorded');
  assert.match(view.gaps[0].sentence, /r9/);
});

test('the schedule resolves question ids and flags any that do not resolve', () => {
  const view = describeSchedule(
    {
      days_available: 2,
      days: [
        { day: 1, focus: 'Depth', minutes: 90, kind: 'new', question_ids: ['q1', 'q404'] },
        { day: 2, focus: 'Review', minutes: 30, kind: 'review', question_ids: ['q1'], pinned: true },
      ],
    },
    [{ id: 'q1', prompt: 'Explain closures' }]
  );

  assert.equal(view.totalMinutes, 120);
  assert.equal(view.days[0].questions[0].question.prompt, 'Explain closures');
  assert.equal(view.days[0].questions[1].question, null, 'kept and flagged, not dropped');
  assert.equal(view.days[0].kindLabel, 'New material');
  assert.equal(view.days[1].pinned, true);
});

test('a missing section is an error in that section only, and offers no retry', () => {
  const state = deriveSectionState({ present: false });
  assert.equal(state.status, 'error');
  assert.equal(state.error, SECTION_MISSING);
  assert.equal(state.error.status, undefined, 'no status means ErrorState offers no retry');

  assert.equal(deriveSectionState({ present: true, isEmpty: true }).isEmpty, true);
  assert.equal(deriveSectionState({ present: true, busy: true }).status, 'loading');
  assert.equal(deriveSectionState({ present: true }).status, 'ready');
});
