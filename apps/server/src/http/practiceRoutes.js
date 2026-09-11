/**
 * practiceRoutes.js — record how confident someone felt answering a question.
 *
 * Decides: what a practice rating is and where it lives.
 *
 * Does NOT decide: what to do with the ratings. Reordering a schedule around weak
 * answers would be a genuinely useful feature and is not this one — it is out of scope,
 * and building half of it would leave a field nothing reads.
 *
 * RATINGS ARE NOT PART OF THE KIT. They live in their own array on the kit DOCUMENT,
 * beside `kit`, never inside it. Three reasons:
 *   - The kit is the frozen contract. Adding a field to it is allowed but pointless
 *     here, and a batch run would then emit practice data that never existed.
 *   - A regeneration replaces questions. Ratings attached to questions inside the kit
 *     would be destroyed by a merge, and a merge has no business deleting a record of
 *     what a person did.
 *   - They are an append-only log, not state. "I rated q3 a 2, then later a 4" is the
 *     interesting shape; overwriting loses exactly the thing worth knowing.
 *
 * THE RATING DOES NOT BUMP THE KIT'S REVISION, and does not take one. Recording that
 * you practised is not an edit to the kit, and requiring a revision would mean a
 * practice session in one tab starts failing because a regeneration finished in
 * another — for a write that cannot conflict with anything.
 */

import { route, ApiError } from './errors.js';
import { validatePractice } from './validate.js';
import { requireAuth, withOwnedKit } from '../auth/requireAuth.js';

/** Keep the log bounded; a kit is not a time-series database. */
const MAX_RATINGS = 2000;

export function mountPracticeRoutes(app) {
  /**
   * POST /api/kits/:id/practice — { questionId, confidence, note? }
   */
  app.post(
    '/api/kits/:id/practice',
    requireAuth,
    withOwnedKit(),
    route(async (request, response) => {
      const kitDoc = request.kit;
      const kitId = String(kitDoc.id ?? kitDoc._id);

      if (!kitDoc.kit) {
        throw new ApiError('KIT_NOT_READY', 'This kit has not finished building yet.');
      }

      const { questionId, confidence, note } = validatePractice(request.body);

      // The question must exist in THIS kit. Without the check, a typo silently records
      // a rating against nothing, and the practice history quietly fills with entries
      // that can never be shown next to a question.
      const exists = (kitDoc.kit.questions ?? []).some((question) => question.id === questionId);
      if (!exists) {
        throw new ApiError('VALIDATION_FAILED', `No question with id "${questionId}" in this kit.`);
      }

      if ((kitDoc.practice ?? []).length >= MAX_RATINGS) {
        throw new ApiError(
          'VALIDATION_FAILED',
          `This kit already holds ${MAX_RATINGS} practice ratings, which is more than a person can have meant.`
        );
      }

      const entry = {
        questionId,
        confidence,
        note,
        at: new Date(),
      };

      // Appended, not merged into the kit, and deliberately without a revision check —
      // see the header. `write` still bumps the revision, which is honest: the document
      // did change, and a client holding an older view should know.
      const updated = await request.store.kits.write({
        kitId,
        push: { practice: entry },
      });

      const history = (updated.practice ?? []).filter((item) => item.questionId === questionId);

      response.status(201).json({
        recorded: entry,
        // What the UI actually wants back: this question's trend, not the whole log.
        question: {
          id: questionId,
          attempts: history.length,
          latest: confidence,
          // The first rating is the honest baseline; the change between first and
          // latest is the only progress signal a confidence scale supports.
          first: history[0]?.confidence ?? confidence,
        },
      });
    })
  );

  /**
   * GET /api/kits/:id/practice — the log, and a per-question summary.
   */
  app.get(
    '/api/kits/:id/practice',
    requireAuth,
    withOwnedKit(),
    route(async (request, response) => {
      const entries = request.kit.practice ?? [];

      const byQuestion = new Map();
      for (const entry of entries) {
        if (!byQuestion.has(entry.questionId)) {
          byQuestion.set(entry.questionId, { id: entry.questionId, attempts: 0, first: entry.confidence, latest: entry.confidence });
        }
        const summary = byQuestion.get(entry.questionId);
        summary.attempts += 1;
        summary.latest = entry.confidence;
      }

      response.json({
        total: entries.length,
        entries,
        // Weakest first: the point of recording confidence is to find what to revise,
        // and a list sorted by question id makes that the reader's job.
        questions: [...byQuestion.values()].sort((a, b) => a.latest - b.latest),
      });
    })
  );

  return app;
}
