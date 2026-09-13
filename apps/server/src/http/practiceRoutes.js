/**
 * practiceRoutes.js — record how confident someone felt, card by card or question by question.
 *
 * Decides: what a practice rating is, where it lives, how the log is summarised per
 * item, and that the practice read carries the deck in practice order.
 *
 * Does NOT decide: what that order is. `orderCards` in core decides it from the ratings;
 * this route only serves the answer. Reordering a study SCHEDULE around weak answers is
 * still out of scope.
 *
 * THE ORDER IS SERVED, NOT COMPUTED IN THE BROWSER. The web client imports nothing from
 * core, so a client that ordered cards itself would be carrying a second copy of the
 * algorithm — one that could drift from the one the tests defend. The order is computed
 * on every read, at the moment of the read, because its recency push depends on the
 * clock.
 *
 * RATINGS ARE NOT PART OF THE KIT. They live in their own array on the kit DOCUMENT,
 * beside `kit`, never inside it. Three reasons:
 *   - The kit is the frozen contract. Adding a field to it is allowed but pointless
 *     here, and a batch run would then emit practice data that never existed.
 *   - A regeneration replaces questions and flashcards. Ratings attached to them inside
 *     the kit would be destroyed by a merge, and a merge has no business deleting a
 *     record of what a person did.
 *   - They are an append-only log, not state. "I rated f3 again, then later good" is the
 *     interesting shape; overwriting loses exactly the thing worth knowing.
 *
 * A RATING IS ABOUT ONE THING — a flashcard (`cardId`, again/hard/good/easy as 1–4) or a
 * question (`questionId`, 1–5). Both kinds share the one log, so a person's practice
 * history stays a single timeline, and each is summarised separately.
 *
 * A RATING TAKES NO REVISION. Recording that you practised is not an edit to the kit,
 * and requiring a revision would mean a practice session in one tab starts failing
 * because a regeneration finished in another — for a write that cannot conflict with
 * anything.
 */

import { orderCards } from '@aipk/core/practice/orderCards.js';

import { route, ApiError } from './errors.js';
import { validatePractice } from './validate.js';
import { requireAuth, withOwnedKit } from '../auth/requireAuth.js';

/** Keep the log bounded; a kit is not a time-series database. Shared with the score route. */
export const MAX_RATINGS = 2000;

/**
 * One summary per rated item: attempts, the first rating (the honest baseline), the
 * latest, and when it was last rated. `key` is `cardId` or `questionId`.
 */
function summariseBy(entries, key) {
  const byItem = new Map();
  for (const entry of entries) {
    const id = entry?.[key];
    if (!id) continue;
    if (!byItem.has(id)) byItem.set(id, { id, attempts: 0, first: entry.confidence, latest: entry.confidence, lastAt: entry.at });
    const summary = byItem.get(id);
    summary.attempts += 1;
    summary.latest = entry.confidence;
    summary.lastAt = entry.at;
  }
  return [...byItem.values()];
}

export function mountPracticeRoutes(app) {
  /**
   * POST /api/kits/:id/practice — { cardId, confidence, note? } or { questionId, confidence, note? }
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

      const { questionId, cardId, confidence, note } = validatePractice(request.body);
      const key = cardId ? 'cardId' : 'questionId';
      const itemId = cardId ?? questionId;
      const noun = cardId ? 'flashcard' : 'question';

      // The item must exist in THIS kit. Without the check, a typo silently records a
      // rating against nothing, and the practice history quietly fills with entries that
      // can never be shown next to anything.
      const items = cardId ? kitDoc.kit.flashcards : kitDoc.kit.questions;
      if (!(items ?? []).some((item) => item.id === itemId)) {
        throw new ApiError('VALIDATION_FAILED', `No ${noun} with id "${itemId}" in this kit.`);
      }

      if ((kitDoc.practice ?? []).length >= MAX_RATINGS) {
        throw new ApiError(
          'VALIDATION_FAILED',
          `This kit already holds ${MAX_RATINGS} practice ratings, which is more than a person can have meant.`
        );
      }

      const entry = { [key]: itemId, confidence, note, at: new Date() };

      // Appended, not merged into the kit, and deliberately without a revision check —
      // see the header. `write` still bumps the revision, which is honest: the document
      // did change, and a client holding an older view should know.
      const updated = await request.store.kits.write({
        kitId,
        push: { practice: entry },
      });

      // What the UI actually wants back: this item's trend, not the whole log.
      const [summary] = summariseBy((updated.practice ?? []).filter((item) => item[key] === itemId), key);

      response.status(201).json({
        recorded: entry,
        [cardId ? 'card' : 'question']: summary ?? { id: itemId, attempts: 1, first: confidence, latest: confidence, lastAt: entry.at },
      });
    })
  );

  /**
   * GET /api/kits/:id/practice — the log, a summary per card and per question, and the
   * deck: the kit's flashcards in the order to practise them next.
   */
  app.get(
    '/api/kits/:id/practice',
    requireAuth,
    withOwnedKit(),
    route(async (request, response) => {
      const entries = request.kit.practice ?? [];

      response.json({
        total: entries.length,
        entries,
        // Least confident first (`orderCards`). Empty for a kit that has not finished
        // building, which has no flashcards to order.
        deck: orderCards({ cards: request.kit.kit?.flashcards ?? [], ratings: entries, now: Date.now() }),
        cards: summariseBy(entries, 'cardId'),
        // Weakest first: the point of recording confidence is to find what to revise,
        // and a list sorted by question id makes that the reader's job.
        questions: summariseBy(entries, 'questionId').sort((a, b) => a.latest - b.latest),
      });
    })
  );

  return app;
}
