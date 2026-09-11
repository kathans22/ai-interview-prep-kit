/**
 * regenerateRoutes.js — rebuild one section, and put it back if that was a mistake.
 *
 * Decides: the order of snapshot, generate, merge and write.
 *
 * Does NOT decide: what a regeneration produces (the generation modules), which items
 * survive it (`merge.js`), or what a snapshot contains (`undo.js`). This route is the
 * one place those four are sequenced, and the sequence is the whole correctness story.
 *
 * THE ORDER IS NOT NEGOTIABLE:
 *   1. snapshot the section        — before anything changes, or undo restores the new
 *                                    state over the new state and does nothing
 *   2. generate the replacement    — costs model calls, so it happens after the cheap
 *                                    checks have passed
 *   3. merge                       — edits, manual items and pins survive; ids are
 *                                    reused so schedule references stay valid
 *   4. recompute and validate      — the question set changed
 *   5. write with the revision     — a conflict here means someone else moved first
 *
 * A FAILED GENERATION MUST NOT LOSE THE SECTION. Steps 1 and 2 are separated by a real
 * possibility of failure: the model can be rate-limited, blocked, or simply down. If
 * generation throws after the snapshot, the kit is untouched — the snapshot is
 * harmless, and the section the user already had is still there. The opposite order,
 * clearing a section before generating its replacement, produces an empty section and
 * an apology.
 *
 * REGENERATION SPENDS QUOTA, so it is rate-limited alongside kit creation. On a
 * twenty-a-day ceiling, a user clicking "regenerate" five times is a day's budget.
 */

import { mergeSection, MERGEABLE_SECTIONS } from '@aipk/core/contracts/merge.js';
import { validateKit, formatValidationErrors } from '@aipk/core/contracts/validateKit.js';
import { QUESTION_CATEGORIES } from '@aipk/core/contracts/kitSchema.js';
import { generateQuestionsForCategory } from '@aipk/core/generation/generateQuestions.js';
import { generateFlashcards } from '@aipk/core/generation/generateFlashcards.js';
import { summariseCompany } from '@aipk/core/generation/summariseCompany.js';
import { createBudget } from '@aipk/core/llm/budget.js';

import { route, ApiError } from './errors.js';
import { validateRegenerate, validateRevision } from './validate.js';
import { requireAuth, withOwnedKit } from '../auth/requireAuth.js';
import { writeKitChecked } from './writeKit.js';
import { captureSection, UNDOABLE_SECTIONS } from '../models/undo.js';

/**
 * Regenerating a section costs at most this many calls.
 *
 * Smaller than a whole kit's budget on purpose: a regeneration is one section, and a
 * request that could spend twelve calls would let a single button press exhaust half a
 * day's quota.
 */
const REGENERATE_BUDGET = 4;

/**
 * Produce replacement content for one section.
 *
 * Kept separate from the route so the sequencing above reads as five steps rather than
 * five steps with a switch statement in the middle.
 */
async function generateReplacement({ section, category, kit, deps, budget }) {
  const roleContext = {
    title: kit.role?.title ?? '',
    seniority: kit.role?.seniority ?? '',
    company: kit.source?.company ?? '',
    responsibilities: kit.role?.responsibilities ?? [],
    whatTheyDo: kit.company_brief?.what_they_do ?? '',
  };

  if (section === 'questions') {
    // Only the requirements this category covers, so a regeneration of "technical"
    // cannot quietly produce behavioural questions.
    const requirements = (kit.role?.requirements ?? []).filter((requirement) =>
      (kit.questions ?? []).some(
        (question) => question.category === category && question.requirement_ids?.includes(requirement.id)
      )
    );

    if (requirements.length === 0) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `There are no ${category} questions in this kit to regenerate.`
      );
    }

    const result = await generateQuestionsForCategory(
      { category, requirements, roleContext, hiringProcess: kit.hiring_process ?? null },
      { provider: deps.provider, spend: () => budget.spend(`regenerate:${category}`) }
    );
    return result.questions;
  }

  if (section === 'flashcards') {
    const result = await generateFlashcards(
      { requirements: kit.role?.requirements ?? [], questions: kit.questions ?? [] },
      { provider: deps.provider, spend: () => budget.spend('regenerate:flashcards') }
    );
    return result.flashcards;
  }

  if (section === 'company_brief') {
    // Only pages the kit already recorded. A regeneration cannot go back to the
    // internet — the crawl belongs to the build, and re-fetching here would spend time
    // and quota outside the budget this request declared.
    const pages = (kit.source?.pages_used ?? []).map((url) => ({ url, text: '' }));
    const result = await summariseCompany(
      { crawledPages: pages },
      { provider: deps.provider, spend: () => budget.spend('regenerate:brief') }
    );
    return result.brief;
  }

  // schedule: nothing is generated; merge recomputes the allocation from the questions.
  return null;
}

