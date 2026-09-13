// Regeneration, from the client's side: the preview must promise exactly what core's
// merge will do, and the summary must say what the server's report says it did.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isReplaceable } from '@aipk/core/contracts/provenance.js';

import {
  describeTarget,
  previewRegeneration,
  summariseRegeneration,
  targetKey,
  willBeReplaced,
} from '../src/kits/regeneration.js';

const q = (id, category, extra = {}) => ({ id, category, prompt: id, origin: 'generated', pinned: false, ...extra });

test('the preview decides "replaced" exactly as core does', () => {
  const cases = [
    null,
    {},
    { origin: 'generated' },
    { origin: 'generated', pinned: true },
    { origin: 'edited' },
    { origin: 'edited', pinned: true },
    { origin: 'manual' },
    { origin: 'manual', pinned: false },
    { origin: 'bogus' },
    { pinned: 'true' },
  ];
  for (const item of cases) {
    assert.equal(willBeReplaced(item), isReplaceable(item), JSON.stringify(item));
  }
});

test('previewing a category lists only that category, with the reason each kept one is kept', () => {
  const kit = {
    questions: [
      q('q1', 'technical'),
      q('q2', 'technical', { origin: 'edited' }),
      q('q3', 'behavioural'),
      q('q4', 'technical', { pinned: true }),
      q('q5', 'technical', { origin: 'manual', pinned: true }),
      q('pending-1', 'technical', { origin: 'manual', pendingAdd: true }),
      q('q6', 'technical', { pendingDelete: true }),
    ],
  };
  const preview = previewRegeneration(kit, { section: 'questions', category: 'technical' });
  assert.deepEqual(preview.replaced.map((entry) => entry.id), ['q1']);
  assert.deepEqual(
    preview.kept.map((entry) => [entry.id, entry.because]),
    [
      ['q2', ['edited']],
      ['q4', ['pinned']],
      ['q5', ['added by you', 'pinned']],
    ]
  );
});

test('previewing the brief treats a field with no provenance as generated', () => {
  const preview = previewRegeneration(
    { company_brief: { summary: 's', what_they_do: 'w', provenance: { what_they_do: { origin: 'edited' } } } },
    { section: 'company_brief' }
  );
  assert.deepEqual(preview.replaced, [{ id: 'summary', label: 'Summary' }]);
  assert.deepEqual(preview.kept, [{ id: 'what_they_do', label: 'What they do', because: ['edited'] }]);
});

test('previewing the schedule keeps the days a person arranged', () => {
  const preview = previewRegeneration(
    { schedule: { days: [{ day: 1, origin: 'generated' }, { day: 2, origin: 'edited', pinned: true }] } },
    { section: 'schedule' }
  );
  assert.deepEqual(preview.replaced.map((entry) => entry.label), ['Day 1']);
  assert.deepEqual(preview.kept, [{ id: 'day-2', label: 'Day 2', because: ['arranged by you'] }]);
});

test('a question regeneration is summarised from the report, and highlights replaced and new', () => {
  const summary = summariseRegeneration({
    target: { section: 'questions', category: 'technical' },
    report: { replaced: ['q1', 'q4'], kept: ['q2'], added: ['q9'], removed: ['q7'] },
  });
  assert.equal(
    summary.text,
    '2 questions replaced, 1 kept because you changed or pinned it, 1 new, q7 removed because nothing came back to replace it. The new ones are highlighted.'
  );
  assert.deepEqual([...summary.changed], ['q1', 'q4', 'q9']);
  assert.deepEqual([...summary.added], ['q9']);
});

test('a regeneration that replaced nothing says so plainly', () => {
  const summary = summariseRegeneration({
    target: { section: 'questions', category: 'technical' },
    report: { replaced: [], kept: ['q2', 'q3'], added: [], removed: [] },
  });
  assert.equal(summary.text, 'No questions replaced, 2 kept because you changed or pinned them.');
  assert.equal(summary.changed.size, 0);
});

test('a brief regeneration names the fields it rewrote and kept', () => {
  const summary = summariseRegeneration({
    target: { section: 'company_brief' },
    report: { replaced: ['summary'], kept: ['what_they_do'] },
  });
  assert.equal(summary.text, 'Summary rewritten; What they do kept because you changed or pinned it.');
  assert.deepEqual([...summary.changed], ['summary']);
});

test('a schedule rebuild is summarised by comparing days, since its report is empty', () => {
  const before = { schedule: { days: [
    { day: 1, question_ids: ['q1'], minutes: 30, origin: 'generated' },
    { day: 2, question_ids: ['q2'], minutes: 30, origin: 'edited', pinned: true },
    { day: 3, question_ids: ['q3'], minutes: 30, origin: 'generated' },
  ] } };
  const after = { schedule: { days: [
    { day: 1, question_ids: ['q1'], minutes: 30, origin: 'generated' },
    { day: 2, question_ids: ['q2'], minutes: 30, origin: 'edited', pinned: true },
    { day: 3, question_ids: ['q3', 'q4'], minutes: 45, origin: 'generated' },
  ] } };
  const summary = summariseRegeneration({ target: { section: 'schedule' }, report: { replaced: [], kept: [] }, before, after });
  assert.equal(summary.text, 'Day 3 changed; day 2 kept because you arranged it.');
  assert.deepEqual([...summary.changed], ['3']);

  const same = summariseRegeneration({ target: { section: 'schedule' }, report: {}, before, after: before });
  assert.equal(same.text, 'The schedule came out the same; day 2 kept because you arranged it.');
});

test('targets have one key each and a name that says what they regenerate', () => {
  assert.equal(targetKey({ section: 'questions', category: 'technical' }), 'questions:technical');
  assert.equal(targetKey({ section: 'company_brief' }), 'company_brief');
  assert.equal(describeTarget({ section: 'questions', category: 'technical' }).action, 'Regenerate Technical questions');
  assert.equal(describeTarget({ section: 'schedule' }).action, 'Rebuild the schedule');
});
