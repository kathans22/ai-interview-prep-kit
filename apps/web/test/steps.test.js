/**
 * steps.test.js — deriving the step list from a progress log.
 *
 * Two things here are worth more than the rest.
 *
 * DEGRADED MUST NOT READ AS FAILED. A degraded step ran and produced less than it might
 * have, which is the outcome this whole pipeline is designed to produce under pressure.
 * Rendering it as a failure would make an honest partial kit look broken, and the brief
 * says partial failure must look partial.
 *
 * NO CODE MAY REACH THE SCREEN. The brief is explicit — skip reasons in plain words,
 * "No hiring page found on this site", not `NO_HIRING_PAGE_FOUND`. A code leaking
 * through is not a crash, it is a sentence nobody outside this repo can read, so it is
 * asserted rather than eyeballed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAILURE_WORDS,
  REASON_WORDS,
  STEP_LABELS,
  STEP_ORDER,
  STEP_STATES,
  deriveSteps,
  describeEntry,
  humaniseCode,
  summarise,
} from '../src/kits/steps.js';

/** The nine the stage's prose names, in its own words. */
const NAMED_BY_THE_BRIEF = [
  'requirements',
  'role-profile',
  'crawl',
  'hiring-page',
  'public-discussion',
  'company-brief',
  'questions',
  'coverage',
  'schedule',
];

const at = (n) => `2026-09-12T10:0${n}:00.000Z`;
const find = (steps, id) => steps.find((step) => step.id === id);

// --- the catalogue ----------------------------------------------------------

test('every step the orchestrator emits has a label, and every label names a real step', () => {
  for (const id of STEP_ORDER) {
    assert.ok(STEP_LABELS[id], `${id} has no label`);
  }
  // `resume` is emitted by the resume route rather than the orchestrator, so it is
  // labelled but deliberately absent from the sequence.
  const labelled = Object.keys(STEP_LABELS).filter((id) => id !== 'resume');
  assert.deepEqual([...labelled].sort(), [...STEP_ORDER].sort());
});

test('all nine steps the brief names are present, alongside the five it does not', () => {
  for (const id of NAMED_BY_THE_BRIEF) assert.ok(STEP_ORDER.includes(id), id);
  assert.equal(STEP_ORDER.length, 14);
});

// --- state derivation -------------------------------------------------------

test('with no events every step is waiting — pending is the absence of an event', () => {
  const steps = deriveSteps([]);
  assert.equal(steps.length, 14);
  assert.ok(steps.every((step) => step.state === STEP_STATES.pending));
  assert.ok(steps.every((step) => step.note === null));
});

test('started reads as running, and done as done', () => {
  const steps = deriveSteps([
    { step: 'requirements', status: 'started', at: at(1) },
    { step: 'requirements', status: 'done', detail: { count: 4 }, at: at(2) },
    { step: 'role-profile', status: 'started', at: at(3) },
  ]);

  assert.equal(find(steps, 'requirements').state, STEP_STATES.done);
  assert.equal(find(steps, 'role-profile').state, STEP_STATES.running);
  assert.equal(find(steps, 'crawl').state, STEP_STATES.pending);
});

test('DEGRADED is done and partial, never failed', () => {
  const steps = deriveSteps([
    { step: 'company-brief', status: 'started', at: at(1) },
    { step: 'company-brief', status: 'degraded', detail: { reason: 'NO_PAGES_RETRIEVED' }, at: at(2) },
  ]);

  const brief = find(steps, 'company-brief');
  assert.equal(brief.state, STEP_STATES.done, 'a degraded step still ran');
  assert.equal(brief.partial, true);
  assert.match(brief.note, /no brief was written rather than one invented/);
});

