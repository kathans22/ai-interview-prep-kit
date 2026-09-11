/**
 * undo.js — snapshot a section before a regeneration replaces it, and put it back.
 *
 * Decides: what is captured before a merge, and what restoring does.
 *
 * Does NOT decide: when to regenerate, or how the merge works (`@aipk/core/contracts/
 * merge.js`). The snapshot is taken by whoever is about to call merge, immediately
 * before doing so, so the captured state is exactly the state the merge is about to
 * change.
 *
 * ONE STEP, NOT A HISTORY, AND THAT IS DELIBERATE. `previousSections` holds at most one
 * snapshot per section. An unbounded history would grow a kit document without limit to
 * answer a question nobody asked — the brief asks to undo *a regeneration*, which is a
 * single step backwards taken within seconds of the mistake. Anyone wanting five steps
 * back wants version control, which is a different product.
 *
 * THE SNAPSHOT MUST BE TAKEN BEFORE THE MERGE, NOT AFTER. Obvious, and easy to get wrong
 * in a route that regenerates first and tidies up afterwards. `snapshotBeforeMerge`
 * exists so the ordering is one function call rather than a convention someone has to
 * remember at each call site.
 *
 * UNDO IS ITSELF A WRITE. It bumps the revision like any other, because after an undo
 * every client's view is stale — including the one that asked for it. An undo that
 * silently left the revision alone would let a third party's stale edit land on top.
 */

import { writeWithRevision } from './revisions.js';

/** Sections that can be snapshotted and restored. Mirrors the merge module's list. */
export const UNDOABLE_SECTIONS = Object.freeze(['company_brief', 'questions', 'flashcards', 'schedule']);

/**
 * What a snapshot of each section contains.
 *
 * Questions and the schedule are captured TOGETHER even when only questions are being
 * regenerated: merging questions recomputes the schedule, so restoring the questions
 * without the schedule they belonged to would leave a kit whose days reference a
 * question set that no longer exists. The two are one unit of undo because they are one
 * unit of change.
 */
export function captureSection(kit, section) {
  if (!kit || typeof kit !== 'object') return null;

  switch (section) {
    case 'company_brief':
      return { company_brief: structuredClone(kit.company_brief ?? null) };

    case 'questions':
      return {
        questions: structuredClone(kit.questions ?? []),
        // Recomputed by the merge, so it has to come back with them.
        schedule: structuredClone(kit.schedule ?? null),
        coverage: structuredClone(kit.coverage ?? null),
      };

    case 'flashcards':
      return { flashcards: structuredClone(kit.flashcards ?? []) };

    case 'schedule':
      return { schedule: structuredClone(kit.schedule ?? null) };

    default:
      return null;
  }
}

/**
 * Take the snapshot and write it, before any regeneration runs.
 *
 * @param {object} options
 * @param {import('mongoose').Model} options.model
 * @param {string} options.kitId
 * @param {number} options.expectedRevision
 * @param {object} options.kit the kit as it stands now
 * @param {string} options.section
 * @returns {Promise<object>} the updated document
 */
export async function snapshotBeforeMerge({ model, kitId, expectedRevision, kit, section, now }) {
  if (!UNDOABLE_SECTIONS.includes(section)) {
    const error = new Error(`UNDO_UNKNOWN_SECTION: "${section}" cannot be snapshotted.`);
    error.code = 'UNDO_UNKNOWN_SECTION';
    throw error;
  }

  const snapshot = captureSection(kit, section);

  return writeWithRevision({
    model,
    kitId,
    expectedRevision,
    set: { [`previousSections.${section}`]: snapshot },
    now,
  });
}

/**
 * Restore the snapshot for one section.
 *
 * The snapshot is CLEARED as it is applied. Undo is one step: leaving it in place would
 * make a second undo look available while doing nothing, or — worse — undo a later,
 * unrelated regeneration back to a state from ten minutes ago.
 *
 * @returns {Promise<{ document: object, restored: string[] }>}
 * @throws when there is nothing to undo, which is a different answer from a failure
 */
export async function undoSection({ model, kitId, expectedRevision, section, now }) {
  if (!UNDOABLE_SECTIONS.includes(section)) {
    const error = new Error(`UNDO_UNKNOWN_SECTION: "${section}" cannot be undone.`);
    error.code = 'UNDO_UNKNOWN_SECTION';
    throw error;
  }

  const current = await model.findById(kitId).lean();
  if (!current) {
    const error = new Error(`Kit ${kitId} does not exist.`);
    error.code = 'KIT_NOT_FOUND';
    throw error;
  }

  const snapshot = current.previousSections?.[section];
  if (!snapshot) {
    const error = new Error(
      `There is nothing to undo for "${section}" — no regeneration has replaced it since the last undo.`
    );
    error.code = 'NOTHING_TO_UNDO';
    error.section = section;
    throw error;
  }

  // Write the captured fields back into the kit, and clear the snapshot in the same
  // operation so a second undo cannot replay it.
  const set = { [`previousSections.${section}`]: null };
  for (const [field, value] of Object.entries(snapshot)) {
    set[`kit.${field}`] = value;
  }

  const document = await writeWithRevision({ model, kitId, expectedRevision, set, now });

  return { document, restored: Object.keys(snapshot) };
}

/** Which sections currently have something to undo. */
export function undoableSections(kitDocument) {
  return UNDOABLE_SECTIONS.filter((section) => Boolean(kitDocument?.previousSections?.[section]));
}