/**
 * Mount regeneration and undo.
 */
export function mountRegenerateRoutes(app, { rateLimit = (req, res, next) => next() } = {}) {
  /**
   * POST /api/kits/:id/regenerate — { section, category?, revision }
   */
  app.post(
    '/api/kits/:id/regenerate',
    requireAuth,
    rateLimit,
    withOwnedKit(),
    route(async (request, response) => {
      const kitDoc = request.kit;
      const kitId = String(kitDoc.id ?? kitDoc._id);

      if (!kitDoc.kit) {
        throw new ApiError('KIT_NOT_READY', 'This kit has not finished building yet.');
      }

      const { section, category, revision } = validateRegenerate(request.body, {
        sections: MERGEABLE_SECTIONS,
        categories: QUESTION_CATEGORIES,
      });

      if (section === 'questions' && !category) {
        throw new ApiError(
          'VALIDATION_FAILED',
          'Regenerating questions needs a category. Regenerating all four at once would spend most of a day of quota in one click.'
        );
      }

      // --- 1. snapshot, BEFORE anything changes ----------------------------
      // Written with the revision check so a snapshot cannot be taken against a kit
      // that has already moved on. This is also the request's conflict point: if it
      // succeeds, this request owns the next write.
      const snapshot = captureSection(kitDoc.kit, section);
      const afterSnapshot = await writeKitChecked(request, {
        kitId,
        expectedRevision: revision,
        set: { [`previousSections.${section}`]: snapshot },
      });

      // --- 2. generate -----------------------------------------------------
      const budget = createBudget(REGENERATE_BUDGET);
      let incoming;
      try {
        incoming = await generateReplacement({
          section,
          category,
          kit: kitDoc.kit,
          deps: request.deps,
          budget,
        });
      } catch (error) {
        // The kit still holds everything it had. The snapshot is now redundant but
        // harmless — undo would restore the section to exactly what it already is.
        throw new ApiError(
          error.code ?? 'GENERATION_UNAVAILABLE',
          `The ${section} could not be regenerated: ${error.message} Your existing content has not been changed.`
        );
      }

      // --- 3 and 4. merge, recompute, validate -----------------------------
      const { kit: merged, report } = mergeSection({
        kit: kitDoc.kit,
        section,
        incoming,
        category,
      });

      const validation = validateKit(merged);
      if (!validation.valid) {
        throw new ApiError(
          'BUILD_INVALID_KIT',
          `The regenerated ${section} produced an invalid kit:\n${formatValidationErrors(validation.errors)}`
        );
      }

      // --- 5. write --------------------------------------------------------
      const updated = await writeKitChecked(request, {
        kitId,
        expectedRevision: afterSnapshot.revision,
        set: { kit: merged },
      });

      response.json({
        id: kitId,
        revision: updated.revision,
        section,
        category,
        // What actually happened, so the UI can say "two replaced, one kept because you
        // edited it" instead of leaving a user to spot the difference.
        report,
        budget: budget.report(),
        kit: updated.kit,
      });
    })
  );

  /**
   * POST /api/kits/:id/undo-regenerate — { section, revision }
   */
  app.post(
    '/api/kits/:id/undo-regenerate',
    requireAuth,
    withOwnedKit(),
    route(async (request, response) => {
      const kitDoc = request.kit;
      const kitId = String(kitDoc.id ?? kitDoc._id);

      const section = String(request.body?.section ?? '').trim();
      if (!UNDOABLE_SECTIONS.includes(section)) {
        throw new ApiError('UNDO_UNKNOWN_SECTION', `"${section}" cannot be undone.`);
      }
      const revision = validateRevision(request.body?.revision);

      const snapshot = kitDoc.previousSections?.[section];
      if (!snapshot) {
        throw new ApiError(
          'NOTHING_TO_UNDO',
          `There is nothing to undo for ${section} — no regeneration has replaced it since the last undo.`
        );
      }

      // Restore the captured fields and clear the snapshot in the same write, so a
      // second undo cannot replay it into an unrelated later state.
      const set = { [`previousSections.${section}`]: null };
      for (const [field, value] of Object.entries(snapshot)) {
        set[`kit.${field}`] = value;
      }

      const updated = await writeKitChecked(request, {
        kitId,
        expectedRevision: revision,
        set,
      });

      response.json({
        id: kitId,
        revision: updated.revision,
        section,
        restored: Object.keys(snapshot),
        kit: updated.kit,
      });
    })
  );

  return app;
}
