/**
 * useKitEditor.js — edit a kit optimistically, without losing a keystroke.
 *
 * Decides: WHEN edits are sent — after typing pauses, when a delete's undo window closes,
 * one request at a time, and never later than the moment the page is left.
 *
 * Does NOT decide: how edits merge, hold, roll back or render. That is `editQueue.js`,
 * which is pure and tested on its own; this hook only supplies the timer, the network
 * call and React state around it.
 *
 * A PENDING EDIT IS NEVER SILENTLY DROPPED. Leaving the page, or navigating away inside
 * the app, releases every hold and flushes whatever is waiting instead of discarding it.
 * A debounce that loses the last sentence someone typed, or an undo window that swallows
 * a delete they confirmed, teaches people not to trust the editor.
 *
 * ONE TIMER, SET FOR WHICHEVER IS SOONER: typing's pause, or the earliest undo window
 * closing. Two timers would race each other into two requests; one timer at the minimum
 * sends everything that is ready in one.
 *
 * FAILURES ARE REPORTED, NOT SWALLOWED. `onError` receives the error and the operations
 * that were rolled back, and the builder shows it. A cancelled request is the one
 * exception, because that is a request this app chose to abandon.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { kits } from '../lib/api.js';
import { isCancelled } from '../lib/apiError.js';
import { currentValue } from '../kits/localOps.js';
import {
  DEBOUNCE_MS,
  UNDO_WINDOW_MS,
  cancel,
  confirm,
  createEditState,
  enqueue,
  fail,
  isHeld,
  nextReleaseAt,
  opKey,
  pendingKeys,
  releaseAll,
  takeBatch,
  toServerOp,
  viewOf,
} from '../kits/editQueue.js';

export function useKitEditor(kitId, initialKit, { onError } = {}) {
  const [state, setState] = useState(() => createEditState(initialKit));

  // The latest state, readable from timers and async callbacks without a stale closure.
  const stateRef = useRef(state);
  const set = useCallback((next) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const timer = useRef(null);
  const sending = useRef(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Callers awaiting an add, by temporary id. Settled when the request carrying that add
  // lands — resolved on success, rejected on failure — so a form knows whether to close.
  const waiters = useRef(new Map());
  const addCounter = useRef(0);

  const settleWaiters = (batch, outcome, value) => {
    for (const op of batch) {
      if (!op.tempId) continue;
      const waiter = waiters.current.get(op.tempId);
      if (!waiter) continue;
      waiters.current.delete(op.tempId);
      waiter[outcome](value);
    }
  };

  const flushRef = useRef(async () => {});

  /**
   * Arm the one timer for whatever is due soonest: the typing pause if anything ready is
   * waiting, or the earliest undo window closing.
   */
  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;

    const now = Date.now();
    const current = stateRef.current;
    const readyWaiting = current.queued.some((op) => !isHeld(op, now));
    const release = nextReleaseAt(current, now);

    let delay = readyWaiting ? DEBOUNCE_MS : null;
    if (release !== null) {
      const untilRelease = Math.max(0, release - now);
      delay = delay === null ? untilRelease : Math.min(delay, untilRelease);
    }
    if (delay !== null) timer.current = setTimeout(() => flushRef.current(), delay);
  }, []);

  // A different kit on the same component instance starts from that kit's data. Edits
  // belonging to the previous kit were flushed by the leave-handling cleanup below.
  const seenKitId = useRef(kitId);
  useEffect(() => {
    if (seenKitId.current === kitId) return;
    seenKitId.current = kitId;
    clearTimeout(timer.current);
    timer.current = null;
    set(createEditState(initialKit));
  }, [kitId, initialKit, set]);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    timer.current = null;
    if (sending.current) return; // the in-flight request reschedules on landing

    const { state: next, batch } = takeBatch(stateRef.current, Date.now());
    if (batch.length === 0) {
      if (next !== stateRef.current) set(next);
      schedule(); // held deletes still need their window to close
      return;
    }

    set(next);
    sending.current = true;

    try {
      const response = await kits.edit(kitId, batch.map(toServerOp));
      set(confirm(stateRef.current, response.kit));
      settleWaiters(batch, 'resolve', response.kit);
    } catch (error) {
      set(fail(stateRef.current));
      settleWaiters(batch, 'reject', error);
      if (!isCancelled(error)) onErrorRef.current?.(error, batch);
    } finally {
      sending.current = false;
      // Anything typed, or held, while that request was out goes next.
      if (stateRef.current.queued.length > 0) schedule();
    }
  }, [kitId, set, schedule]);

  flushRef.current = flush;

  /** Record an edit. The screen updates now; the request waits for typing to pause. */
  const edit = useCallback(
    (op) => {
      set(enqueue(stateRef.current, op));
      schedule();
    },
    [set, schedule]
  );

  /**
   * Add a question or a flashcard. Resolves with the server's kit once it is saved;
   * rejects if the save fails, which the editor has already reported.
   *
   * SENT AT ONCE, NOT AFTER THE DEBOUNCE. The debounce exists to merge keystrokes into
   * one edit. An add is one deliberate action with nothing to merge, and until it lands
   * the new row is read-only — so every millisecond of delay is a millisecond the person
   * cannot touch what they just made. Anything already waiting and ready goes out with
   * it, which only ever sends an edit sooner.
   */
  const add = useCallback(
    (op) =>
      new Promise((resolve, reject) => {
        addCounter.current += 1;
        const tempId = op.tempId ?? `pending-${addCounter.current}`;
        waiters.current.set(tempId, { resolve, reject });
        set(enqueue(stateRef.current, { ...op, tempId }));
        flushRef.current();
      }),
    [set]
  );

  /**
   * Delete a question or a flashcard — after a delay during which it can be undone.
   * Nothing is sent until the window closes; see "a delete is held" in `editQueue.js`.
   */
  const remove = useCallback(
    (op) => {
      set(enqueue(stateRef.current, { ...op, holdUntil: Date.now() + UNDO_WINDOW_MS }));
      schedule();
    },
    [set, schedule]
  );

  /**
   * Undo a delete that has not been sent. Returns false if it already has — at that point
   * the item is gone on the server, and pretending otherwise would be the worse outcome.
   */
  const undoRemove = useCallback(
    (op) => {
      const key = opKey(op);
      if (!stateRef.current.queued.some((entry) => opKey(entry) === key)) return false;
      set(cancel(stateRef.current, key));
      schedule();
      return true;
    },
    [set, schedule]
  );

  /**
   * Put a field back to how it was when editing began.
   *
   * If nothing for that field has left the browser, the waiting edit is simply dropped —
   * no request, and no `edited` mark for a change that never happened. If an earlier edit
   * in this session already reached the server, restoring is a real edit and is sent as
   * one.
   */
  const revert = useCallback(
    (op, originalValue) => {
      const key = opKey(op);
      const inflight = stateRef.current.inflight.some((entry) => opKey(entry) === key);

      if (!inflight) {
        set(cancel(stateRef.current, key));
        const confirmed = currentValue(stateRef.current.base, op);
        if (confirmed === undefined || String(confirmed) === String(originalValue)) return;
      }
      edit({ ...op, value: originalValue });
    },
    [set, edit]
  );

  // Never lose a waiting edit or a confirmed delete: when the page is hidden, or the
  // builder goes, every hold ends and everything waiting is sent.
  useEffect(() => {
    const leave = () => {
      set(releaseAll(stateRef.current));
      flushRef.current();
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [set]);

  const kit = useMemo(() => viewOf(state), [state]);
  const keys = useMemo(() => pendingKeys(state), [state]);

  const statusOf = useCallback(
    (op) => {
      const key = opKey(op);
      if (keys.saving.has(key)) return 'saving';
      if (keys.queued.has(key)) return 'queued';
      return null;
    },
    [keys]
  );

  return { kit, edit, add, remove, undoRemove, revert, statusOf, flush: () => flushRef.current() };
}
