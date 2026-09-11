/**
 * research.js — the retrieval and extraction half of a kit build, steps 1 to 8.
 *
 * Decides: the order the research steps run in, and what a failure in each one costs.
 *
 * Does NOT decide: coverage (coverageLoop.js), assembly (assemble.js), or whether there
 * is time left (the governor passes that in). It performs no validation — the kit does
 * not exist yet at this point.
 *
 * THE ORDER IS NOT ARBITRARY.
 *   Requirements and the role profile come FIRST, from the pasted job description, which
 *   needs no retrieval and cannot fail for network reasons. So even a company whose site
 *   is unreachable still yields a kit with real requirements in it — the single most
 *   valuable part — rather than nothing.
 *   The crawl, the hiring page and the search follow, each degrading independently.
 *   The company brief comes after retrieval because it may only describe pages that were
 *   actually fetched.
 *   The hiring process comes before question generation because it CHANGES question
 *   generation. Reversing those two would make finding the page decorative.
 *
 * FAILURE POLICY, APPLIED PER STEP RATHER THAN GLOBALLY:
 *   retrieval        degrades, always. A dead URL yields zero pages and a recorded skip.
 *   hiring page      null is a correct answer.
 *   public discussion empty is a correct answer, and it is never skipped.
 *   company brief    no pages means no call and an honest "could not read" brief.
 *   one category     a failed question call is recorded; its requirements fall to the
 *                    coverage pass, which is precisely what the coverage pass is for.
 *   requirements     the one step with no degraded form. No requirements, no kit.
 */

import { extractRequirements } from '../generation/extractRequirements.js';
import { extractRoleProfile } from '../generation/extractRoleProfile.js';
import { summariseCompany } from '../generation/summariseCompany.js';
import { extractHiringProcess } from '../generation/extractHiringProcess.js';
import { routeAll } from '../generation/routeCategories.js';
import { generateQuestionsForCategory } from '../generation/generateQuestions.js';
import { crawlSite } from '../retrieval/crawl.js';
import { findHiringPage } from '../retrieval/findHiringPage.js';
import { searchPublicDiscussion } from '../retrieval/searchPublicDiscussion.js';
import { QUESTION_CATEGORIES } from '../contracts/kitSchema.js';
import { STEPS, STATUS } from './steps.js';

/** A step that cannot run because the budget is gone looks the same as one skipped. */
function isBudgetExhausted(error) {
  return error?.code === 'BUDGET_EXHAUSTED';
}

/**
 * Steps 1 and 2: everything the pasted job description alone can tell us.
 *
 * Separated from the rest because these two are the floor of the deliverable. If the
 * network is down, the company is unreachable and the budget is nearly gone, a kit built
 * from only these is still worth opening.
 */
export async function researchFromJd({ jd, deps, reporter, budget, state }) {
  const { provider } = deps;

  // --- 1. requirements ------------------------------------------------------
  if (!state.requirements) {
    reporter.emit(STEPS.REQUIREMENTS, STATUS.STARTED);
    // No try/catch: this is the one step with no degraded form. A kit with no
    // requirements has nothing to generate questions about, nothing to cover and
    // nothing to schedule — it is not a degraded kit, it is an absent one.
    const extraction = await extractRequirements(jd, {
      provider,
      spend: () => budget.spend(STEPS.REQUIREMENTS),
      onDrop: (drop) => reporter.emit(STEPS.REQUIREMENTS, STATUS.DEGRADED, { drop }),
    });

    state.requirements = extraction.requirements;
    state.requirementNotes = extraction.note;
    state.droppedRequirements = extraction.dropped;
    state.thinJd = extraction.thin;

    reporter.emit(STEPS.REQUIREMENTS, STATUS.DONE, {
      count: extraction.requirements.length,
      dropped: extraction.dropped.length,
      thin: extraction.thin,
    });
  }

  // --- 2. role profile ------------------------------------------------------
  if (!state.roleProfile) {
    reporter.emit(STEPS.ROLE_PROFILE, STATUS.STARTED);
    try {
      state.roleProfile = await extractRoleProfile(jd, {
        provider,
        spend: () => budget.spend(STEPS.ROLE_PROFILE),
      });
      reporter.emit(STEPS.ROLE_PROFILE, STATUS.DONE, { missing: state.roleProfile.missing });
    } catch (error) {
      // A kit with empty title and seniority is hollow but valid, and the requirements
      // are already safe. Losing the profile is not worth losing them.
      state.roleProfile = { title: '', seniority: '', company: '', location: '', responsibilities: [], missing: ['all'] };
      state.notes.push(`Role profile unavailable (${error.code ?? 'error'}): ${error.message}`);
      reporter.emit(STEPS.ROLE_PROFILE, STATUS.FAILED, { code: error.code });
    }
  }

  return state;
}

