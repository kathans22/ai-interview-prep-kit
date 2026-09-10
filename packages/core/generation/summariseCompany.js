/**
 * summariseCompany.js — what this company does, according to pages we actually read.
 *
 * Decides: the company_brief — a short summary, a what_they_do line, and the source
 * URLs behind them.
 *
 * Does NOT decide: which pages to fetch (crawl.js), which URLs are legitimate
 * (sourceLedger), or what the role requires. It summarises what it is given and
 * nothing else.
 *
 * THE FAILURE THIS MODULE IS BUILT AROUND: a model asked to describe "Acme Logistics"
 * will describe it — fluently, plausibly, and from nothing. Company names are exactly
 * the kind of prompt that invites a confident answer assembled from the name itself.
 * The output would read better than an honest one and be worth less than nothing: a
 * candidate walking into an interview having prepared from invented facts about the
 * company is worse off than one who knows they know nothing.
 *
 * Three defences, in order of how much they are relied on:
 *   1. NO PAGES, NO BRIEF. When retrieval returned nothing usable, this step does not
 *      call the model at all. It returns a brief that says what happened. A call that
 *      cannot be grounded is a call that can only invent.
 *   2. SOURCES ARE VOUCHED, NOT QUOTED. company_brief.sources is built from the URLs
 *      passed in — which the ledger confirmed were fetched — never from URLs the model
 *      mentions. A cited URL the crawler never retrieved is dropped.
 *   3. THE PROMPT FORBIDS OUTSIDE KNOWLEDGE explicitly, and says what to write instead
 *      when the pages are thin.
 *
 * Search snippets are included as context but marked as unverified: they are the least
 * reliable material in the pipeline, and the summary should lean on fetched pages.
 */

import { completeStructured } from '../llm/json.js';
import { safePromptMany } from '../llm/safePrompt.js';
import { object, str } from '../llm/schema.js';
import { badInput, invalidOutput, asGenerationError } from './errors.js';

const STEP = 'company-brief';

/** Below this much readable text, the pages are navigation and boilerplate. */
const MIN_USABLE_CHARS = 200;

/** Per-page excerpt. The brief is two short fields; whole pages would waste the window. */
const PAGE_EXCERPT_CHARS = 2500;

export const COMPANY_BRIEF_SCHEMA = object({
  summary: str(
    'Two or three sentences on the company, drawn only from the supplied pages. Empty string if the pages do not support one.'
  ),
  what_they_do: str(
    'One sentence naming the product or service and who it is for, drawn only from the supplied pages. Empty string if unsupported.'
  ),
  grounded: str(
    'yes if every statement above comes from the supplied pages; no if you could not support them.'
  ),
});

const SYSTEM_INSTRUCTION = [
  'You summarise a company using ONLY the pages supplied to you.',
  '',
  'You have no other knowledge of this company. If you happen to recognise the name,',
  'that recognition is not evidence and must not appear in your answer. Every clause you',
  'write has to be traceable to a sentence in the supplied pages.',
  '',
  'If the pages are thin — navigation, a login screen, a page of marketing adjectives —',
  'say what little they support and stop. A two-sentence summary that is true is worth',
  'more than a paragraph that reads well. If they support nothing at all, return empty',
  'strings and grounded: "no".',
  '',
  'Do NOT write:',
  '  - founding dates, headcounts, funding, customers or locations that are not stated',
  '  - industry generalities dressed as facts about this company',
  '  - anything from a search snippet presented as though it were confirmed',
  '',
  'Write plainly. No marketing register, no "leading provider of", no adjectives the',
  'pages did not use. The reader is a candidate preparing for an interview and needs to',
  'know what the company does, not how it describes itself.',
].join('\n');

/**
 * Build the brief.
 *
 * @param {object} input
 * @param {Array<{url: string, title?: string, text?: string}>} input.crawledPages pages
 *   the ledger confirmed were fetched
 * @param {{url: string, title?: string, text?: string}|null} [input.hiringPage]
 * @param {Array<{title?: string, url?: string, snippet?: string}>} [input.searchResults]
 * @param {object} options
 * @param {{ complete: Function }} options.provider
 * @param {() => void} [options.spend]
 * @param {(urls: string[]) => {kept: string[], dropped: string[]}} [options.vouch] the
 *   ledger's guarantee that a URL was really fetched
 * @returns {Promise<{ brief: object, grounded: boolean, reason: string, usedModel: boolean }>}
 */
