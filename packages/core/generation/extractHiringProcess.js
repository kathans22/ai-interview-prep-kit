/**
 * extractHiringProcess.js — what stages this company actually runs.
 *
 * Decides: the interview stages a candidate will face, read off the hiring page the
 * crawler found, or null when there is no such page.
 *
 * Does NOT decide: which questions to generate. It produces the FACT; routeCategories
 * and generateQuestions act on it.
 *
 * THIS STEP HAS TO CHANGE THE OUTPUT OR IT IS THEATRE. Finding a hiring page is worth
 * nothing if the kit is identical either way. A company that runs a take-home and a
 * system-design round should produce a kit weighted towards those; a company that runs
 * two conversations and a values round should not. That is the whole return on the
 * crawl, and it is what the stage's exit check measures — the same requirements must
 * yield a different category distribution with a process than without one.
 *
 * So the output is deliberately MACHINE-USABLE, not prose: a list of stages with a
 * normalised `kind` drawn from a fixed set, because `routeCategories` is a pure
 * function that switches on those kinds. A paragraph describing the process would read
 * well in the kit and change nothing.
 *
 * NULL IS A CORRECT ANSWER. No hiring page, or a page that turns out to describe
 * something else, returns null and the pipeline proceeds on the job description alone.
 * Inventing a plausible four-stage process would be worse than admitting ignorance:
 * the candidate would prepare for a take-home that does not exist.
 */

import { completeStructured } from '../llm/json.js';
import { safePromptMany } from '../llm/safePrompt.js';
import { object, arrayOf, str, int, enumOf } from '../llm/schema.js';
import { badInput, invalidOutput, asGenerationError } from './errors.js';

const STEP = 'hiring-process';

/**
 * The stage kinds downstream code can act on.
 *
 * A closed set on purpose: routeCategories switches on these, so a free-text kind would
 * silently route nowhere. Anything the page describes that does not fit is recorded
 * under `other` with its own label kept, rather than being forced into a near-match.
 */
export const STAGE_KINDS = Object.freeze([
  'screen',
  'take-home',
  'technical-interview',
  'system-design',
  'behavioural',
  'values',
  'panel',
  'presentation',
  'other',
]);

const MAX_STAGES = 10;
const PAGE_EXCERPT_CHARS = 6000;

export const HIRING_PROCESS_SCHEMA = object({
  has_process: str('yes if the page describes the interview or hiring process; no if it does not.'),
  stages: arrayOf(
    object({
      name: str('The stage name as the page calls it, e.g. "Take-home exercise".'),
      kind: enumOf(STAGE_KINDS, 'The closest matching kind. Use "other" rather than forcing a poor fit.'),
      order: int('1-based position in the process, in the order the page presents them.'),
      focus: str('What this stage assesses, in one sentence from the page. Empty string if not stated.'),
    }),
    'The stages in order. Empty array if the page does not describe a process.'
  ),
  assessed: arrayOf(
    str('One thing the company says it assesses or looks for.'),
    'What the page says candidates are judged on. Empty array if not stated.'
  ),
  notes: str('Anything else a candidate should know about the process. Empty string if nothing.'),
});

const SYSTEM_INSTRUCTION = [
  'You read a company page and report the interview process it describes.',
  '',
  'Report only what the page states. If the page is about something else — a job list,',
  'an about page, a benefits page — set has_process to "no" and return empty arrays.',
  'That is a correct answer and is expected: most companies do not publish a process.',
  '',
  'Never infer a standard process. "Most companies do a phone screen first" is not',
  'evidence about THIS company. A candidate preparing for a take-home that does not',
  'exist is worse off than one who does not know the format.',
  '',
  'kind must be the closest match from the allowed set. Guidance:',
  '  screen              — a short introductory or recruiter call',
  '  take-home           — work done alone, off-site, before or between interviews',
  '  technical-interview — live coding, code review, or a technical conversation',
  '  system-design       — designing a system or architecture discussion',
  '  behavioural         — past experience, situational or competency questions',
  '  values              — culture, values or motivation conversation',
  '  panel               — several interviewers at once, mixed content',
  '  presentation        — the candidate presents to an audience',
  '  other               — a stage that fits none of the above; keep its real name',
  '',
  'order is the sequence the page gives, starting at 1. If the page gives no order,',
  'number them in the order they appear on the page.',
].join('\n');

