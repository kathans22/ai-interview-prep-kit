/**
 * generation.test.js — the generation steps, and the sequencing proof.
 *
 * Decides: that the stage's exit check holds — the same requirements produce a
 * DIFFERENT category distribution when the company runs a take-home and a
 * system-design round than when no process is known. That is the return on crawling
 * for a hiring page, and without this test it is an assertion in a README.
 *
 * Does NOT decide: anything requiring Gemini. Every call here is served by the fake
 * provider; the daily quota is untouched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractRequirements, dedupeRequirements, REQUIREMENTS_SCHEMA, THIN_JD_CHARS } from '../generation/extractRequirements.js';
import { extractRoleProfile, ROLE_PROFILE_SCHEMA } from '../generation/extractRoleProfile.js';
import { summariseCompany, COMPANY_BRIEF_SCHEMA } from '../generation/summariseCompany.js';
import { extractHiringProcess, HIRING_PROCESS_SCHEMA, STAGE_KINDS } from '../generation/extractHiringProcess.js';
import { routeCategories, routeAll } from '../generation/routeCategories.js';
import {
  generateQuestionsFor,
  generateQuestionsForCategory,
  QUESTIONS_SCHEMA,
  MAX_REQUIREMENTS_PER_CALL,
  __internals,
} from '../generation/generateQuestions.js';
import { generateFlashcards, flashcardCandidates } from '../generation/generateFlashcards.js';
import { fillGaps } from '../generation/fillGaps.js';
import { GENERATION_ERROR_CODES } from '../generation/errors.js';
import { createFakeProvider } from '../llm/fakeProvider.js';
import { checkSchema } from '../llm/schema.js';
import { createBudget } from '../llm/budget.js';
import { findGaps } from '../deterministic/coverage.js';
import { QUESTION_CATEGORIES } from '../contracts/kitSchema.js';

/** The requirement set both sides of the sequencing proof share. */
const REQUIREMENTS = [
  { id: 'r1', text: '5+ years with React and TypeScript', kind: 'technical', priority: 'must', evidence: 'react' },
  { id: 'r2', text: 'Comfortable mentoring junior engineers through code review', kind: 'behavioural', priority: 'must', evidence: 'mentoring' },
  { id: 'r3', text: 'Familiarity with warehouse logistics', kind: 'domain', priority: 'nice', evidence: 'logistics' },
  { id: 'r4', text: 'Own the operator console handling 400 concurrent vehicle updates', kind: 'technical', priority: 'must', evidence: 'console' },
  { id: 'r5', text: 'Write clear technical documentation', kind: 'behavioural', priority: 'nice', evidence: 'documentation' },
];

const TAKE_HOME_AND_DESIGN = {
  source_url: 'http://x.test/how-we-hire',
  kinds: ['screen', 'take-home', 'technical-interview', 'system-design'],
  stages: [
    { name: 'Intro call', kind: 'screen', order: 1, focus: '' },
    { name: 'Take-home', kind: 'take-home', order: 2, focus: 'A small problem close to our work' },
    { name: 'Technical conversation', kind: 'technical-interview', order: 3, focus: '' },
    { name: 'System design', kind: 'system-design', order: 4, focus: 'Our domain, under load' },
  ],
  assessed: ['depth in React', 'judgement about degradation'],
  notes: '',
};

const CONVERSATIONS_AND_VALUES = {
  source_url: 'http://y.test/hiring',
  kinds: ['screen', 'behavioural', 'values'],
  stages: [
    { name: 'Intro call', kind: 'screen', order: 1, focus: '' },
    { name: 'Experience interview', kind: 'behavioural', order: 2, focus: '' },
    { name: 'Values conversation', kind: 'values', order: 3, focus: '' },
  ],
  assessed: [],
  notes: '',
};