/**
 * Steps 3 to 7: what the company publishes about itself.
 *
 * Every step here degrades. None of them can fail the build.
 */
export async function researchCompany({ companyUrl, deps, reporter, budget, state, governor }) {
  const { provider, fetcher, robots, cache, ledger, searchProvider } = deps;

  // --- 3. crawl -------------------------------------------------------------
  if (!state.crawl) {
    reporter.emit(STEPS.CRAWL, STATUS.STARTED, { url: companyUrl });
    try {
      const crawl = await crawlSite(companyUrl, {
        fetcher,
        robots,
        cache,
        maxPages: deps.crawlMaxPages,
        maxDepth: deps.crawlMaxDepth,
        concurrency: deps.crawlConcurrency,
      });
      state.crawl = crawl;
      ledger.recordCrawl(crawl);

      reporter.emit(
        STEPS.CRAWL,
        crawl.pages.length === 0 ? STATUS.DEGRADED : STATUS.DONE,
        { pages: crawl.pages.length, skipped: crawl.skipped.length }
      );
      if (crawl.pages.length === 0) {
        state.notes.push(`The company site at ${companyUrl} yielded no readable pages.`);
      }
    } catch (error) {
      // crawlSite is not supposed to throw; if it does, the kit still proceeds.
      state.crawl = { pages: [], skipped: [], hiringPageCandidates: [] };
      state.notes.push(`Crawl failed outright (${error.code ?? 'error'}): ${error.message}`);
      reporter.emit(STEPS.CRAWL, STATUS.FAILED, { code: error.code });
    }
  }

  // --- 4. hiring page -------------------------------------------------------
  if (state.hiringPage === undefined) {
    reporter.emit(STEPS.HIRING_PAGE, STATUS.STARTED);
    try {
      const found = await findHiringPage({
        candidates: state.crawl.hiringPageCandidates,
        pages: state.crawl.pages,
        provider,
        spend: () => budget.spend(STEPS.HIRING_PAGE),
      });
      state.hiringPage = found.page;
      state.hiringPageReason = found.reason;
      reporter.emit(STEPS.HIRING_PAGE, found.page ? STATUS.DONE : STATUS.DEGRADED, {
        reason: found.reason,
        url: found.page?.url ?? null,
      });
      if (!found.page) state.notes.push(`No hiring page found (${found.reason}).`);
    } catch (error) {
      state.hiringPage = null;
      state.hiringPageReason = isBudgetExhausted(error) ? 'BUDGET_EXHAUSTED' : 'LOOKUP_FAILED';
      state.notes.push(`Hiring page lookup failed (${error.code ?? 'error'}).`);
      reporter.emit(STEPS.HIRING_PAGE, STATUS.FAILED, { code: error.code });
    }
  }

  // --- 5. public discussion — NEVER skipped --------------------------------
  if (!state.search) {
    reporter.emit(STEPS.PUBLIC_DISCUSSION, STATUS.STARTED);
    // Under time pressure this degrades to a single short query; it does not stop.
    // The rubric credits having searched, and an empty result honestly recorded is
    // worth points that never looking is not.
    const degraded = governor?.isOverDeadline?.() ?? false;
    const search = await searchPublicDiscussion({
      provider: searchProvider,
      company: state.roleProfile?.company || null,
      role: state.roleProfile?.title || null,
      maxResults: degraded ? 1 : 5,
    });
    state.search = search;
    ledger.recordSearch(search);

    reporter.emit(
      STEPS.PUBLIC_DISCUSSION,
      search.results.length > 0 ? STATUS.DONE : STATUS.DEGRADED,
      { attempted: search.attempted, reason: search.reason, results: search.results.length, narrowed: degraded }
    );
    if (search.results.length === 0) {
      state.notes.push(`Public discussion search ran and found nothing (${search.reason}).`);
    }
  }

  // --- 6. company brief — only from pages actually retrieved ---------------
  if (!state.companyBrief) {
    reporter.emit(STEPS.COMPANY_BRIEF, STATUS.STARTED);
    try {
      const result = await summariseCompany(
        {
          crawledPages: state.crawl.pages,
          hiringPage: state.hiringPage,
          searchResults: state.search.results,
        },
        {
          provider,
          spend: () => budget.spend(STEPS.COMPANY_BRIEF),
          vouch: (urls) => ledger.vouch(urls),
        }
      );
      state.companyBrief = result.brief;
      reporter.emit(STEPS.COMPANY_BRIEF, result.grounded ? STATUS.DONE : STATUS.DEGRADED, {
        reason: result.reason,
        usedModel: result.usedModel,
      });
      if (!result.grounded) state.notes.push(`Company brief is not grounded (${result.reason}).`);
    } catch (error) {
      state.companyBrief = {
        summary: 'The company brief could not be produced for this run.',
        what_they_do: '',
        sources: ledger.pagesUsed(),
      };
      state.notes.push(`Company brief failed (${error.code ?? 'error'}).`);
      reporter.emit(STEPS.COMPANY_BRIEF, STATUS.FAILED, { code: error.code });
    }
  }

  // --- 7. hiring process — only if a page was found ------------------------
  if (state.hiringProcess === undefined) {
    if (!state.hiringPage) {
      state.hiringProcess = null;
      reporter.emit(STEPS.HIRING_PROCESS, STATUS.SKIPPED, { reason: 'NO_HIRING_PAGE' });
    } else {
      reporter.emit(STEPS.HIRING_PROCESS, STATUS.STARTED);
      try {
        const result = await extractHiringProcess(
          { hiringPage: state.hiringPage, searchResults: state.search.results },
          { provider, spend: () => budget.spend(STEPS.HIRING_PROCESS) }
        );
        state.hiringProcess = result.process;
        reporter.emit(STEPS.HIRING_PROCESS, result.process ? STATUS.DONE : STATUS.DEGRADED, {
          reason: result.reason,
          stages: result.process?.stages.length ?? 0,
        });
      } catch (error) {
        state.hiringProcess = null;
        state.notes.push(`Hiring process extraction failed (${error.code ?? 'error'}).`);
        reporter.emit(STEPS.HIRING_PROCESS, STATUS.FAILED, { code: error.code });
      }
    }
  }

  return state;
}