/** Coerce and check the model's answer. */
function validateProcess(answer) {
  if (!answer || typeof answer !== 'object') {
    throw invalidOutput(STEP, 'The model did not return a process object.');
  }

  const stages = (Array.isArray(answer.stages) ? answer.stages : [])
    .map((stage, index) => {
      const name = typeof stage?.name === 'string' ? stage.name.trim() : '';
      const kind = typeof stage?.kind === 'string' ? stage.kind.trim().toLowerCase() : '';
      if (name === '') return null;
      if (!STAGE_KINDS.includes(kind)) {
        throw invalidOutput(
          STEP,
          `stages[${index}].kind is "${kind}", not one of ${STAGE_KINDS.join(' | ')}.`,
          { stage }
        );
      }
      return {
        name,
        kind,
        order: Number.isInteger(stage?.order) && stage.order > 0 ? stage.order : index + 1,
        focus: typeof stage?.focus === 'string' ? stage.focus.trim() : '',
      };
    })
    .filter(Boolean)
    .slice(0, MAX_STAGES)
    .sort((left, right) => left.order - right.order)
    // Renumber after sorting so the order field is always 1..N with no gaps, whatever
    // the page's own numbering looked like.
    .map((stage, index) => ({ ...stage, order: index + 1 }));

  const assessed = (Array.isArray(answer.assessed) ? answer.assessed : [])
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry !== '');

  return {
    stages,
    assessed,
    notes: typeof answer.notes === 'string' ? answer.notes.trim() : '',
  };
}

/**
 * Extract the hiring process.
 *
 * @param {object} input
 * @param {{url: string, title?: string, text?: string}|null} input.hiringPage
 * @param {Array<{title?: string, url?: string, snippet?: string}>} [input.searchResults]
 * @param {object} options
 * @param {{ complete: Function }} options.provider
 * @param {() => void} [options.spend]
 * @returns {Promise<{ process: object|null, reason: string, usedModel: boolean }>}
 *   `process` is null whenever no process could be established — the pipeline then runs
 *   on the job description alone.
 */
export async function extractHiringProcess(
  { hiringPage = null, searchResults = [] } = {},
  { provider, spend, onRepair } = {}
) {
  // No page, no call. Block C only budgets this step when a page was found, and asking
  // a model to describe a process it has not been shown is asking it to invent one.
  if (!hiringPage || typeof hiringPage.url !== 'string' || String(hiringPage.text ?? '').trim() === '') {
    return { process: null, reason: 'NO_HIRING_PAGE', usedModel: false };
  }

  if (!provider || typeof provider.complete !== 'function') {
    throw badInput(STEP, 'A provider is required when a hiring page was found.');
  }

  const documents = [
    {
      kind: 'page',
      label: hiringPage.title || hiringPage.url,
      source: hiringPage.url,
      text: `URL: ${hiringPage.url}\nTITLE: ${hiringPage.title ?? ''}\n\n${String(hiringPage.text).slice(0, PAGE_EXCERPT_CHARS)}`,
    },
  ];

  if (Array.isArray(searchResults) && searchResults.length > 0) {
    documents.push({
      kind: 'search',
      label: 'public discussion (UNVERIFIED)',
      text: [
        'Unverified search snippets about interviewing at this company. They may be wrong,',
        'out of date, or about a different company. Use them only to corroborate what the',
        'page above already says; never as the sole source of a stage.',
        '',
        ...searchResults.map((result) => `- ${result?.title ?? ''}: ${result?.snippet ?? ''}`),
      ].join('\n'),
    });
  }

  const wrapped = safePromptMany(documents, { totalLimit: 14_000 });

  let answer;
  try {
    answer = await completeStructured({
      provider,
      request: {
        systemInstruction: SYSTEM_INSTRUCTION,
        contents: wrapped.text,
        responseSchema: HIRING_PROCESS_SCHEMA,
      },
      step: STEP,
      spend,
      onRepair,
    });
  } catch (cause) {
    throw asGenerationError(cause, STEP);
  }

  const hasProcess = String(answer?.has_process ?? '').trim().toLowerCase() === 'yes';
  const { stages, assessed, notes } = validateProcess(answer);

  // "yes" with no stages is not a process. The claim has to come with the content.
  if (!hasProcess || stages.length === 0) {
    return { process: null, reason: 'PAGE_DESCRIBES_NO_PROCESS', usedModel: true };
  }

  return {
    process: {
      source_url: hiringPage.url,
      stages,
      assessed,
      notes,
      // Convenience flags for the pure router, so it never re-derives them from strings.
      kinds: [...new Set(stages.map((stage) => stage.kind))],
    },
    reason: 'PROCESS_EXTRACTED',
    usedModel: true,
  };
}