/** A provider that answers every category by echoing back the ids it was given. */
function questionProvider() {
  const answer = (label) => (request) => ({
    questions: [...String(request.contents).matchAll(/id: (r\d+)/g)].map((match, index) => ({
      requirement_id: match[1],
      prompt: `${label} question for ${match[1]}`,
      answer_outline: 'what a strong answer contains',
      difficulty: (index % 3) + 1,
    })),
  });

  return createFakeProvider({
    fallback: { questions: [] },
    responses: {
      'questions:technical': answer('technical'),
      'questions:behavioural': answer('behavioural'),
      'questions:system-design': answer('system-design'),
      'questions:company-fit': answer('company-fit'),
    },
  });
}

// ===========================================================================
// EXIT CHECK — the sequencing proof
// ===========================================================================

test('EXIT CHECK: a take-home and system-design process changes the category mix', () => {
  const withoutProcess = routeAll(REQUIREMENTS, null, { seniority: '' });
  const withProcess = routeAll(REQUIREMENTS, TAKE_HOME_AND_DESIGN, { seniority: '' });

  assert.notDeepEqual(
    withProcess.distribution,
    withoutProcess.distribution,
    'finding the hiring page must change what gets generated, or the crawl was theatre'
  );

  // Specifically: the system-design round pulls technical and domain requirements into
  // system-design questions they would not otherwise get.
  assert.ok(
    withProcess.distribution['system-design'] > withoutProcess.distribution['system-design'],
    `system-design ${withoutProcess.distribution['system-design']} -> ${withProcess.distribution['system-design']}`
  );

  // And the requirement that only gained it because of the process says so.
  const { reasons } = routeCategories(REQUIREMENTS[0], TAKE_HOME_AND_DESIGN, {});
  assert.ok(
    reasons['system-design'].some((reason) => reason.includes('system-design round')),
    'the routing decision must be attributable to the process'
  );
});

test('EXIT CHECK: a different process produces a different mix again', () => {
  const design = routeAll(REQUIREMENTS, TAKE_HOME_AND_DESIGN, {}).distribution;
  const values = routeAll(REQUIREMENTS, CONVERSATIONS_AND_VALUES, {}).distribution;
  const none = routeAll(REQUIREMENTS, null, {}).distribution;

  assert.notDeepEqual(design, values, 'two different processes must not converge on one kit');
  assert.ok(values['company-fit'] > none['company-fit'], 'a values round earns company-fit questions');
  assert.ok(values['behavioural'] > none['behavioural'], 'and behavioural ones');
  assert.equal(values['system-design'], none['system-design'], 'with no design round, no design lift');
});

test('EXIT CHECK: the difference survives all the way into generated questions', async () => {
  const generate = async (process) => {
    const routed = routeAll(REQUIREMENTS, process, {});
    const provider = questionProvider();
    const questions = [];

    for (const category of QUESTION_CATEGORIES) {
      const result = await generateQuestionsForCategory(
        { category, requirements: routed.byCategory[category], hiringProcess: process, existingIds: questions.map((q) => q.id) },
        { provider }
      );
      questions.push(...result.questions);
    }

    const byCategory = Object.fromEntries(
      QUESTION_CATEGORIES.map((category) => [category, questions.filter((q) => q.category === category).length])
    );
    return { questions, byCategory, calls: provider.callCount() };
  };

  const withProcess = await generate(TAKE_HOME_AND_DESIGN);
  const withoutProcess = await generate(null);

  assert.notDeepEqual(withProcess.byCategory, withoutProcess.byCategory);
  assert.ok(
    withProcess.byCategory['system-design'] > withoutProcess.byCategory['system-design'],
    `generated design questions ${withoutProcess.byCategory['system-design']} -> ${withProcess.byCategory['system-design']}`
  );

  // Four categories, four calls: the budget line Block C draws.
  assert.ok(withProcess.calls <= QUESTION_CATEGORIES.length, `used ${withProcess.calls} calls`);
});

// ===========================================================================
// The canonical unit, and the wrapper derived from it
// ===========================================================================

test('generateQuestionsFor is a real, callable unit: one requirement, one category, one call', async () => {
  const provider = questionProvider();
  const result = await generateQuestionsFor(
    { requirement: REQUIREMENTS[0], category: 'technical', roleContext: { seniority: 'senior' } },
    { provider }
  );

  assert.equal(provider.callCount(), 1);
  assert.ok(result.questions.length >= 1);
  assert.deepEqual(result.questions[0].requirement_ids, ['r1']);
  assert.equal(result.questions[0].category, 'technical');
  assert.ok(Number.isInteger(result.questions[0].difficulty));
});

