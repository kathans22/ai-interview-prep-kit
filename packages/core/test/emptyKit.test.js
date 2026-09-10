/**
 * emptyKit.test.js — tests for the assembly target.
 *
 * Decides: that the skeleton carries every contract field, that its schedule length
 * always matches days_available, and that two calls never share mutable state.
 *
 * Does NOT decide: validity as judged by validateKit — that pairing is asserted in
 * validateKit.test.js, once the validator exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyKit, createEmptyResults, emptyScheduleDay } from '../contracts/emptyKit.js';
import { KIT_TOP_LEVEL_KEYS, KIT_SECTION_KEYS } from '../contracts/kitSchema.js';

test('an empty kit carries every top-level key', () => {
  const kit = createEmptyKit();
  for (const key of KIT_TOP_LEVEL_KEYS) {
    assert.ok(key in kit, `missing top-level key: ${key}`);
  }
});

test('an empty kit carries every key of every section', () => {
  const kit = createEmptyKit();
  for (const key of KIT_SECTION_KEYS.source) assert.ok(key in kit.source, `source.${key}`);
  for (const key of KIT_SECTION_KEYS.company_brief) {
    assert.ok(key in kit.company_brief, `company_brief.${key}`);
  }
  for (const key of KIT_SECTION_KEYS.role) assert.ok(key in kit.role, `role.${key}`);
  for (const key of KIT_SECTION_KEYS.schedule) assert.ok(key in kit.schedule, `schedule.${key}`);
  for (const key of KIT_SECTION_KEYS.coverage) assert.ok(key in kit.coverage, `coverage.${key}`);
});

test('schedule.days always has exactly days_available entries', () => {
  for (const daysAvailable of [0, 1, 5, 14]) {
    const kit = createEmptyKit({ daysAvailable });
    assert.equal(kit.schedule.days_available, daysAvailable);
    assert.equal(kit.schedule.days.length, daysAvailable);
    assert.deepEqual(
      kit.schedule.days.map((entry) => entry.day),
      Array.from({ length: daysAvailable }, (_, index) => index + 1),
      'day numbers must run 1..N with no gaps'
    );
  }
});

test('minutes are integers, never floats', () => {
  const kit = createEmptyKit({ daysAvailable: 3, minutesPerDay: 60 });
  for (const day of kit.schedule.days) {
    assert.ok(Number.isInteger(day.minutes), `day ${day.day} minutes must be an integer`);
    assert.equal(day.minutes, 60);
  }
});

test('source.role is the advertised role string, distinct from the role object', () => {
  const kit = createEmptyKit({ role: 'Senior Frontend Engineer' });
  assert.equal(kit.source.role, 'Senior Frontend Engineer');
  assert.equal(kit.role.title, '', 'the role object is a separate field and stays empty');
  assert.equal(typeof kit.source.role, 'string');
  assert.equal(typeof kit.role, 'object');
});

test('seed values land in source, and researched_at defaults to an ISO timestamp', () => {
  const kit = createEmptyKit({
    company: 'Acme',
    companyUrl: 'http://localhost:8099/acme/',
    location: 'Remote',
    jdChars: 1420,
  });

  assert.equal(kit.source.company, 'Acme');
  assert.equal(kit.source.company_url, 'http://localhost:8099/acme/');
  assert.equal(kit.source.location, 'Remote');
  assert.equal(kit.source.jd_chars, 1420);
  assert.match(kit.source.researched_at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
});

test('two kits never share mutable state', () => {
  const first = createEmptyKit({ daysAvailable: 2 });
  const second = createEmptyKit({ daysAvailable: 2 });

  first.role.requirements.push({ id: 'r1' });
  first.schedule.days[0].question_ids.push('q1');
  first.source.pages_used.push('http://example.test/');

  assert.deepEqual(second.role.requirements, [], 'requirements array must not be shared');
  assert.deepEqual(second.schedule.days[0].question_ids, [], 'day arrays must not be shared');
  assert.deepEqual(second.source.pages_used, [], 'pages_used must not be shared');
});

test('invalid seeds fail loudly with coded errors', () => {
  assert.throws(() => createEmptyKit({ daysAvailable: -1 }), /EMPTY_KIT_INVALID_DAYS/);
  assert.throws(() => createEmptyKit({ daysAvailable: 2.5 }), /EMPTY_KIT_INVALID_DAYS/);
  assert.throws(() => createEmptyKit({ minutesPerDay: 45.5 }), /EMPTY_KIT_INVALID_MINUTES/);
});

test('emptyScheduleDay produces a contract-shaped day', () => {
  const day = emptyScheduleDay(3, 90);
  for (const key of KIT_SECTION_KEYS.scheduleDay) assert.ok(key in day, `day.${key}`);
  assert.deepEqual(day, { day: 3, focus: '', question_ids: [], minutes: 90 });
});

test('the results envelope matches Frozen Contract 2', () => {
  const results = createEmptyResults('2026-09-01T09:12:44Z');
  assert.deepEqual(results, { version: '1.0', generated_at: '2026-09-01T09:12:44Z', kits: [] });
});