test('the last entry decides the state, and earlier notes are kept', () => {
  // A requirement dropped for missing evidence is reported as a degraded entry, and the
  // step then reports done. The reader still needs to know a requirement was dropped.
  const steps = deriveSteps([
    { step: 'requirements', status: 'started', at: at(1) },
    { step: 'requirements', status: 'degraded', detail: { reason: 'CHECKPOINT_ABSENT' }, at: at(2) },
    { step: 'requirements', status: 'done', detail: { count: 4 }, at: at(3) },
  ]);

  const requirements = find(steps, 'requirements');
  assert.equal(requirements.state, STEP_STATES.done);
  assert.equal(requirements.partial, true);
  assert.equal(requirements.notes.length, 1);
  assert.match(requirements.notes[0], /no saved checkpoint/i);
});

test('a replayed started frame cannot drag a finished step back to running', () => {
  // The server replays its whole log on every connection, so a `started` frame can
  // arrive AFTER the `done` it precedes. A row decided by arrival order slides from
  // Done back to Running while its own note still says what it found — which is exactly
  // what a browser run showed before the state was ranked instead of ordered.
  const steps = deriveSteps([
    { step: 'hiring-page', status: 'degraded', detail: { reason: 'NO_HIRING_PAGE_FOUND' }, at: at(2) },
    { step: 'hiring-page', status: 'started', at: at(1) },
  ]);

  const hiringPage = find(steps, 'hiring-page');
  assert.equal(hiringPage.state, STEP_STATES.done);
  assert.equal(hiringPage.partial, true);
});

test('an entry with no timestamp never displaces a stamped terminal one', () => {
  const steps = deriveSteps([
    { step: 'schedule', status: 'done', at: at(2) },
    { step: 'schedule', status: 'started' },
  ]);
  assert.equal(find(steps, 'schedule').state, STEP_STATES.done);
});

test('among terminal entries the later one wins, which is how coverage advances', () => {
  const steps = deriveSteps([
    { step: 'coverage', status: 'done', detail: { pass: 2 }, at: at(3) },
    { step: 'coverage', status: 'done', detail: { pass: 1 }, at: at(1) },
  ]);
  assert.equal(find(steps, 'coverage').label, 'Coverage pass 2');
});

test('a skipped step says why, in the brief own example wording', () => {
  const steps = deriveSteps([{ step: 'hiring-page', status: 'degraded', detail: { reason: 'NO_HIRING_PAGE_FOUND' }, at: at(1) }]);
  assert.equal(find(steps, 'hiring-page').note, 'No hiring page found on this site.');
});

test('the time governor and the budget both explain themselves', () => {
  const governed = deriveSteps([{ step: 'flashcards', status: 'skipped', detail: { reason: 'TIME_GOVERNOR' }, at: at(1) }]);
  assert.equal(find(governed, 'flashcards').state, STEP_STATES.skipped);
  assert.match(find(governed, 'flashcards').note, /time budget/);

  const broke = deriveSteps([{ step: 'flashcards', status: 'skipped', detail: { reason: 'BUDGET_EXHAUSTED' }, at: at(1) }]);
  assert.match(find(broke, 'flashcards').note, /allowance of model calls/);
});

test('a failed step is failed, and its code becomes a sentence', () => {
  const steps = deriveSteps([{ step: 'questions', status: 'failed', detail: { code: 'LLM_RATE_LIMITED' }, at: at(1) }]);
  const questions = find(steps, 'questions');

  assert.equal(questions.state, STEP_STATES.failed);
  assert.equal(questions.note, 'The model hit its rate limit.');
  assert.doesNotMatch(questions.note, /LLM_|_/, 'a code must never reach the screen');
});

test('the coverage row carries the pass number the brief asks for', () => {
  const steps = deriveSteps([
    { step: 'coverage', status: 'done', detail: { pass: 1, uncoveredMust: 1 }, at: at(1) },
    { step: 'gap-fill', status: 'done', detail: { pass: 1 }, at: at(2) },
    { step: 'coverage', status: 'done', detail: { pass: 2, uncoveredMust: 0 }, at: at(3) },
  ]);

  assert.equal(find(steps, 'coverage').label, 'Coverage pass 2', 'the highest pass seen');
  assert.equal(find(steps, 'coverage').pass, 2);
});