test('the batching wrapper is the same code path, not a parallel implementation', async () => {
  const provider = questionProvider();

  await generateQuestionsFor({ requirement: REQUIREMENTS[0], category: 'technical' }, { provider });
  const single = provider.calls.at(-1);

  await generateQuestionsForCategory(
    { category: 'technical', requirements: [REQUIREMENTS[0], REQUIREMENTS[3]] },
    { provider }
  );
  const batched = provider.calls.at(-1);

  assert.equal(
    single.systemInstruction,
    batched.systemInstruction,
    'the batched call must use the identical category instructions'
  );
  assert.ok(batched.contents.includes('r1') && batched.contents.includes('r4'));
});

test('each category carries genuinely different instructions', () => {
  const instructions = QUESTION_CATEGORIES.map((category) => __internals.buildInstruction(category));
  assert.equal(new Set(instructions).size, QUESTION_CATEGORIES.length, 'no two categories share a prompt');

  const [technical, behavioural, design, fit] = instructions;
  assert.match(technical, /mechanism/i);
  assert.match(behavioural, /specific past situation/i);
  assert.match(behavioural, /avoids hypotheticals/i);
  assert.match(design, /constraint/i);
  assert.match(fit, /reservation/i);
});

test('batching stops at five requirements and defers the rest', async () => {
  const many = Array.from({ length: 8 }, (_, index) => ({
    id: `r${index + 1}`,
    text: `Requirement ${index + 1}`,
    kind: 'technical',
    priority: 'must',
  }));
  const provider = questionProvider();

  const result = await generateQuestionsForCategory({ category: 'technical', requirements: many }, { provider });

  assert.equal(result.batched, MAX_REQUIREMENTS_PER_CALL);
  assert.equal(result.deferred.length, 3);
  assert.equal(provider.callCount(), 1, 'deferring is the orchestrator\'s call to make, not an extra request');
});

test('a category with no requirements costs no call', async () => {
  const provider = questionProvider();
  const result = await generateQuestionsForCategory({ category: 'company-fit', requirements: [] }, { provider });

  assert.deepEqual(result.questions, []);
  assert.equal(provider.callCount(), 0);
});

test('a question citing an unknown requirement is rejected at the step that made it', async () => {
  const provider = createFakeProvider({
    responses: { 'questions:technical': { questions: [{ requirement_id: 'r99', prompt: 'p', answer_outline: 'o', difficulty: 2 }] } },
  });

  await assert.rejects(
    generateQuestionsFor({ requirement: REQUIREMENTS[0], category: 'technical' }, { provider }),
    (error) => {
      assert.equal(error.code, GENERATION_ERROR_CODES.INVALID_OUTPUT);
      assert.equal(error.details.rejected[0].reason, 'UNKNOWN_REQUIREMENT_ID');
      return true;
    }
  );
});

// ===========================================================================
// Requirement extraction and the evidence guard
// ===========================================================================

const JD = [
  'Senior Frontend Engineer — Acme Logistics (Remote, UK)',
  '',
  'Requirements:',
  '• 5+ years’ experience with React and TypeScript',
  '• Comfortable mentoring junior engineers through code review',
  '',
  'Bonus points for warehouse logistics exposure.',
  'We are remote-first and write more than we talk, so clear writing matters.',
].join('\n');

test('requirements come back with ids, kinds, priorities and evidence', async () => {
  const provider = createFakeProvider({
    responses: {
      'extract-requirements': {
        requirements: [
          { text: 'React and TypeScript depth', kind: 'technical', priority: 'must', evidence: '5+ years’ experience with React and TypeScript' },
          { text: 'Mentoring juniors', kind: 'behavioural', priority: 'must', evidence: 'mentoring junior engineers' },
          { text: 'Logistics exposure', kind: 'domain', priority: 'nice', evidence: 'warehouse logistics' },
        ],
      },
    },
  });

  const result = await extractRequirements(JD, { provider });

  assert.deepEqual(result.requirements.map((r) => r.id), ['r1', 'r2', 'r3']);
  assert.deepEqual(result.requirements.map((r) => r.priority), ['must', 'must', 'nice']);
  assert.equal(result.dropped.length, 0);
});

