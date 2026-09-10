/**
 * findHiringPage.js — which crawled page, if any, describes how this company hires?
 *
 * Decides: the single best candidate, confirmed by one short model call, or null.
 *
 * Does NOT decide: what the hiring process IS (a generation step reads the page), or
 * whether the crawl was good enough. It chooses between pages that already exist.
 *
 * NULL IS A CORRECT ANSWER, NOT A FAILURE. Plenty of companies have no public hiring
 * page — the `nohire` fixture is exactly that case, and the contract says a missing
 * hiring page is still `status: "ok"` with the gap recorded. So this returns
 * `{ page: null, reason: 'NO_HIRING_PAGE_FOUND' }` and the run continues. The
 * temptation to return the least-bad page instead is worth naming: a kit that presents
 * the pricing page as "their interview process" is worse than a kit that says it could
 * not find one, because a candidate would prepare from it.
 *
 * ONE CALL, AND ONLY WHEN IT CAN CHANGE THE OUTCOME. The call budget is twelve per kit.
 * The model sees candidate titles and opening paragraphs — not whole pages — because
 * that is enough to answer "which of these describes a hiring process?" and it keeps
 * the request inside a TPM window. With no candidates, or only one that the crawler
 * already scored overwhelmingly, the call is skipped and the budget is left for work
 * that needs it.
 *
 * The crawler's score decides WHICH pages are worth asking about; the model decides
 * whether any of them is genuinely a hiring page. Neither alone is reliable: the score
 * cannot read prose, and the model cannot see the site.
 */

import { completeStructured } from '../llm/json.js';
import { safePromptMany } from '../llm/safePrompt.js';
import { object, str, int } from '../llm/schema.js';

export const HIRING_PAGE_REASONS = Object.freeze({
  FOUND: 'HIRING_PAGE_FOUND',
  NONE_FOUND: 'NO_HIRING_PAGE_FOUND',
  NO_CANDIDATES: 'NO_HIRING_PAGE_CANDIDATES',
  CONFIRMATION_SKIPPED: 'HIRING_PAGE_ACCEPTED_WITHOUT_CONFIRMATION',
  CONFIRMATION_FAILED: 'HIRING_PAGE_CONFIRMATION_UNAVAILABLE',
});

/** How many candidates the model is asked about. More costs tokens, not accuracy. */
const MAX_CANDIDATES = 5;

/** Characters of each candidate's opening text sent for confirmation. */
const EXCERPT_CHARS = 700;

/**
 * A score so high the page is self-evidently the hiring page — a URL and title both
 * saying "how we hire" needs no second opinion, and spending a call on it is spending
 * a call the gap-fill pass may need.
 */
const OBVIOUS_SCORE = 15;

/**
 * Flat schema — the dialect is an OpenAPI subset and does not take unions cleanly.
 * Types come from the shared builders because the dialect's `type` is an ENUM in upper
 * case; a lowercase 'object' reads fine, passes every local test and is rejected by the
 * API on the first real call.
 */
export const HIRING_PAGE_SCHEMA = Object.freeze(
  object({
    chosen_url: str(
      'The URL of the page that describes the hiring or interview process. Empty string if none of them do.'
    ),
    confidence: int(
      'Confidence from 1 (guess) to 5 (certain) that the chosen page describes a hiring process.'
    ),
    reason: str('One sentence on why this page was chosen, or why none qualified.'),
  })
);

const SYSTEM_INSTRUCTION = [
  'You identify which page of a company website describes how the company HIRES people:',
  'its interview process, stages, what candidates are assessed on, or how to apply.',
  '',
  'Rules:',
  '- Choose at most one page, and only if it genuinely describes hiring or interviewing.',
  '- A page listing open roles counts. A generic "about us", product, pricing or legal',
  '  page does NOT, however much it talks about culture.',
  '- If none of the pages qualifies, return an empty chosen_url. That is a correct and',
  '  expected answer — many companies publish no such page. Do not choose the least bad',
  '  option to avoid returning nothing.',
  '- chosen_url must be copied exactly from one of the candidate URLs given.',
].join('\n');

/**
 * Choose the hiring page.
 *
 * @param {object} options
 * @param {Array<{url: string, title?: string, score?: number}>} options.candidates from crawlSite
 * @param {Array<{url: string, title?: string, text?: string}>} options.pages the crawled pages
 * @param {{ complete: Function }} [options.provider] omit to skip confirmation entirely
 * @param {() => void} [options.spend] budget hook, called per model call
 * @param {number} [options.minConfidence]
 * @returns {Promise<{ page: object|null, reason: string, confidence: number|null, considered: object[], usedModel: boolean }>}
 */
