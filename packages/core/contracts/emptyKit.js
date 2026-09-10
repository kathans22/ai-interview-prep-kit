/**
 * emptyKit.js — a structurally valid kit containing no content.
 *
 * Decides: the starting shape every pipeline run assembles into. Because the skeleton is
 * valid before anything is generated, a run that loses its hiring page, exhausts its call
 * budget or trips the time governor still emits a kit that passes validateKit — with the
 * gaps visible in it — rather than emitting nothing. That is what keeps a degraded case
 * "ok" instead of "failed".
 *
 * Does NOT decide: what any field should contain, whether the result is any good, or
 * when to stop filling it in. It performs no I/O and calls no model.
 *
 * Every call returns a fresh deep structure. Sharing one frozen template would let two
 * concurrent cases push requirements into the same array.
 */

import { KIT_CONTRACT_VERSION } from './kitSchema.js';

/**
 * A schedule day with no content assigned.
 *
 * @param {number} day 1-based day number
 * @param {number} minutes integer minutes; the contract forbids floats
 */
export function emptyScheduleDay(day, minutes = 0) {
  return {
    day,
    focus: '',
    question_ids: [],
    minutes,
  };
}

/**
 * Build an empty kit.
 *
 * @param {object} [seed]
 * @param {number} [seed.daysAvailable=0] how many day entries to create. schedule.days
 *   always has exactly this length — the validator enforces the equality, so the factory
 *   must not produce a skeleton that breaks it.
 * @param {number} [seed.minutesPerDay=0] integer minutes stamped on each created day
 * @param {string} [seed.company]
 * @param {string} [seed.companyUrl]
 * @param {string} [seed.role] the role as advertised — source.role, a STRING. This is a
 *   different field from the top-level role OBJECT and is not interchangeable with it.
 * @param {string} [seed.location]
 * @param {number} [seed.jdChars=0]
 * @param {string} [seed.researchedAt] ISO 8601 UTC; defaults to now
 * @returns {object} a kit that satisfies validateKit with empty content
 */
export function createEmptyKit(seed = {}) {
  const {
    daysAvailable = 0,
    minutesPerDay = 0,
    company = '',
    companyUrl = '',
    role = '',
    location = '',
    jdChars = 0,
    researchedAt = new Date().toISOString(),
  } = seed;

  if (!Number.isInteger(daysAvailable) || daysAvailable < 0) {
    throw new Error(
      `EMPTY_KIT_INVALID_DAYS: daysAvailable must be a non-negative integer, got ${daysAvailable}.`
    );
  }
  if (!Number.isInteger(minutesPerDay) || minutesPerDay < 0) {
    throw new Error(
      `EMPTY_KIT_INVALID_MINUTES: minutesPerDay must be a non-negative integer, got ${minutesPerDay}.`
    );
  }

  const days = [];
  for (let day = 1; day <= daysAvailable; day += 1) {
    days.push(emptyScheduleDay(day, minutesPerDay));
  }

  return {
    source: {
      company,
      company_url: companyUrl,
      role,
      location,
      jd_chars: jdChars,
      researched_at: researchedAt,
      pages_used: [],
    },
    company_brief: {
      summary: '',
      what_they_do: '',
      sources: [],
    },
    role: {
      title: '',
      seniority: '',
      responsibilities: [],
      requirements: [],
    },
    questions: [],
    flashcards: [],
    schedule: {
      days_available: daysAvailable,
      days,
    },
    coverage: {
      uncovered_requirement_ids: [],
      passes: 0,
    },
  };
}

/**
 * The results-document envelope from Frozen Contract 2, with no kits in it yet.
 *
 * @param {string} [generatedAt] ISO 8601 UTC
 */
export function createEmptyResults(generatedAt = new Date().toISOString()) {
  return {
    version: KIT_CONTRACT_VERSION,
    generated_at: generatedAt,
    kits: [],
  };
}