test('the job runner own build envelope is not rendered as a step', () => {
  // It duplicates the kit status, adds a redundant row, and — starting first and ending
  // last — would make the summary read "Build…" for the whole run.
  const steps = deriveSteps([
    { step: 'build', status: 'started', at: at(1) },
    { step: 'requirements', status: 'started', at: at(2) },
  ]);

  assert.equal(steps.length, 14);
  assert.equal(
    steps.find((step) => step.id === 'build'),
    undefined
  );
  assert.equal(summarise(steps, 'running'), 'Extracting requirements…', 'the summary names a real step');
});

test('a step the catalogue does not know still gets a row', () => {
  // `resume` is the marker that says this build is a continuation. Dropping unknown
  // steps would hide it.
  const steps = deriveSteps([{ step: 'resume', status: 'started', detail: { from: 'checkpoint' }, at: at(1) }]);

  assert.equal(steps.length, 15);
  assert.equal(steps[14].id, 'resume');
  assert.equal(steps[14].label, 'Resuming');
});

test('an unmapped code is humanised rather than printed raw', () => {
  assert.equal(humaniseCode('SOME_FUTURE_REASON'), 'Some future reason.');
  const steps = deriveSteps([{ step: 'crawl', status: 'skipped', detail: { reason: 'SOME_FUTURE_REASON' }, at: at(1) }]);
  assert.equal(find(steps, 'crawl').note, 'Some future reason.');
});

test('reasons that mean success produce no note at all', () => {
  for (const reason of ['HIRING_PAGE_FOUND', 'GROUNDED_IN_RETRIEVED_PAGES', 'PROCESS_EXTRACTED', 'CHECKPOINT_RESTORED']) {
    assert.equal(describeEntry({ detail: { reason } }), null, reason);
  }
  assert.equal(describeEntry({ status: 'done', detail: { count: 4 } }), null);
});

test('no translation leaks a code — every mapped sentence is prose', () => {
  for (const [code, words] of [...Object.entries(REASON_WORDS), ...Object.entries(FAILURE_WORDS)]) {
    if (words === null) continue;
    assert.doesNotMatch(words, /_/, `${code} still contains an underscore`);
    assert.doesNotMatch(words, /\b[A-Z]{3,}\b/, `${code} still contains a shouted code`);
    assert.match(words, /[.!]$/, `${code} is not a sentence`);
  }
});

// --- the summary line -------------------------------------------------------

test('a finished kit that lost steps says so rather than just "finished"', () => {
  const steps = deriveSteps([
    { step: 'requirements', status: 'done', at: at(1) },
    { step: 'flashcards', status: 'skipped', detail: { reason: 'TIME_GOVERNOR' }, at: at(2) },
    { step: 'questions', status: 'failed', detail: { code: 'LLM_UNAVAILABLE' }, at: at(3) },
  ]);

  const line = summarise(steps, 'ready');
  assert.match(line, /finished/);
  assert.match(line, /1 step failed/);
  assert.match(line, /1 skipped/);
});

test('a clean finish says only that', () => {
  const steps = deriveSteps([{ step: 'requirements', status: 'done', at: at(1) }]);
  assert.equal(summarise(steps, 'ready'), 'Kit finished.');
});

test('while running, the summary names the step actually running', () => {
  const steps = deriveSteps([
    { step: 'requirements', status: 'done', at: at(1) },
    { step: 'crawl', status: 'started', at: at(2) },
  ]);
  assert.equal(summarise(steps, 'running'), 'Crawling the company site…');
});

test('queued and failed kits each get their own line', () => {
  assert.match(summarise(deriveSteps([]), 'queued'), /Queued/);
  assert.match(summarise(deriveSteps([]), 'failed'), /could not be built/);
});