export async function findHiringPage({
  candidates = [],
  pages = [],
  provider = null,
  spend,
  minConfidence = 3,
} = {}) {
  const shortlist = [...candidates]
    .filter((candidate) => candidate && typeof candidate.url === 'string')
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, MAX_CANDIDATES);

  const considered = shortlist.map((candidate) => ({
    url: candidate.url,
    title: candidate.title ?? '',
    score: candidate.score ?? 0,
  }));

  if (shortlist.length === 0) {
    return { page: null, reason: HIRING_PAGE_REASONS.NO_CANDIDATES, confidence: null, considered, usedModel: false };
  }

  const pageByUrl = new Map(pages.map((page) => [page.url, page]));
  const best = shortlist[0];

  // Self-evident winner: skip the call and keep the budget.
  if ((best.score ?? 0) >= OBVIOUS_SCORE && looksLikeHiring(best, pageByUrl.get(best.url))) {
    return {
      page: pageByUrl.get(best.url) ?? { url: best.url, title: best.title ?? '' },
      reason: HIRING_PAGE_REASONS.CONFIRMATION_SKIPPED,
      confidence: 5,
      considered,
      usedModel: false,
    };
  }

  if (!provider) {
    return {
      page: null,
      reason: HIRING_PAGE_REASONS.CONFIRMATION_FAILED,
      confidence: null,
      considered,
      usedModel: false,
    };
  }

  const documents = shortlist.map((candidate) => {
    const page = pageByUrl.get(candidate.url);
    return {
      kind: 'page',
      label: candidate.url,
      source: candidate.url,
      text: [`URL: ${candidate.url}`, `TITLE: ${page?.title ?? candidate.title ?? ''}`, '', (page?.text ?? '').slice(0, EXCERPT_CHARS)].join('\n'),
    };
  });

  const wrapped = safePromptMany(documents, { totalLimit: MAX_CANDIDATES * (EXCERPT_CHARS + 300) });

  let answer;
  try {
    answer = await completeStructured({
      provider,
      request: {
        systemInstruction: SYSTEM_INSTRUCTION,
        contents: wrapped.text,
        responseSchema: HIRING_PAGE_SCHEMA,
      },
      step: 'hiring-page',
      spend,
    });
  } catch (cause) {
    // A failed confirmation must not fail the case. We simply do not claim a hiring
    // page — the same outcome as not finding one, with a different reason recorded.
    return {
      page: null,
      reason: HIRING_PAGE_REASONS.CONFIRMATION_FAILED,
      confidence: null,
      considered,
      usedModel: true,
      error: { code: cause.code ?? 'UNKNOWN', message: cause.message },
    };
  }

  const chosenUrl = typeof answer?.chosen_url === 'string' ? answer.chosen_url.trim() : '';
  const confidence = Number.isInteger(answer?.confidence) ? answer.confidence : 0;

  if (chosenUrl === '' || confidence < minConfidence) {
    return {
      page: null,
      reason: HIRING_PAGE_REASONS.NONE_FOUND,
      confidence: chosenUrl === '' ? null : confidence,
      considered,
      usedModel: true,
      modelReason: answer?.reason ?? null,
    };
  }

  // The model must pick from the list it was given. A URL it invented — or one from
  // inside a crawled page's text, which is how an injected page would try to redirect
  // us — is refused rather than trusted.
  const match = shortlist.find((candidate) => candidate.url === chosenUrl);
  if (!match) {
    return {
      page: null,
      reason: HIRING_PAGE_REASONS.NONE_FOUND,
      confidence: null,
      considered,
      usedModel: true,
      modelReason: `Model returned a URL that was not a candidate: ${chosenUrl}`,
    };
  }

  return {
    page: pageByUrl.get(match.url) ?? { url: match.url, title: match.title ?? '' },
    reason: HIRING_PAGE_REASONS.FOUND,
    confidence,
    considered,
    usedModel: true,
    modelReason: answer?.reason ?? null,
  };
}

/** A cheap corroboration for the skip-the-call path: the words must actually be there. */
function looksLikeHiring(candidate, page) {
  const haystack = `${candidate.url} ${candidate.title ?? ''} ${page?.title ?? ''}`.toLowerCase();
  return /hir|interview|career|job|recruit|join.us|apply/.test(haystack);
}
