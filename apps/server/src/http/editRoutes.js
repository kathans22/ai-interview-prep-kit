/**
 * editRoutes.js — a person changing their own kit.
 *
 * Decides: which edits are possible, and what each one does to provenance and the
 * revision.
 *
 * Does NOT decide: what a kit may contain (`validateKit`), how coverage and the
 * schedule are derived (`recomputeDerived`), or whether a write may land
 * (`writeWithRevision`). The route assembles those three and maps the result.
 *
 * FIVE OPERATIONS, ONE ENDPOINT. `PATCH /api/kits/:id` takes `{ revision, ops: [...] }`.
 * A batch of operations rather than five endpoints, because a drag-and-drop reorder is
 * one user action that moves several items, and sending it as five requests means five
 * revisions, five chances to conflict, and an interface that can end up half-applied.
 * One request, one revision bump, all-or-nothing.
 *
 * EVERY EDIT MARKS PROVENANCE. Touching a generated item makes it `edited`; adding one
 * makes it `manual`. This is not bookkeeping for its own sake — it is what stops the
 * next regeneration from overwriting the work. An edit that did not mark provenance
 * would survive until the user pressed "regenerate", and then vanish.
 *
 * THE KIT IS VALIDATED BEFORE IT IS SAVED, ALWAYS. A user can delete every question,
 * reorder days into nonsense, or move a question to a category that does not exist.
 * `validateKit` runs on the result and a failure is a 400 naming the problem — the
 * database never holds a kit that violates the contract, whatever a client sends.
 */

import { validateKit, formatValidationErrors } from '@aipk/core/contracts/validateKit.js';
import { recomputeDerived } from '@aipk/core/contracts/merge.js';
import { markEdited, markManual, setPinned, ORIGINS } from '@aipk/core/contracts/provenance.js';
import { nextIdFor } from '@aipk/core/contracts/ids.js';
import { QUESTION_CATEGORIES } from '@aipk/core/contracts/kitSchema.js';

import { route, ApiError } from './errors.js';
import { validateRevision } from './validate.js';
import { requireAuth, withOwnedKit } from '../auth/requireAuth.js';

/** The edits a client may make. A closed set; anything else is a 400. */
export const EDIT_OPS = Object.freeze([
  'edit-question',
  'delete-question',
  'add-question',
  'move-category',
  'reorder-day',
  'pin',
  'edit-brief',
]);

/** More than this in one request is a client bug, not a user action. */
const MAX_OPS = 100;

/**
 * Apply one operation to a kit draft. Pure: takes a draft, mutates it, returns a note.
 *
 * Mutation is deliberate here — the draft is a private clone made by the caller, and
 * threading an immutable update through seven operation types would add indirection
 * without adding safety.
 */
