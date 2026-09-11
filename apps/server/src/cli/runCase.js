/**
 * runCase.js — one batch case, through the same orchestrator the API uses.
 *
 * Decides: what a run shares between cases and what every case gets of its own, and how
 * a thrown build becomes an envelope entry.
 *
 * Does NOT decide: how cases are scheduled against each other (unit 3), how the envelope
 * reaches disk (unit 4), or anything about what a kit contains (core). This file is a
 * wiring harness and an error translator, nothing more.
 *
 * THE SAME PIPELINE, NOT A BATCH VARIANT. `buildKit` is imported from core and called
 * with the same dependency set the HTTP job runner builds. There is no reduced step list
 * here, no different prompts, no "batch mode" flag threaded into generation. That claim
 * is the reason the monorepo exists, and it is structural: if this file tried to skip a
 * step it would have to reimplement the orchestrator to do it.
 *
 * WHAT IS SHARED ACROSS THE WHOLE RUN, AND WHY:
 *
 *   the limiter      — Block C is explicit. Two cases running at concurrency 2 must draw
 *                      from ONE set of RPM/TPM/RPD buckets, because two limiters at
 *                      "5 RPM" send ten requests a minute while both configuration files
 *                      look correct. Configured once here, from env.
 *   the page cache   — two cases naming the same company should fetch it once. Keyed by
 *                      normalised URL, so unrelated companies simply never collide.
 *   the url guard    — stateless policy; one instance avoids re-reading the same env.
 *   the fetcher      — holds the timeout and byte caps, no per-case state.
 *   the robots cache — robots.txt per host is a property of the host, not of the case.
 *   the search provider — holds one API key and one client.
 *
 * WHAT IS PER CASE, AND WHY IT MUST BE:
 *
 *   the ledger       — it records which pages THIS kit's provenance rests on. Shared, it
 *                      would vouch for case two using pages fetched for case one, and
 *                      `company_brief.sources` would cite a different company's site.
 *   the budget       — the 12-call ceiling is per kit. Shared, case one's spending would
 *                      starve case five of the calls it needs.
 *   the governor     — the spec requires a per-case deadline precisely so one slow case
 *                      cannot eat the fifteen-minute window. A shared clock would let
 *                      case one's overrun cancel work in case five.
 *
 * CRAWL CONCURRENCY IS NOT THE GEMINI LIMITER (CF-029, owner decision pending). Page
 * fetches are HTTP to someone else's web server; admitting them through a 20-requests-a-
 * DAY model quota would spend the entire quota on HTML before a single question was
 * generated. They are paced by the crawler's own semaphore, configured from the same env.
 */

import { buildKit, BuildFailedError } from '@aipk/core/orchestrator/buildKit.js';
import { createUrlGuard } from '@aipk/core/retrieval/urlGuard.js';
import { createPageFetcher } from '@aipk/core/retrieval/fetchPage.js';
import { createRobotsChecker } from '@aipk/core/retrieval/robots.js';
import { createPageCache } from '@aipk/core/retrieval/pageCache.js';
import { createSourceLedger } from '@aipk/core/retrieval/sourceLedger.js';
import { selectSearchProvider } from '@aipk/core/retrieval/searchPublicDiscussion.js';
import { createBudget } from '@aipk/core/llm/budget.js';
import { createTimeGovernor } from '@aipk/core/orchestrator/timeGovernor.js';
import { configureLimiter, isLimiterConfigured } from '@aipk/core/llm/limiter.js';
import { createGeminiProvider } from '@aipk/core/llm/provider.js';
import { LLM_ERROR_CODES } from '@aipk/core/llm/provider.js';
import { GENERATION_ERROR_CODES } from '@aipk/core/generation/errors.js';

/**
 * The stable codes an envelope entry may carry.
 *
 * Frozen and small on purpose: a grader reading `kits[].error.code` needs a closed set,
 * and a code invented at the throw site is a code nobody can act on. Every unrecognised
 * failure maps to BUILD_FAILED rather than leaking an internal name outward.
 */
