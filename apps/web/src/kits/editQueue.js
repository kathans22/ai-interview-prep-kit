/**
 * editQueue.js — the edits a person has made that the server has not yet confirmed.
 *
 * Decides: how edits wait, merge and leave. Which of them go in the next request, which
 * are dropped as no-ops, which are still being HELD so they can be undone, and what the
 * screen shows while some are in flight.
 *
 * Does NOT decide: when a request is sent (`useKitEditor` owns the timer) or what the
 * server does with it. Every function here is pure and takes the whole state, so the
 * hard part of optimistic editing — never losing or double-applying a keystroke — is
 * testable without a browser, a timer or a network.
 *
 * THE MODEL IS THREE LISTS:
 *   base      the last kit the server confirmed. Truth.
 *   inflight  operations in the request that is on the wire right now.
 *   queued    operations made since, waiting for the debounce or for their hold to end.
 * What the screen shows is `base` with `inflight` then `queued` applied on top.
 *
 * WHY THIS SHAPE, AND NOT "UPDATE THE KIT AND SEND A COPY". Three properties fall out of
 * it that the brief requires and that a mutable local kit makes hard:
 *   - Typing never round-trips per keystroke. Edits to the same field MERGE while they
 *     wait, so thirty keystrokes become one operation carrying the final text.
 *   - Typing is never lost to a response. When a request confirms, `base` becomes the
 *     server's kit and whatever was typed AFTER the request left is still in `queued`,
 *     still drawn on top — the server's older copy of that field cannot overwrite it.
 *   - Failure rolls back exactly what failed. A rejected request drops `inflight` and
 *     nothing else, so an edit made after it survives the rollback of the one before.
 *
 * A DELETE IS HELD, NOT SENT. The server has no undo for a deleted question — once the
 * operation lands, the question and every schedule reference to it are gone. So "undoable
 * for a few seconds" cannot be a request to put it back; it has to be a request that has
 * not been made yet. A delete carries `holdUntil`, `takeBatch` leaves it queued until
 * that moment passes, and undo is simply removing it from the queue. Nothing reached the
 * server, so there is nothing to reverse.
 *
 * ONE REQUEST AT A TIME. A second request sent while the first is in flight would carry
 * a revision the first is about to invalidate, and one of the two would come back 409 for
 * no reason a person caused. So `takeBatch` refuses while anything is in flight, and the
 * next batch goes when the current one lands.
 */

import { EDIT_FIELDS, applyLocalOps, currentValue, orderCategory } from './localOps.js';

/** How long typing must pause before an edit is sent. */
export const DEBOUNCE_MS = 800;

/** How long a delete can still be undone. "A few seconds", per the brief. */
export const UNDO_WINDOW_MS = 6000;

const DELETE_TYPES = Object.freeze(['delete-question', 'delete-flashcard']);

/**
 * The identity two operations share when the later one should REPLACE the earlier, and
 * the handle undo and status look an operation up by. Field edits key on the field;
 * deletes key on the item. Anything else — an add — has no key and keeps its own place.
 */
export function opKey(op) {
  if (EDIT_FIELDS[op?.type]) return `${op.type}:${op.id ?? 'brief'}:${op.field}`;
  if (DELETE_TYPES.includes(op?.type)) return `${op.type}:${op.id}`;
  return null;
}

export function createEditState(base) {
  return { base, inflight: [], queued: [] };
}

/** Add an operation, replacing a waiting operation with the same key in place. */
export function enqueue(state, op) {
  const key = opKey(op);
  if (key) {
    const index = state.queued.findIndex((entry) => opKey(entry) === key);
    if (index !== -1) {
      const queued = [...state.queued];
      queued[index] = op;
      return { ...state, queued };
    }
  }
  return { ...state, queued: [...state.queued, op] };
}

/**
 * Would sending this change nothing?
 *
 * Compared TRIMMED, because the server stores trimmed text: a trailing space typed and
 * then deleted, or typed and left, is not an edit. Sending it anyway would still mark a
 * generated item `edited` — protecting it from regeneration for a change nobody made.
 */
export function isNoop(op, kit) {
  if (!EDIT_FIELDS[op?.type]) return false;
  const value = currentValue(kit, op);
  // A target that no longer exists is NOT a no-op: the server must say it is gone.
  if (value === undefined) return false;
  return String(value ?? '').trim() === String(op.value ?? '').trim();
}

/** Is this operation still inside its undo window? */
export function isHeld(op, now) {
  return typeof op?.holdUntil === 'number' && op.holdUntil > now;
}