test('a fabricated requirement is dropped and reported, and the ids do not renumber', async () => {
  const provider = createFakeProvider({
    responses: {
      'extract-requirements': {
        requirements: [
          { text: 'React depth', kind: 'technical', priority: 'must', evidence: '5+ years’ experience with React and TypeScript' },
          { text: 'AWS certification', kind: 'technical', priority: 'must', evidence: 'Must hold an active AWS Solutions Architect certification' },
          { text: 'Mentoring', kind: 'behavioural', priority: 'must', evidence: 'mentoring junior engineers' },
        ],
      },
    },
  });

  const drops = [];
  const result = await extractRequirements(JD, { provider, onDrop: (drop) => drops.push(drop) });

  assert.deepEqual(result.requirements.map((r) => r.id), ['r1', 'r3'], 'survivors keep their original ids');
  assert.deepEqual(result.dropped.map((d) => d.id), ['r2']);
  assert.equal(drops.length, 1, 'onDrop fires so no drop is silent');
  assert.ok(result.dropRate > 0);
  assert.match(result.note, /must-priority/);
});

test('a thin posting is reported as thin rather than padded', async () => {
  const provider = createFakeProvider({
    responses: { 'extract-requirements': { requirements: [{ text: 'Node', kind: 'technical', priority: 'must', evidence: 'Node' }] } },
  });

  const result = await extractRequirements('Backend engineer. Node.', { provider });
  assert.equal(result.thin, true);
  assert.match(result.note, new RegExp(`${THIN_JD_CHARS}`));
});

test('near-duplicate requirements collapse, keeping the stronger priority', () => {
  const { requirements, merged } = dedupeRequirements([
    { text: 'Strong React skills', kind: 'technical', priority: 'nice', evidence: 'react' },
    { text: 'Strong React skill', kind: 'technical', priority: 'must', evidence: 'react' },
    { text: 'Kafka experience', kind: 'technical', priority: 'nice', evidence: 'kafka' },
  ]);

  assert.equal(requirements.length, 2);
  assert.equal(requirements[0].priority, 'must', 'a must must never be lost to a merge');
  assert.equal(merged.length, 1);
});

test('an Americanised enum from the model is caught at this step', async () => {
  const provider = createFakeProvider({
    responses: { 'extract-requirements': { requirements: [{ text: 'x', kind: 'behavioral', priority: 'must', evidence: 'x' }] } },
  });

  await assert.rejects(extractRequirements(JD, { provider }), (error) => {
    assert.equal(error.code, GENERATION_ERROR_CODES.INVALID_OUTPUT);
    assert.match(error.message, /behavioural/);
    return true;
  });
});

// ===========================================================================
// Role profile, company brief, hiring process
// ===========================================================================

test('an unstated field comes back empty, never guessed', async () => {
  const provider = createFakeProvider({
    responses: { 'extract-role-profile': { title: 'Frontend Engineer', seniority: '', company: '', location: '', responsibilities: [] } },
  });

  const profile = await extractRoleProfile('Frontend Engineer. React.', { provider });
  assert.equal(profile.seniority, '');
  assert.equal(profile.location, '');
  assert.deepEqual(profile.missing, ['seniority', 'company', 'location', 'responsibilities']);
});

test('no retrieved pages means no company brief call at all', async () => {
  const provider = createFakeProvider({ responses: { 'company-brief': { summary: 'invented', what_they_do: 'invented', grounded: 'yes' } } });

  const result = await summariseCompany({ crawledPages: [] }, { provider });

  assert.equal(provider.callCount(), 0, 'a call that cannot be grounded can only invent');
  assert.equal(result.grounded, false);
  assert.equal(result.reason, 'NO_PAGES_RETRIEVED');
  assert.match(result.brief.summary, /could not be read/);
});

