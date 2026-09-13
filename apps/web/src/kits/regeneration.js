/**
 * regeneration.js — what regenerating a section will do, and what it did.
 *
 * Decides: the regeneration targets the builder offers and how each is named; the
 * plain-language preview shown before one runs — what will be replaced, what will be
 * kept, and why; and the summary and highlight shown after — what changed.
 *
 * Does NOT decide: what is replaced. The server's merge decides that, by core's
 * `isReplaceable`. The preview mirrors that one rule for display, and a test holds the
 * mirror to core's own function, so the dialog cannot promise to keep something the
 * merge will overwrite without a test failing first.
 *
 * THE PREVIEW IS COMPUTED FROM THE KIT ON SCREEN, NOT ASKED OF THE SERVER. A preview
 * endpoint would be a round trip whose answer is a pure function of data the client
 * already holds. And a regeneration only starts after every pending edit is saved, so the
 * provenance the preview reads is the provenance the merge will see.
 *
 * THE SUMMARY COMES FROM THE SERVER'S REPORT, NOT FROM A DIFF. The report says what the
 * merge actually did. A diff would guess, and would call a replacement that happened to
 * come back with identical text "unchanged". The schedule is the exception: it is
 * recomputed rather than merged, its report is always empty, and so its changes are found
 * by comparing days.
 */

import { CATEGORY_LABELS } from './kitView.js';

/** The brief's two text fields, in the order the brief shows them. Mirrors core's BRIEF_FIELDS. */
export const BRIEF_FIELD_LABELS = Object.freeze({ summary: 'Summary', what_they_do: 'What they do' });

/** One key per target: a section, or a section and a category. */
export function targetKey(target) {
  return target?.section === 'questions' ? `questions:${target.category}` : String(target?.section ?? '');
}

/** How a target is named in controls, dialogs and announcements. */
export function describeTarget(target) {
  switch (target?.section) {
    case 'company_brief':
      return { title: 'the company brief', action: 'Regenerate the company brief', running: 'Regenerating the company brief…' };
    case 'questions': {
      const label = CATEGORY_LABELS[target.category] ?? String(target.category);
      return {
        title: `the ${label.toLowerCase()} questions`,
        action: `Regenerate ${label} questions`,
        running: `Regenerating the ${label.toLowerCase()} questions…`,
      };
    }
    case 'schedule':
      return { title: 'the schedule', action: 'Rebuild the schedule', running: 'Rebuilding the schedule…' };
    default:
      return { title: 'this section', action: 'Regenerate', running: 'Regenerating…' };
  }
}

/**
 * Mirror of core's `isReplaceable`: only an item nobody has written, changed or pinned is
 * replaced. An item with no provenance, or one this client does not recognise, counts as
 * generated — no person has claimed it.
 */
export function willBeReplaced(item) {
  if (!item || typeof item !== 'object') return true;
  if (item.pinned === true) return false;
  return item.origin !== 'edited' && item.origin !== 'manual';
}

function keptBecause(item) {
  const reasons = [];
  if (item?.origin === 'manual') reasons.push('added by you');
  else if (item?.origin === 'edited') reasons.push('edited');
  if (item?.pinned === true) reasons.push('pinned');
  return reasons;
}

function split(items, reasonFor = keptBecause) {
  const replaced = [];
  const kept = [];
  for (const item of items) {
    const entry = { id: item.id, label: item.label ?? item.id };
    if (willBeReplaced(item)) replaced.push(entry);
    else kept.push({ ...entry, because: reasonFor(item) });
  }
  return { replaced, kept };
}

/**
 * What a regeneration of `target` will replace and keep, read from the kit as shown.
 *
 * A question still being added is left out — it will be saved before the regeneration
 * starts, and saved as `manual`, so it is kept. A question awaiting its undo window is
 * left out too: its delete is sent before the regeneration starts.
 */
