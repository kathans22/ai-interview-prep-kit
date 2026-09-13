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
 *
 * A 409 IS NOT A FAILURE TO REPORT, IT IS A RACE TO RESOLVE. Another tab or device saved
 * first. The conflict response carries the kit as it now stands, so the editor rebases —
 * that kit becomes the base, this person's unconfirmed operations go back on top — sends
 * again at once, and tells them quietly. Only if the kit keeps moving under three
 * rebases in a row does it give up, roll back and say so, rather than loop.
 *
 * SOME WRITES MUST NOT SHARE THE WIRE WITH EDITS. A regeneration moves the same revision
 * an edit does, so `exclusive` saves everything pending, stops sending while its task
 * runs — edits keep drawing on screen and wait — adopts the kit the task returns as the
 * new base, and then sends what waited. The one gap: an edit made during that task is
 * not sent if the page is closed before the task returns, because sending it then would
 * only earn a 409.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { kits } from '../lib/api.js';
import { isCancelled, isStaleRevision } from '../lib/apiError.js';
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
  rebase,
  releaseAll,
  takeBatch,
  toServerOp,
  viewOf,
} from '../kits/editQueue.js';

/** Rebases in a row before a conflict is treated as a failure. */
const MAX_REBASES = 3;

export function useKitEditor(kitId, initialKit, { onError, onRebase } = {}) {
  const [state, setState] = useState(() => createEditState(initialKit));

  // The latest state, readable from timers and async callbacks without a stale closure.
  const stateRef = useRef(state);
  const set = useCallback((next) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const timer = useRef(null);
  const sending = useRef(false);
  // Resolves when the request currently on the wire lands, so `settle` can wait for it.
  const landed = useRef(Promise.resolve());
  // How many saves have failed, so `settle` can tell whether the ones it waited for did.
  const failures = useRef(0);
  // Set while an exclusive task runs: nothing is sent.
  const exclusiveRef = useRef(false);
  const claimed = useRef(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onRebaseRef = useRef(onRebase);
  onRebaseRef.current = onRebase;
  const rebasesInARow = useRef(0);

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
    if (exclusiveRef.current) return; // the exclusive task sends what waited when it ends

    const { state: next, batch } = takeBatch(stateRef.current, Date.now());
    if (batch.length === 0) {
      if (next !== stateRef.current) set(next);
      schedule(); // held deletes still need their window to close
      return;
    }

    set(next);
    sending.current = true;
    let markLanded;
    landed.current = new Promise((resolve) => {
      markLanded = resolve;
    });

    let resend = false;

    try {
      const response = await kits.edit(kitId, batch.map(toServerOp));
      rebasesInARow.current = 0;
      set(confirm(stateRef.current, response.kit));
      settleWaiters(batch, 'resolve', response.kit);
    } catch (error) {
      if (isStaleRevision(error) && error.kit && rebasesInARow.current < MAX_REBASES) {
        // Someone else saved first. Their kit becomes the base; this person's work goes
        // back on top and is sent again straight away. The ledger already holds the new
        // revision — `api.js` recorded it from the 409.
        rebasesInARow.current += 1;
        const { state: rebased, dropped } = rebase(stateRef.current, error.kit);
        set(rebased);
        onRebaseRef.current?.({ dropped });
        resend = true;
      } else {
        rebasesInARow.current = 0;
        failures.current += 1;
        set(fail(stateRef.current));
        settleWaiters(batch, 'reject', error);
        if (!isCancelled(error)) onErrorRef.current?.(error, batch);
      }
    } finally {
      sending.current = false;
      markLanded();
      if (resend) flushRef.current();
      // Anything typed, or held, while that request was out goes next.
      else if (stateRef.current.queued.length > 0) schedule();
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
   * Rearrange questions: the operations one drop produces, drawn now and sent at once.
   *
   * Not debounced, for the same reason as an add — there is nothing to merge — and
   * because an arrangement left waiting is one another tab has longer to make stale.
   */
  const arrange = useCallback(
    (ops) => {
      if (!Array.isArray(ops) || ops.length === 0) return;
      let next = stateRef.current;
      for (const op of ops) next = enqueue(next, op);
      set(next);
      flushRef.current();
    },
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

  /**
   * Save everything pending — ending every undo window, since what follows needs a kit
   * that has stopped moving — and resolve once nothing is waiting or on the wire.
   * Rejects if any of it failed; the editor has already reported the failure itself.
   */
  const settle = useCallback(async () => {
    const failuresBefore = failures.current;
    set(releaseAll(stateRef.current));

    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (sending.current) {
        await landed.current;
        continue;
      }
      const { inflight, queued } = stateRef.current;
      if (inflight.length === 0 && queued.length === 0) break;
      await flushRef.current();
    }

    if (failures.current !== failuresBefore) {
      throw new Error('A change you made could not be saved, so nothing else was started. Try again once it is saved.');
    }
    if (sending.current || stateRef.current.queued.length > 0) {
      throw new Error('Your changes are still being saved. Try again in a moment.');
    }
  }, [set]);

  /**
   * Run a write that must not interleave with edits. `task` receives the confirmed kit
   * and returns a response carrying the server's new kit, which becomes the base.
   */
  const exclusive = useCallback(
    async (task) => {
      if (claimed.current) throw new Error('Something else is already being regenerated. Wait for it to finish.');
      claimed.current = true;

      try {
        await settle();
        exclusiveRef.current = true;
        clearTimeout(timer.current);
        timer.current = null;

        const response = await task(stateRef.current.base);
        if (response?.kit) set({ ...stateRef.current, base: response.kit });
        return response;
      } catch (error) {
        // Someone else changed the kit first, so nothing was regenerated. Show their kit —
        // with this person's waiting edits still on top — so trying again starts from it.
        if (isStaleRevision(error) && error.kit) set({ ...stateRef.current, base: error.kit });
        throw error;
      } finally {
        exclusiveRef.current = false;
        claimed.current = false;
        // What was typed while the task ran goes now, onto the kit it returned.
        if (stateRef.current.queued.length > 0) flushRef.current();
      }
    },
    [set, settle]
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

  return {
    kit,
    edit,
    add,
    arrange,
    remove,
    undoRemove,
    revert,
    statusOf,
    settle,
    exclusive,
    flush: () => flushRef.current(),
  };
}