test('company brief sources contain only URLs that were actually fetched', async () => {
  const provider = createFakeProvider({
    responses: { 'company-brief': { summary: 'Acme routes freight for third-party logistics providers.', what_they_do: 'Dispatch software.', grounded: 'yes' } },
  });

  const result = await summariseCompany(
    {
      crawledPages: [
        { url: 'http://x.test/', text: 'a'.repeat(400) },
        { url: 'http://invented.test/', text: 'b'.repeat(400) },
      ],
    },
    { provider, vouch: (urls) => ({ kept: urls.filter((url) => url.includes('x.test')), dropped: [] }) }
  );

  assert.deepEqual(result.brief.sources, ['http://x.test/']);
});

test('a page that turns out not to describe a process yields null', async () => {
  const provider = createFakeProvider({
    responses: { 'hiring-process': { has_process: 'no', stages: [], assessed: [], notes: '' } },
  });

  const result = await extractHiringProcess(
    { hiringPage: { url: 'http://x.test/about', text: 'We were founded in 2019.' } },
    { provider }
  );

  assert.equal(result.process, null);
  assert.equal(result.reason, 'PAGE_DESCRIBES_NO_PROCESS');
});

test('stages are ordered and renumbered 1..N whatever the page said', async () => {
  const provider = createFakeProvider({
    responses: {
      'hiring-process': {
        has_process: 'yes',
        stages: [
          { name: 'Design', kind: 'system-design', order: 9, focus: '' },
          { name: 'Call', kind: 'screen', order: 2, focus: '' },
        ],
        assessed: [],
        notes: '',
      },
    },
  });

  const { process } = await extractHiringProcess(
    { hiringPage: { url: 'http://x.test/hire', text: 'stages' } },
    { provider }
  );

  assert.deepEqual(process.stages.map((stage) => [stage.order, stage.kind]), [[1, 'screen'], [2, 'system-design']]);
  assert.deepEqual(process.kinds, ['screen', 'system-design']);
});

// ===========================================================================
// Routing, flashcards, gap fill, budget
// ===========================================================================

test('routing is deterministic and every requirement gets a category', () => {
  for (const requirement of REQUIREMENTS) {
    const first = routeCategories(requirement, TAKE_HOME_AND_DESIGN, { seniority: 'senior' });
    const second = routeCategories(requirement, TAKE_HOME_AND_DESIGN, { seniority: 'senior' });
    assert.deepEqual(first.categories, second.categories);
    assert.ok(first.categories.length > 0, `${requirement.id} routed nowhere`);
    for (const category of first.categories) assert.ok(QUESTION_CATEGORIES.includes(category));
  }
});

test('mentoring routes to behavioural; scale and ownership route to system-design', () => {
  assert.ok(routeCategories(REQUIREMENTS[1]).categories.includes('behavioural'));
  assert.ok(routeCategories(REQUIREMENTS[3]).categories.includes('system-design'));
});

test('behavioural requirements never become flashcards', () => {
  const candidates = flashcardCandidates(REQUIREMENTS);
  assert.equal(candidates.some((requirement) => requirement.kind === 'behavioural'), false);
  assert.deepEqual(candidates.map((r) => r.id), ['r1', 'r3', 'r4']);
});

test('flashcards are optional: nothing drillable costs no call', async () => {
  const provider = createFakeProvider({ responses: { flashcards: { flashcards: [] } } });
  const result = await generateFlashcards({ requirements: [REQUIREMENTS[1]] }, { provider });

  assert.deepEqual(result.flashcards, []);
  assert.equal(provider.callCount(), 0);
  assert.match(result.skipped, /No requirements support a flashcard/);
});

test('gap fill closes the coverage the deterministic checker reported', async () => {
  const existing = [{ id: 'q1', requirement_ids: ['r1'], category: 'technical' }];
  const gaps = findGaps(REQUIREMENTS, existing);
  const uncovered = REQUIREMENTS.filter((r) => gaps.uncovered_requirement_ids.includes(r.id));

  const provider = questionProvider();
  const result = await fillGaps(uncovered, { existingIds: ['q1'], maxCalls: 4 }, { provider });

  const after = findGaps(REQUIREMENTS, [...existing, ...result.questions]);
  assert.deepEqual(after.uncovered_requirement_ids, [], 'every reported gap should be closed');
  assert.deepEqual(result.stillUncovered, []);
});

