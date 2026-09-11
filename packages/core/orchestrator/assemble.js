/**
 * assemble.js — turn accumulated state into a contract-shaped kit.
 *
 * Decides: which part of the run each field comes from.
 *
 * Does NOT decide: whether the result is valid (validateKit, verifySchedule) or whether
 * anything is missing (the coverage loop already settled that). It copies, it does not
 * compute — with one exception, `jd_chars`, which is measured here because this is where
 * the input is still in scope.
 *
 * EVERY FIELD HAS EXACTLY ONE SOURCE, AND THEY ARE NOT INTERCHANGEABLE:
 *   source.company       the role profile, as printed on the posting
 *   source.company_url   the INPUT. Never the crawl's first page, which may be a
 *                        redirect target, and never the model's idea of the company's
 *                        website. What the caller asked about is what gets recorded.
 *   source.role          the role profile's TITLE — a string, and a different field from
 *                        the role object. Collapsing the two is a hard contract failure.
 *   source.location      the role profile. Empty when the posting did not say.
 *   source.jd_chars      measured from the input, not reported by a model
 *   source.researched_at the moment assembly happens
 *   source.pages_used    the source LEDGER only — URLs it saw fetched successfully
 *
 * WHY THE LEDGER AND NOT THE CRAWL RESULT. They usually agree, and when they disagree
 * the ledger is right: it recorded what actually came back, including pages fetched
 * outside the crawl (the hiring page, robots.txt) and excluding anything that 404'd or
 * timed out. Reading provenance from the crawl would also quietly re-include pages the
 * ledger refused to vouch for.
 *
 * AN EMPTY FIELD IS A FINISHED FIELD. Where the run learned nothing, the kit says so
 * with "" or [] rather than a guess. A kit with an empty location is honest; one with an
 * invented location is a document someone prepares from.
 */

import { createEmptyKit } from '../contracts/emptyKit.js';
import { stampKit } from '../contracts/provenance.js';

/**
 * Build the kit.
 *
 * @param {object} options
 * @param {{ jd: string, company_url?: string, days: number }} options.input
 * @param {object} options.state accumulated run state
 * @param {object} options.schedule from the allocator
 * @param {{ pagesUsed: Function, sources: Function }} options.ledger
 * @param {string} [options.researchedAt] injected for deterministic tests
 * @returns {object} a contract-shaped kit
 */
export function assembleKit({ input, state, schedule, ledger, researchedAt }) {
  const profile = state.roleProfile ?? {};

  const kit = createEmptyKit({
    daysAvailable: input.days,
    company: profile.company ?? '',
    companyUrl: input.company_url ?? '',
    // The advertised role title, as a string. NOT the role object.
    role: profile.title ?? '',
    location: profile.location ?? '',
    jdChars: typeof input.jd === 'string' ? input.jd.length : 0,
    researchedAt,
  });

  // Provenance comes from the ledger and nowhere else.
  kit.source.pages_used = ledger.pagesUsed();

  kit.company_brief = state.companyBrief ?? {
    summary: '',
    what_they_do: '',
    sources: ledger.sources(),
  };

  kit.role.title = profile.title ?? '';
  kit.role.seniority = profile.seniority ?? '';
  kit.role.responsibilities = Array.isArray(profile.responsibilities) ? profile.responsibilities : [];
  kit.role.requirements = Array.isArray(state.requirements) ? state.requirements : [];

  kit.questions = Array.isArray(state.questions) ? state.questions : [];
  kit.flashcards = Array.isArray(state.flashcards) ? state.flashcards : [];
  kit.schedule = schedule;

  // Reality, not intention: the passes that ran, and the gaps that remain.
  kit.coverage = {
    uncovered_requirement_ids: Array.isArray(state.uncovered) ? state.uncovered : [],
    passes: Number.isInteger(state.coveragePasses) ? state.coveragePasses : 0,
  };

  // Extra fields, permitted by the contract. This is where degradation stops being a
  // thing that happened during the run and becomes a thing the kit can tell you about:
  // a reader holding only the JSON can see what was skipped and why.
  kit.run_notes = Array.isArray(state.notes) ? [...state.notes] : [];
  if (Array.isArray(state.droppedRequirements) && state.droppedRequirements.length > 0) {
    kit.dropped_requirements = state.droppedRequirements.map((drop) => ({
      text: drop.text ?? '',
      evidence: drop.evidence ?? '',
      reason: drop.reason ?? 'EVIDENCE_UNSUPPORTED',
      score: drop.score ?? 0,
    }));
  }
  if (state.thinJd) kit.thin_jd = true;

  // Every item gets provenance before the kit leaves, so there is never a kit whose
  // items have no `origin`. A merge arriving at an unstamped item cannot then mistake a
  // person's work for the model's, and `isReplaceable` never has to guess.
  stampKit(kit, { updatedAt: researchedAt });

  return kit;
}
