/**
 * useAsync.js — the one state machine every data fetch on this client runs through.
 *
 * Decides: the four states a request can be in (`idle`, `loading`, `ready`, `error`),
 * that a request is aborted when the component holding it goes away, and that a
 * cancelled request is never shown as a failure.
 *
 * Does NOT decide: what is fetched, or what any state looks like. The URL belongs to a
 * hook over `api.js`; the appearance belongs to `SectionState`, whose four cases are
 * deliberately the same four words.
 *
 * WHY DATA FETCHING LIVES IN A HOOK AND NOT IN A COMPONENT. Three reasons, in order of
 * how much they cost when ignored:
 *   - A component that fetches in its own body re-fetches on every render, which is
 *     invisible locally and obvious on a metered API.
 *   - Setting state after an unmount is a leak React used to warn about and now
 *     silently tolerates — so the bug stays.
 *   - Every screen otherwise writes its own loading and error branches, and they drift.
 *     One of them ends up showing a spinner forever on a failure.
 *
 * ABORT, NOT IGNORE. When a component unmounts mid-flight the request is aborted rather
 * than left to finish and be discarded. A discarded response still cost the round trip,
 * and for this API a discarded request can still have spent model quota.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { isCancelled } from '../lib/apiError.js';

export const ASYNC_STATES = Object.freeze({
  idle: 'idle',
  loading: 'loading',
  ready: 'ready',
  error: 'error',
});

/**
 * @param {(signal: AbortSignal) => Promise<any>} task  receives a signal; pass it on
 * @param {object} [options]
 * @param {boolean} [options.immediate] run on mount (default true). False for a task
 *   the visitor triggers — a form submit should not fire because a page rendered.
 * @param {any[]} [options.deps] re-run when these change, the way `useEffect` would
 */
export function useAsync(task, { immediate = true, deps = [] } = {}) {
  const [state, setState] = useState({
    status: immediate ? ASYNC_STATES.loading : ASYNC_STATES.idle,
    data: null,
    error: null,
  });

  // The live request, so a second run can abort the first — a visitor who clicks twice
  // should get the second answer, not whichever arrives last.
  const inFlight = useRef(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlight.current?.abort();
    };
  }, []);

  const run = useCallback(
    async (...args) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      if (mounted.current) {
        setState((previous) => ({ ...previous, status: ASYNC_STATES.loading, error: null }));
      }

      try {
        const data = await task(controller.signal, ...args);
        if (!mounted.current || controller.signal.aborted) return data;
        setState({ status: ASYNC_STATES.ready, data, error: null });
        return data;
      } catch (error) {
        // A cancelled request is not a failure — it is what we asked for. Showing it as
        // an error puts "That request was cancelled" on screen every time a visitor
        // navigates away, which teaches them to distrust the error surface.
        if (isCancelled(error) || !mounted.current) throw error;
        setState({ status: ASYNC_STATES.error, data: null, error });
        throw error;
      } finally {
        if (inFlight.current === controller) inFlight.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller declares deps
    [task, ...deps]
  );

  useEffect(() => {
    if (!immediate) return;
    // The throw is already recorded in state; swallowing it here stops an unhandled
    // rejection for a failure the UI is about to render.
    run().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller declares deps
  }, [immediate, ...deps]);

  return {
    ...state,
    isLoading: state.status === ASYNC_STATES.loading,
    run,
    /** Re-run the same task. Named for what a screen means by it. */
    reload: run,
    /** Drop the result without firing anything — for closing a modal that held an error. */
    reset: useCallback(
      () => setState({ status: immediate ? ASYNC_STATES.loading : ASYNC_STATES.idle, data: null, error: null }),
      [immediate]
    ),
  };
}