export async function summariseCompany(
  { crawledPages = [], hiringPage = null, searchResults = [] } = {},
  { provider, spend, onRepair, vouch } = {}
) {
  const pages = [...(Array.isArray(crawledPages) ? crawledPages : [])];
  if (hiringPage && !pages.some((page) => page.url === hiringPage.url)) pages.push(hiringPage);

  const usable = pages.filter(
    (page) => typeof page?.url === 'string' && String(page?.text ?? '').trim().length > 0
  );
  const totalChars = usable.reduce((total, page) => total + String(page.text).length, 0);

  // Sources are the URLs we FETCHED, filtered through the ledger where one is supplied.
  const candidateUrls = usable.map((page) => page.url);
  const sources = typeof vouch === 'function' ? vouch(candidateUrls).kept : candidateUrls;

  // Defence 1: nothing to ground a summary in means no call is made at all.
  if (usable.length === 0 || totalChars < MIN_USABLE_CHARS) {
    return {
      brief: {
        summary:
          usable.length === 0
            ? 'The company website could not be read, so no description of the company is included. Prepare from the job description alone.'
            : 'The pages that could be read contained too little text to describe the company. Prepare from the job description alone.',
        what_they_do: '',
        sources,
      },
      grounded: false,
      reason: usable.length === 0 ? 'NO_PAGES_RETRIEVED' : 'PAGES_TOO_THIN',
      usedModel: false,
    };
  }

  if (!provider || typeof provider.complete !== 'function') {
    throw badInput(STEP, 'A provider is required when there are pages to summarise.');
  }

  const documents = usable.map((page) => ({
    kind: 'page',
    label: page.title || page.url,
    source: page.url,
    text: `URL: ${page.url}\nTITLE: ${page.title ?? ''}\n\n${String(page.text).slice(0, PAGE_EXCERPT_CHARS)}`,
  }));

  if (Array.isArray(searchResults) && searchResults.length > 0) {
    documents.push({
      kind: 'search',
      label: 'public discussion search results (UNVERIFIED)',
      text: [
        'These are search snippets, not pages we retrieved. They are unverified and may',
        'be wrong or out of date. Do not state anything from them as fact about the company.',
        '',
        ...searchResults.map(
          (result) => `- ${result?.title ?? ''} (${result?.url ?? ''}): ${result?.snippet ?? ''}`
        ),
      ].join('\n'),
    });
  }

  const wrapped = safePromptMany(documents, { totalLimit: 24_000 });

  let answer;
  try {
    answer = await completeStructured({
      provider,
      request: {
        systemInstruction: SYSTEM_INSTRUCTION,
        contents: wrapped.text,
        responseSchema: COMPANY_BRIEF_SCHEMA,
      },
      step: STEP,
      spend,
      onRepair,
    });
  } catch (cause) {
    throw asGenerationError(cause, STEP);
  }

  if (!answer || typeof answer !== 'object') {
    throw invalidOutput(STEP, 'The model did not return a brief object.');
  }

  const summary = typeof answer.summary === 'string' ? answer.summary.trim() : '';
  const whatTheyDo = typeof answer.what_they_do === 'string' ? answer.what_they_do.trim() : '';
  const grounded = String(answer.grounded ?? '').trim().toLowerCase() === 'yes' && summary !== '';

  if (!grounded) {
    return {
      brief: {
        summary:
          summary ||
          'The pages that were retrieved did not support a description of the company. Prepare from the job description alone.',
        what_they_do: whatTheyDo,
        sources,
      },
      grounded: false,
      reason: 'MODEL_COULD_NOT_GROUND',
      usedModel: true,
    };
  }

  return {
    brief: { summary, what_they_do: whatTheyDo, sources },
    grounded: true,
    reason: 'GROUNDED_IN_RETRIEVED_PAGES',
    usedModel: true,
  };
}