export function previewRegeneration(kit, target) {
  switch (target?.section) {
    case 'questions':
      return split(
        (Array.isArray(kit?.questions) ? kit.questions : []).filter(
          (question) => question && question.category === target.category && !question.pendingAdd && !question.pendingDelete
        )
      );

    case 'company_brief': {
      const provenance = kit?.company_brief?.provenance ?? {};
      return split(
        Object.entries(BRIEF_FIELD_LABELS).map(([field, label]) => ({ ...(provenance[field] ?? {}), id: field, label }))
      );
    }

    case 'schedule':
      return split(
        (Array.isArray(kit?.schedule?.days) ? kit.schedule.days : []).map((day) => ({ ...day, id: `day-${day.day}`, label: `Day ${day.day}` })),
        () => ['arranged by you']
      );

    default:
      return { replaced: [], kept: [] };
  }
}

const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

function listWords(words) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

const sameDay = (a, b) =>
  JSON.stringify([a?.question_ids ?? [], a?.minutes ?? null, a?.focus ?? null]) ===
  JSON.stringify([b?.question_ids ?? [], b?.minutes ?? null, b?.focus ?? null]);

/**
 * What a finished regeneration did, as one sentence and the ids to highlight.
 *
 * @returns {{ text: string, changed: Set<string>, added: Set<string> }}
 *   `changed` holds question or flashcard ids, brief field names, or day numbers as
 *   strings; `added` the subset that did not exist before.
 */
export function summariseRegeneration({ target, report, before, after }) {
  if (target?.section === 'schedule') {
    const previous = new Map((before?.schedule?.days ?? []).map((day) => [day.day, day]));
    const changed = [];
    const kept = [];
    for (const day of after?.schedule?.days ?? []) {
      if (!willBeReplaced(day)) kept.push(day.day);
      else if (!sameDay(previous.get(day.day), day)) changed.push(day.day);
    }

    const parts = [
      changed.length === 0
        ? 'The schedule came out the same'
        : `${changed.length === 1 ? 'Day' : 'Days'} ${listWords(changed.map(String))} changed`,
    ];
    if (kept.length > 0) {
      parts.push(`${kept.length === 1 ? 'day' : 'days'} ${listWords(kept.map(String))} kept because you arranged ${kept.length === 1 ? 'it' : 'them'}`);
    }
    return { text: `${parts.join('; ')}.`, changed: new Set(changed.map(String)), added: new Set() };
  }

  const replaced = Array.isArray(report?.replaced) ? report.replaced : [];
  const kept = Array.isArray(report?.kept) ? report.kept : [];
  const added = Array.isArray(report?.added) ? report.added : [];
  const removed = Array.isArray(report?.removed) ? report.removed : [];

  if (target?.section === 'company_brief') {
    const label = (field) => BRIEF_FIELD_LABELS[field] ?? field;
    const parts = [replaced.length > 0 ? `${listWords(replaced.map(label))} rewritten` : 'Nothing was rewritten'];
    if (kept.length > 0) {
      parts.push(`${listWords(kept.map(label))} kept because you changed or pinned ${kept.length === 1 ? 'it' : 'them'}`);
    }
    return { text: `${parts.join('; ')}.`, changed: new Set(replaced), added: new Set() };
  }

  const noun = target?.section === 'flashcards' ? 'flashcard' : 'question';
  const parts = [replaced.length > 0 ? `${count(replaced.length, noun)} replaced` : `No ${noun}s replaced`];
  if (kept.length > 0) parts.push(`${kept.length} kept because you changed or pinned ${kept.length === 1 ? 'it' : 'them'}`);
  if (added.length > 0) parts.push(`${added.length} new`);
  if (removed.length > 0) {
    parts.push(`${listWords(removed)} removed because nothing came back to replace ${removed.length === 1 ? 'it' : 'them'}`);
  }
  const highlighted = replaced.length + added.length > 0 ? ' The new ones are highlighted.' : '';
  return { text: `${parts.join(', ')}.${highlighted}`, changed: new Set([...replaced, ...added]), added: new Set(added) };
}