/**
 * Move waiting operations onto the wire.
 *
 * Returns an empty batch while a request is in flight (see "one request at a time").
 * Held operations stay queued until their window closes; the rest go in the order they
 * were made, minus any that would change nothing against the confirmed kit.
 *
 * A REORDER NEVER RIDES BEHIND AN ADD. A reorder names every question in its category,
 * and the server refuses a list that is not exactly complete. A question being added has
 * no real id until its request returns, so a reorder in the same request could never
 * name it. The batch is cut before such a reorder, which goes next — against a kit that
 * has the new question under its real id.
 */
export function takeBatch(state, now = Date.now()) {
  if (state.inflight.length > 0) return { state, batch: [] };

  const ready = [];
  const kept = [];
  let addSeen = false;
  let cut = false;

  for (const op of state.queued) {
    if (isHeld(op, now)) {
      kept.push(op);
      continue;
    }
    if (op.type === 'reorder-questions' && addSeen) cut = true;
    if (cut) {
      kept.push(op);
      continue;
    }
    if (op.type === 'add-question') addSeen = true;
    ready.push(op);
  }

  const batch = resolveOrder(
    state.base,
    ready.filter((op) => !isNoop(op, state.base))
  );
  return { state: { ...state, inflight: batch, queued: kept }, batch };
}

/**
 * Rebuild each reorder's id list against the kit as it will stand when the server reaches
 * that operation.
 *
 * A reorder is computed from what the screen showed at the moment of the drop. By the
 * time it is sent, the confirmed kit may have moved on — an add has landed with a real
 * id — and an earlier operation in the same request may delete a question, move one out
 * of the category or move one in. The server would refuse the stale list. Walking the
 * batch over a copy of the confirmed questions gives every reorder its category exactly
 * as it will be, keeping the person's order for each question they arranged and the
 * existing order for the rest.
 */
export function resolveOrder(base, ops) {
  if (!ops.some((op) => op.type === 'reorder-questions')) return ops;

  let questions = (Array.isArray(base?.questions) ? base.questions : []).map((question) => ({
    id: question.id,
    category: question.category,
  }));

  return ops.map((op) => {
    switch (op.type) {
      case 'delete-question':
        questions = questions.filter((question) => question.id !== op.id);
        return op;
      case 'move-category':
        questions = questions.map((question) => (question.id === op.id ? { ...question, category: op.category } : question));
        return op;
      case 'reorder-questions': {
        questions = orderCategory(questions, op.category, op.question_ids);
        const questionIds = questions.filter((question) => question.category === op.category).map((question) => question.id);
        return { ...op, question_ids: questionIds };
      }
      default:
        return op;
    }
  });
}

/** The earliest moment a held operation becomes sendable, or null if none is held. */
export function nextReleaseAt(state, now = Date.now()) {
  const times = state.queued.filter((op) => isHeld(op, now)).map((op) => op.holdUntil);
  return times.length === 0 ? null : Math.min(...times);
}

/**
 * End every hold at once. Used when the page is being left: an undo window that outlives
 * the page would silently turn "I deleted this" into "nothing happened".
 */
export function releaseAll(state) {
  return {
    ...state,
    queued: state.queued.map((op) => {
      if (typeof op.holdUntil !== 'number') return op;
      const { holdUntil, ...rest } = op;
      return rest;
    }),
  };
}

/** The request succeeded. The server's kit becomes the base; later typing stays on top. */
export function confirm(state, serverKit) {
  return { base: serverKit ?? state.base, inflight: [], queued: state.queued };
}

/** The request failed. Roll back what was on the wire, and only that. */
export function fail(state) {
  return { base: state.base, inflight: [], queued: state.queued };
}

/** Drop a waiting operation by key — Escape on an unsent edit, or undo on a held delete. */
export function cancel(state, key) {
  return { ...state, queued: state.queued.filter((op) => opKey(op) !== key) };
}

/** What the screen shows. */
export function viewOf(state) {
  return applyLocalOps(state.base, [...state.inflight, ...state.queued]);
}

/** Which operations are saving right now, and which are still waiting. */
export function pendingKeys(state) {
  return {
    saving: new Set(state.inflight.map(opKey).filter(Boolean)),
    queued: new Set(state.queued.map(opKey).filter(Boolean)),
  };
}

/**
 * The operation as the server's edit route expects it.
 *
 * Client-only fields are stripped here: an add's temporary id, which exists so the
 * preview can draw a stable row, and a delete's hold time, which exists so it can be
 * undone. Neither means anything to the server.
 */
export function toServerOp(op) {
  if (op.type === 'edit-brief') return { type: 'edit-brief', [op.field]: op.value };
  if (EDIT_FIELDS[op.type]) return { type: op.type, id: op.id, [op.field]: op.value };
  if (op.type === 'add-question' || op.type === 'add-flashcard') {
    const { tempId, ...rest } = op;
    return rest;
  }
  if (DELETE_TYPES.includes(op.type)) return { type: op.type, id: op.id };
  return op;
}