export const CASE_ERROR_CODES = Object.freeze({
  EMPTY_JD: 'EMPTY_JD',
  INVALID_CASE: 'INVALID_CASE',
  NO_REQUIREMENTS: 'NO_REQUIREMENTS',
  COMPANY_UNREACHABLE: 'COMPANY_UNREACHABLE',
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
  LLM_RATE_LIMITED: 'LLM_RATE_LIMITED',
  LLM_CONTENT_BLOCKED: 'LLM_CONTENT_BLOCKED',
  BUILD_INVALID_KIT: 'BUILD_INVALID_KIT',
  BUILD_FAILED: 'BUILD_FAILED',
});

/**
 * Translate whatever was thrown into a stable `{ code, message }`.
 *
 * The cause is consulted before the wrapper: `buildKit` wraps an extraction failure as
 * BUILD_NO_REQUIREMENTS regardless of why extraction failed, so a rate limit and a
 * genuinely contentless posting arrive under the same outer code. They need different
 * codes, because one is worth retrying tomorrow and the other never will be.
 */
export function toCaseError(error) {
  const codes = CASE_ERROR_CODES;
  const causeCode = error?.details?.cause?.code ?? error?.cause?.code ?? null;

  const map = {
    BUILD_NO_JD: codes.EMPTY_JD,
    BUILD_BAD_DAYS: codes.INVALID_CASE,
    BUILD_NO_REQUIREMENTS: codes.NO_REQUIREMENTS,
    BUILD_INVALID_KIT: codes.BUILD_INVALID_KIT,
    [LLM_ERROR_CODES.RATE_LIMITED]: codes.LLM_RATE_LIMITED,
    [LLM_ERROR_CODES.UNAVAILABLE]: codes.LLM_UNAVAILABLE,
    [LLM_ERROR_CODES.REQUEST_FAILED]: codes.LLM_UNAVAILABLE,
    [LLM_ERROR_CODES.NOT_CONFIGURED]: codes.LLM_UNAVAILABLE,
    [LLM_ERROR_CODES.CONTENT_BLOCKED]: codes.LLM_CONTENT_BLOCKED,
    [GENERATION_ERROR_CODES.UNAVAILABLE]: codes.LLM_UNAVAILABLE,
    [GENERATION_ERROR_CODES.INVALID_OUTPUT]: codes.LLM_UNAVAILABLE,
    [GENERATION_ERROR_CODES.BAD_INPUT]: codes.EMPTY_JD,
  };

  const code = map[causeCode] ?? map[error?.code] ?? codes.BUILD_FAILED;
  const message = typeof error?.message === 'string' && error.message.trim() !== ''
    ? error.message.trim()
    : 'The case failed for a reason that carried no message.';

  return { code, message };
}

/**
 * Build the collaborators one run shares.
 *
 * Called ONCE per process, before any case starts. Everything returned here is either
 * stateless policy or a cache whose whole value is being shared.
 *
 * @param {object} options
 * @param {object} options.config the validated config object from `env.js`
 * @param {object} [options.provider] injected in tests; a real Gemini provider otherwise
 * @param {Function} [options.fetchImpl] injected in tests
 */
export function createRunContext({ config, provider = null, fetchImpl = undefined } = {}) {
  if (!config) throw new Error('createRunContext requires the validated config.');

  // ONE limiter for the process, from the owner's real rate-limit numbers. `getLimiter()`
  // returns a pass-through until this happens, so skipping it means pacing nothing —
  // which is exactly the fault that made BUG-019 invisible for five stages (CF-024).
  if (!isLimiterConfigured()) {
    configureLimiter({
      rpm: config.gemini.rpm,
      tpm: config.gemini.tpm,
      rpd: config.gemini.rpd,
    });
  }

  const guard = createUrlGuard({ allowPrivateHosts: config.retrieval.allowPrivateHosts });

  const fetcher = createPageFetcher({
    guard,
    ...(fetchImpl ? { fetchImpl } : {}),
    timeoutMs: config.retrieval.fetchTimeoutMs,
    maxBytes: config.retrieval.fetchMaxBytes,
  });

  return {
    config,
    provider:
      provider ??
      createGeminiProvider({
        apiKey: config.gemini.apiKey,
        model: config.gemini.model,
        maxOutputTokens: config.gemini.maxOutputTokens,
      }),
    fetcher,
    robots: createRobotsChecker({ fetcher }),
    cache: createPageCache(),
    searchProvider: selectSearchProvider(config.retrieval),
  };
}