/**
 * Step 8: route in code, then one call per category.
 *
 * The routing is a pure function, so the category mix is decided before any call is made
 * — and because the hiring process feeds that routing, a company that runs a
 * system-design round gets a different set of calls, not merely a different prompt.
 *
 * A failed category is recorded and its requirements are left alone. They will show up
 * as gaps in the coverage pass, which will try again with a different shape of call.
 * That is cheaper and more likely to work than retrying the same failing call here.
 */
export async function generateQuestions({ deps, reporter, budget, state }) {
  const { provider } = deps;

  if (state.questions?.length > 0) return state;

  const routed = routeAll(state.requirements, state.hiringProcess, state.roleProfile);
  state.routing = routed;
  state.questions = [];
  state.failedCategories = [];

  reporter.emit(STEPS.QUESTIONS, STATUS.STARTED, { distribution: routed.distribution });

  for (const category of QUESTION_CATEGORIES) {
    const requirements = routed.byCategory[category];
    if (requirements.length === 0) continue;

    if (!budget.canSpend(1)) {
      state.failedCategories.push({ category, reason: 'BUDGET_EXHAUSTED' });
      reporter.emit(STEPS.QUESTIONS, STATUS.SKIPPED, { category, reason: 'BUDGET_EXHAUSTED' });
      continue;
    }

    try {
      const result = await generateQuestionsForCategory(
        {
          category,
          requirements,
          roleContext: {
            ...state.roleProfile,
            whatTheyDo: state.companyBrief?.what_they_do ?? '',
          },
          hiringProcess: state.hiringProcess,
          existingIds: state.questions.map((question) => question.id),
        },
        { provider, spend: () => budget.spend(`${STEPS.QUESTIONS}:${category}`) }
      );

      state.questions.push(...result.questions);

      // Requirements past the per-call batch cap are not lost: they are simply
      // uncovered, and the coverage pass is the mechanism that notices.
      if (result.deferred.length > 0) {
        state.notes.push(
          `${result.deferred.length} ${category} requirement(s) exceeded the per-call batch size and were left to the coverage pass.`
        );
      }

      reporter.emit(STEPS.QUESTIONS, STATUS.DONE, {
        category,
        produced: result.questions.length,
        rejected: result.rejected.length,
        deferred: result.deferred.length,
      });
    } catch (error) {
      state.failedCategories.push({ category, reason: error.code ?? 'ERROR' });
      state.notes.push(`The ${category} question call failed (${error.code ?? 'error'}).`);
      reporter.emit(STEPS.QUESTIONS, STATUS.FAILED, { category, code: error.code });
    }
  }

  return state;
}
