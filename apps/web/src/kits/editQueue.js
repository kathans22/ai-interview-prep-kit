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

import { EDIT_FIELDS, applyLocalOps, currentValue } from './localOps.js';

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
 * Held operations stay queued until their window closes; the rest go, minus any that
 * would change nothing against the confirmed kit.
 */
export function takeBatch(state, now = Date.now()) {
  if (state.inflight.length > 0) return { state, batch: [] };
  const held = state.queued.filter((op) => isHeld(op, now));
  const batch = state.queued.filter((op) => !isHeld(op, now) && !isNoop(op, state.base));
  return { state: { ...state, inflight: batch, queued: held }, batch };
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
