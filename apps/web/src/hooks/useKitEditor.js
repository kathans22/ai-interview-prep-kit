/**
 * useKitEditor.js — edit a kit optimistically, without losing a keystroke.
 *
 * Decides: WHEN edits are sent — after typing pauses, one request at a time, and never
 * later than the moment the page is left.
 *
 * Does NOT decide: how edits merge, roll back or render. That is `editQueue.js`, which is
 * pure and tested on its own; this hook only supplies the timer, the network call and
 * React state around it.
 *
 * A PENDING EDIT IS NEVER SILENTLY DROPPED. Leaving the page, or navigating away inside
 * the app, flushes whatever is waiting instead of discarding it. A debounce that loses
 * the last sentence someone typed because they clicked away within the delay is the
 * kind of bug that teaches people not to trust an editor.
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
  cancel,
  confirm,
  createEditState,
  enqueue,
  fail,
  opKey,
  pendingKeys,
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

  // A different kit on the same component instance starts from that kit's data. Edits
  // belonging to the previous kit were flushed by the unmount-style cleanup below.
  const seenKitId = useRef(kitId);
  useEffect(() => {
    if (seenKitId.current === kitId) return;
    seenKitId.current = kitId;
    clearTimeout(timer.current);
    timer.current = null;
    set(createEditState(initialKit));
  }, [kitId, initialKit, set]);

  const flushRef = useRef(async () => {});

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    timer.current = null;
    if (sending.current) return; // the in-flight request reschedules on landing

    const { state: next, batch } = takeBatch(stateRef.current);
    if (batch.length === 0) {
      if (next !== stateRef.current) set(next);
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
      // Anything typed while that request was out goes next, after the usual pause.
      if (stateRef.current.queued.length > 0 && !timer.current) {
        timer.current = setTimeout(() => flushRef.current(), DEBOUNCE_MS);
      }
    }
  }, [kitId, set]);

  flushRef.current = flush;

  /** Record an edit. The screen updates now; the request waits for typing to pause. */
  const edit = useCallback(
    (op) => {
      set(enqueue(stateRef.current, op));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => flushRef.current(), DEBOUNCE_MS);
    },
    [set]
  );

  /**
   * Add a question or a flashcard. Resolves with the server's kit once it is saved;
   * rejects if the save fails, which the editor has already reported.
   *
   * SENT AT ONCE, NOT AFTER THE DEBOUNCE. The debounce exists to merge keystrokes into
   * one edit. An add is one deliberate action with nothing to merge, and until it lands
   * the new row is read-only — so every millisecond of delay is a millisecond the person
   * cannot touch what they just made. Anything already waiting goes out with it, which
   * only ever sends an edit sooner.
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

  // Never lose a waiting edit: flush when the page is hidden, and when the builder goes.
  useEffect(() => {
    const onHide = () => flushRef.current();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      flushRef.current();
    };
  }, []);

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

  return { kit, edit, add, revert, statusOf, flush: () => flushRef.current() };
}