function applyOp(draft, op, stamp) {
  switch (op.type) {
    case 'edit-question': {
      const question = findQuestion(draft, op.id);
      if (typeof op.prompt === 'string') question.prompt = op.prompt.trim();
      if (typeof op.answer_outline === 'string') question.answer_outline = op.answer_outline.trim();
      if (Number.isInteger(op.difficulty)) question.difficulty = op.difficulty;

      Object.assign(question, markEdited(question, { updatedAt: stamp }));
      return `edited ${op.id}`;
    }

    case 'delete-question': {
      const index = draft.questions.findIndex((entry) => entry.id === op.id);
      if (index === -1) throw new ApiError('VALIDATION_FAILED', `No question with id "${op.id}".`);
      draft.questions.splice(index, 1);

      // Every schedule day referencing it must lose the reference, or the kit fails
      // validation the moment it is saved — a delete that breaks the kit is not a
      // delete a user would expect.
      for (const day of draft.schedule?.days ?? []) {
        day.question_ids = (day.question_ids ?? []).filter((id) => id !== op.id);
      }
      return `deleted ${op.id}`;
    }

    case 'add-question': {
      if (!QUESTION_CATEGORIES.includes(op.category)) {
        throw new ApiError('VALIDATION_FAILED', `category must be one of ${QUESTION_CATEGORIES.join(', ')}.`);
      }
      const requirementIds = Array.isArray(op.requirement_ids) ? op.requirement_ids : [];
      const known = new Set((draft.role?.requirements ?? []).map((entry) => entry.id));
      for (const id of requirementIds) {
        if (!known.has(id)) throw new ApiError('VALIDATION_FAILED', `No requirement with id "${id}".`);
      }

      const question = markManual(
        {
          id: nextIdFor('question', draft.questions),
          requirement_ids: requirementIds,
          category: op.category,
          prompt: String(op.prompt ?? '').trim(),
          answer_outline: String(op.answer_outline ?? '').trim(),
          difficulty: Number.isInteger(op.difficulty) ? op.difficulty : 2,
        },
        { updatedAt: stamp }
      );

      draft.questions.push(question);
      return `added ${question.id}`;
    }

    case 'move-category': {
      const question = findQuestion(draft, op.id);
      if (!QUESTION_CATEGORIES.includes(op.category)) {
        throw new ApiError('VALIDATION_FAILED', `category must be one of ${QUESTION_CATEGORIES.join(', ')}.`);
      }
      question.category = op.category;
      Object.assign(question, markEdited(question, { updatedAt: stamp }));
      return `moved ${op.id} to ${op.category}`;
    }

    case 'reorder-day': {
      const day = (draft.schedule?.days ?? []).find((entry) => entry.day === op.day);
      if (!day) throw new ApiError('VALIDATION_FAILED', `No day ${op.day} in the schedule.`);

      const ids = Array.isArray(op.question_ids) ? op.question_ids : [];
      const known = new Set(draft.questions.map((entry) => entry.id));
      for (const id of ids) {
        if (!known.has(id)) throw new ApiError('VALIDATION_FAILED', `No question with id "${id}".`);
      }

      day.question_ids = ids;
      // A hand-arranged day is pinned, so the next regeneration's fresh allocation does
      // not silently undo the arrangement the user just made.
      Object.assign(day, setPinned(markEdited(day, { updatedAt: stamp }), true, { updatedAt: stamp }));
      return `reordered day ${op.day}`;
    }

    case 'pin': {
      const question = findQuestion(draft, op.id);
      Object.assign(question, setPinned(question, op.pinned !== false, { updatedAt: stamp }));
      return `${op.pinned === false ? 'unpinned' : 'pinned'} ${op.id}`;
    }

    case 'edit-brief': {
      draft.company_brief = draft.company_brief ?? { summary: '', what_they_do: '', sources: [] };
      draft.company_brief.provenance = draft.company_brief.provenance ?? {};

      for (const field of ['summary', 'what_they_do']) {
        if (typeof op[field] !== 'string') continue;
        draft.company_brief[field] = op[field].trim();
        draft.company_brief.provenance[field] = markEdited(
          draft.company_brief.provenance[field] ?? { origin: ORIGINS.GENERATED },
          { updatedAt: stamp }
        );
      }
      return 'edited the brief';
    }

    default:
      throw new ApiError('VALIDATION_FAILED', `Unknown operation "${op.type}". Expected one of ${EDIT_OPS.join(', ')}.`);
  }
}

function findQuestion(draft, id) {
  const question = (draft.questions ?? []).find((entry) => entry.id === id);
  if (!question) throw new ApiError('VALIDATION_FAILED', `No question with id "${id}".`);
  return question;
}

/**
 * Mount the edit route.
 */
export function mountEditRoutes(app) {
  app.patch(
    '/api/kits/:id',
    requireAuth,
    withOwnedKit(),
    route(async (request, response) => {
      const kitDoc = request.kit;

      if (!kitDoc.kit) {
        throw new ApiError('KIT_NOT_READY', 'This kit has not finished building yet, so there is nothing to edit.');
      }

      const revision = validateRevision(request.body?.revision);
      const ops = request.body?.ops;

      if (!Array.isArray(ops) || ops.length === 0) {
        throw new ApiError('VALIDATION_FAILED', 'ops must be a non-empty array of edit operations.');
      }
      if (ops.length > MAX_OPS) {
        throw new ApiError('VALIDATION_FAILED', `ops may contain at most ${MAX_OPS} operations.`);
      }

      // Applied to a clone. If any operation fails, the caller's kit is untouched and
      // nothing partial is written — a half-applied reorder is worse than a rejection.
      const draft = structuredClone(kitDoc.kit);
      const stamp = new Date().toISOString();
      const applied = [];

      for (const op of ops) {
        applied.push(applyOp(draft, op, stamp));
      }

      // Coverage and the schedule are functions of the question set, which may have
      // just changed. Derived once, at the end, rather than after each operation.
      const recomputed = recomputeDerived(draft, { updatedAt: stamp });

      const validation = validateKit(recomputed);
      if (!validation.valid) {
        throw new ApiError(
          'VALIDATION_FAILED',
          `That edit would leave the kit invalid:\n${formatValidationErrors(validation.errors)}`,
          { details: { errors: validation.errors.slice(0, 10) } }
        );
      }

      // The revision is checked and the write applied in one operation. A stale
      // revision throws StaleRevisionError, which the error handler renders as a 409
      // carrying the current revision so the client can reapply rather than lose the
      // edit.
      const updated = await request.store.kits.writeWithRevision({
        kitId: String(kitDoc.id ?? kitDoc._id),
        expectedRevision: revision,
        set: { kit: recomputed },
      });

      response.json({
        id: String(updated.id ?? updated._id),
        revision: updated.revision,
        applied,
        kit: updated.kit,
      });
    })
  );

  return app;
}