test('gap fill respects its call ceiling and says what it left', async () => {
  const uncovered = REQUIREMENTS.slice(1);
  const provider = questionProvider();

  const result = await fillGaps(uncovered, { maxCalls: 1 }, { provider });

  assert.equal(result.callsUsed, 1);
  assert.ok(result.stillUncovered.length > 0);
  assert.match(result.notes.join(' '), /Stopped after 1 call/);
});

test('a failed gap-fill call leaves the gap rather than failing the case', async () => {
  const provider = createFakeProvider({ failures: { '*': { blocked: true } } });
  const result = await fillGaps([REQUIREMENTS[1]], { maxCalls: 1 }, { provider });

  assert.deepEqual(result.questions, []);
  assert.match(result.notes.join(' '), /gap-fill call failed/);
});

test('the whole normal path fits inside the twelve-call budget', async () => {
  const budget = createBudget(12);
  const spend = (label) => () => budget.spend(label);
  const provider = questionProvider();

  // The steps Block C itemises, with the four category calls batched.
  await extractRequirements(JD, {
    provider: createFakeProvider({ responses: { 'extract-requirements': { requirements: [{ text: 'React', kind: 'technical', priority: 'must', evidence: '5+ years’ experience with React and TypeScript' }] } } }),
    spend: spend('requirements'),
  });
  await extractRoleProfile(JD, {
    provider: createFakeProvider({ responses: { 'extract-role-profile': { title: 'x', seniority: '', company: '', location: '', responsibilities: [] } } }),
    spend: spend('role-profile'),
  });
  await extractHiringProcess(
    { hiringPage: { url: 'http://x.test/h', text: 'stages' } },
    { provider: createFakeProvider({ responses: { 'hiring-process': { has_process: 'yes', stages: [{ name: 'Call', kind: 'screen', order: 1, focus: '' }], assessed: [], notes: '' } } }), spend: spend('hiring-process') }
  );
  await summariseCompany(
    { crawledPages: [{ url: 'http://x.test/', text: 'c'.repeat(400) }] },
    { provider: createFakeProvider({ responses: { 'company-brief': { summary: 's', what_they_do: 'w', grounded: 'yes' } } }), spend: spend('company-brief') }
  );

  const routed = routeAll(REQUIREMENTS, TAKE_HOME_AND_DESIGN, {});
  for (const category of QUESTION_CATEGORIES) {
    await generateQuestionsForCategory(
      { category, requirements: routed.byCategory[category], hiringProcess: TAKE_HOME_AND_DESIGN },
      { provider, spend: spend(`questions:${category}`) }
    );
  }

  await generateFlashcards(
    { requirements: REQUIREMENTS },
    { provider: createFakeProvider({ responses: { flashcards: { flashcards: [] } } }), spend: spend('flashcards') }
  );

  const report = budget.report();
  assert.ok(report.spent <= 12, `spent ${report.spent}: ${JSON.stringify(report.breakdown)}`);
  assert.ok(report.remaining >= 1, 'a pass must be left for gap fill');
});

// ===========================================================================
// Schemas
// ===========================================================================

test('every response schema is valid for the dialect', () => {
  for (const [name, schema] of [
    ['requirements', REQUIREMENTS_SCHEMA],
    ['role profile', ROLE_PROFILE_SCHEMA],
    ['company brief', COMPANY_BRIEF_SCHEMA],
    ['hiring process', HIRING_PROCESS_SCHEMA],
    ['questions', QUESTIONS_SCHEMA],
  ]) {
    assert.deepEqual(checkSchema(schema), [], `${name} schema is malformed`);
  }
});

test('the stage kinds the router switches on are the ones the schema allows', () => {
  const schemaKinds = HIRING_PROCESS_SCHEMA.properties.stages.items.properties.kind.enum;
  assert.deepEqual(schemaKinds, [...STAGE_KINDS], 'a kind the schema allows but the router ignores routes nowhere');
});