/**
 * Run one case.
 *
 * Never throws for a case-level failure: a thrown build becomes a `failed` entry and the
 * caller continues. Anything this function let escape would end the run and lose the
 * cases that had already succeeded, which is the opposite of what the batch command is
 * for. A fault in THIS function — a programming error rather than a build failure — still
 * escapes, because silently swallowing it would make a broken harness look like five
 * broken cases.
 *
 * @param {{id: string, jd: string, company_url: string, days: number}} kase
 * @param {object} context from `createRunContext`
 * @param {{ onProgress?: Function, now?: () => number }} [hooks]
 * @returns {Promise<{id, status, kit, error, meta}>} one envelope entry, plus meta for stderr
 */
export async function runCase(kase, context, hooks = {}) {
  const { config } = context;
  const startedAt = Date.now();

  // Per case, for the reasons in the header. Built here rather than in `createRunContext`
  // so the distinction is impossible to get wrong by adding a field in the wrong place.
  const ledger = createSourceLedger();
  const budget = createBudget(config.budgets.maxLlmCallsPerKit);
  const governor = createTimeGovernor({ softDeadlineMs: config.budgets.caseSoftDeadlineMs });

  const deps = {
    provider: context.provider,
    fetcher: context.fetcher,
    robots: context.robots,
    cache: context.cache,
    searchProvider: context.searchProvider,
    ledger,
    budget,
    governor,
    crawlMaxPages: config.retrieval.crawlMaxPages,
    crawlMaxDepth: config.retrieval.crawlMaxDepth,
    // The crawler's own semaphore, deliberately not the Gemini limiter — see CF-029.
    crawlConcurrency: config.retrieval.crawlConcurrency,
    maxLlmCallsPerKit: config.budgets.maxLlmCallsPerKit,
    caseSoftDeadlineMs: config.budgets.caseSoftDeadlineMs,
  };

  try {
    const result = await buildKit(
      {
        jd: kase.jd,
        // Each case's OWN days value. Using a run-wide default here would silently
        // reschedule every case to the same length and the schedules would be wrong for
        // four of the five while passing every validator.
        days: kase.days,
        company_url: kase.company_url ?? '',
        kitId: kase.id,
      },
      deps,
      { onProgress: hooks.onProgress }
    );

    return {
      id: kase.id,
      // "ok" even when research was partial. An unreachable company site or a missing
      // hiring page is a GAP INSIDE the kit, recorded in `run_notes` and visible in
      // `pages_used`, not a failed case — the spec is explicit, and a kit built from the
      // job description alone is still a usable kit.
      status: 'ok',
      kit: result.kit,
      error: null,
      meta: {
        elapsedMs: Date.now() - startedAt,
        notes: result.notes,
        budget: result.budget,
        governor: result.governor,
        requirements: result.kit.role.requirements.length,
        questions: result.kit.questions.length,
        // Read off the finished kit rather than off the loop's own opinion of how it
        // went — the two disagreeing is precisely the bug worth catching.
        uncovered: result.kit.coverage.uncovered_requirement_ids.length,
        passes: result.kit.coverage.passes,
        pagesUsed: result.kit.source.pages_used.length,
        days: result.kit.schedule.days_available,
      },
    };
  } catch (error) {
    // `status: "failed"` ONLY when no kit could be produced — which is exactly when
    // buildKit throws, and it throws for only two reasons. Everything softer already
    // came back as a note on a successful kit.
    const translated = toCaseError(error);

    return {
      id: kase.id,
      status: 'failed',
      kit: null,
      error: translated,
      meta: {
        elapsedMs: Date.now() - startedAt,
        notes: error instanceof BuildFailedError ? [] : [`Unexpected error type: ${error?.name}`],
        budget: budget.report(),
        governor: governor.report(),
      },
    };
  }
}
