/**
 * useProgress.js — follow a kit being built, and keep following it.
 *
 * Decides: how progress events are collected and merged, when a dropped stream is
 * retried, and when to stop trying and poll instead.
 *
 * Does NOT decide: what a step means or how it is drawn (`steps.js`, `ProgressSteps`),
 * and nothing about the build itself.
 *
 * EVENTS ARE MERGED BY IDENTITY, NOT APPENDED. The server replays the whole persisted
 * log every time a client connects — deliberately, so a reload or a late connection sees
 * the story rather than its tail. That makes appending wrong: one reconnect and every
 * step appears twice.
 *
 * THE KEY DELIBERATELY EXCLUDES THE TIMESTAMP. The same logical event reaches this hook
 * with two different timestamps: the job runner stamps the streamed copy with
 * `new Date().toISOString()` and the persisted copy with a second `new Date()` created
 * microseconds later. Keying on the timestamp therefore fails to dedupe exactly when it
 * matters — after a reconnect or a poll, which is the whole point of this hook. Keying
 * on step, status and detail collapses those two into one, and still separates
 * `coverage done {pass: 1}` from `coverage done {pass: 2}`, which differ in detail.
 *
 * `EventSource`'s `error` EVENT CANNOT BE TRUSTED TO FIRE. Measured, not assumed: with
 * the backend killed mid-build and its sockets destroyed, the connection sat in
 * `readyState OPEN` for 39 seconds and no `error` event ever arrived. A reconnect built
 * only on that event therefore never runs, and the page shows a half-finished list for
 * as long as the user is willing to look at it — which is precisely the "spinning
 * forever" failure this stage's exit check exists to catch.
 *
 * So there is a WATCHDOG, and it VERIFIES rather than concludes. Silence on the stream is
 * genuinely ambiguous: the server heartbeats every fifteen seconds, but heartbeats are
 * SSE comment frames and comments fire no event, so a dead connection and a slow crawl
 * look identical from here. When nothing has arrived for `WATCHDOG_MS` the hook asks the
 * polling endpoint one question — is the backend there?
 *   - Answers, build finished  -> done.
 *   - Answers, still building  -> the backend is fine and the stream is not: reconnect it.
 *   - Does not answer          -> the backend is gone: say so and keep polling.
 * A false alarm costs one small request and one reconnect, and both are free because
 * entries merge by identity and the server replays everything on connect.
 *
 * TWO FAILURES, TWO RESPONSES. The brief distinguishes them and so does this:
 *   - A stream that OPENED and then dropped is transient — a laptop lid, a proxy idle
 *     timeout, a server restart. It is retried with backoff, because it will probably
 *     work again.
 *   - A stream that NEVER OPENED is usually structural — a proxy that buffers or strips
 *     `text/event-stream`. Retrying it three times only delays the fallback, so it goes
 *     straight to polling.
 * Polling is not a lesser mode. It is the one that always works, and the server's
 * `?since=N` endpoint exists for it.
 *
 * NOTHING SPINS FOREVER. Every state this hook can be in is reportable, so the screen
 * can say "reconnecting" or "the live connection dropped, still checking" instead of
 * animating at someone while nothing arrives.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { kits } from '../lib/api.js';
import { isCancelled } from '../lib/apiError.js';

const BASE = import.meta.env?.VITE_API_BASE ?? '';

/** Connection states this hook reports. */
export const STREAM_STATES = Object.freeze({
  idle: 'idle',
  connecting: 'connecting',
  open: 'open',
  /** Dropped after having worked; a retry is scheduled. */
  reconnecting: 'reconnecting',
  /** The stream is not usable; progress is arriving by polling. */
  polling: 'polling',
  /** The build reached a terminal status; there is nothing more to follow. */
  closed: 'closed',
  /** Neither the stream nor polling is getting through. */
  broken: 'broken',
});

/** Retries for a stream that had been working. Then polling takes over. */
const MAX_RECONNECTS = 3;
const BACKOFF_MS = [1000, 2000, 4000];
const POLL_MS = 2000;

/**
 * How long total silence is tolerated before the backend is asked whether it is alive.
 *
 * Under the server's fifteen-second heartbeat, so a connection that is merely idle is
 * still checked — the heartbeat keeps the socket open but is invisible to this code, so
 * it cannot be used as evidence of life.
 */
const WATCHDOG_MS = 12_000;

/** Terminal kit statuses. Once reached, there is nothing left to follow. */
const FINISHED = new Set(['ready', 'failed']);

/** Stable identity for a progress entry — see the header on why `at` is excluded. */
function keyOf(entry) {
  const detail = entry.detail ?? {};
  const stable = Object.keys(detail)
    .sort()
    .map((name) => `${name}=${JSON.stringify(detail[name])}`)
    .join(',');
  return `${entry.step}|${entry.status}|${stable}`;
}

export function useProgress(kitId, { initial = [], initialStatus = null, enabled = true } = {}) {
  const [entries, setEntries] = useState(() => new Map((initial ?? []).map((entry) => [keyOf(entry), entry])));
  const [status, setStatus] = useState(initialStatus);
  const [connection, setConnection] = useState(enabled ? STREAM_STATES.connecting : STREAM_STATES.idle);

  const merge = useCallback((entry) => {
    if (!entry?.step) return;
    setEntries((current) => {
      const key = keyOf(entry);
      if (current.has(key)) return current; // a replayed or re-polled entry changes nothing
      const next = new Map(current);
      next.set(key, entry);
      return next;
    });
  }, []);

  // Re-seed when the caller's snapshot arrives after mount. The kit is fetched in
  // parallel with the stream opening, so whichever lands first must not discard the
  // other — the merge makes that safe in both directions.
  useEffect(() => {
    for (const entry of initial ?? []) merge(entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity of `initial` churns
  }, [initial?.length, merge]);

  useEffect(() => {
    if (!kitId || !enabled) {
      setConnection(STREAM_STATES.idle);
      return undefined;
    }

    // Everything this effect owns, so one teardown can stop all of it.
    let source = null;
    let retryTimer = null;
    let pollTimer = null;
    let watchdogTimer = null;
    let pollController = null;
    let stopped = false;
    let polling = false;
    let attempts = 0;
    /** Cursor for `?since=N`: how many entries the server has already handed over. */
    let cursor = 0;

    function stopEverything() {
      stopped = true;
      source?.close();
      source = null;
      clearTimeout(retryTimer);
      clearTimeout(pollTimer);
      clearTimeout(watchdogTimer);
      pollController?.abort();
    }

    function finish(kitStatus) {
      if (kitStatus) setStatus(kitStatus);
      stopEverything();
      setConnection(STREAM_STATES.closed);
    }

    /**
     * One request to the polling endpoint.
     *
     * @returns {Promise<'done'|'alive'|'unreachable'|'cancelled'>}
     */
    async function pollNow() {
      pollController = new AbortController();
      try {
        const snapshot = await kits.progressSince(kitId, cursor, pollController.signal);
        if (stopped) return 'cancelled';

        for (const entry of snapshot.progress ?? []) merge(entry);
        if (Number.isInteger(snapshot.total)) cursor = snapshot.total;
        if (snapshot.status) setStatus(snapshot.status);

        if (snapshot.done) {
          finish(snapshot.status);
          return 'done';
        }
        return 'alive';
      } catch (error) {
        if (stopped || isCancelled(error)) return 'cancelled';
        return 'unreachable';
      }
    }

    // --- polling: the mode that always works ------------------------------
    async function pollLoop() {
      if (stopped) return;

      const result = await pollNow();
      if (stopped || result === 'done' || result === 'cancelled') return;

      // A failed poll is not the end: the server may be restarting, which is exactly
      // the case the exit check exercises. Say so, and keep asking.
      setConnection(result === 'alive' ? STREAM_STATES.polling : STREAM_STATES.broken);
      pollTimer = setTimeout(pollLoop, POLL_MS);
    }

    function startPolling() {
      if (polling) return;
      polling = true;
      source?.close();
      source = null;
      clearTimeout(retryTimer);
      clearTimeout(watchdogTimer);
      setConnection(STREAM_STATES.polling);
      pollLoop();
    }

    // --- the watchdog -----------------------------------------------------
    function armWatchdog() {
      clearTimeout(watchdogTimer);
      if (stopped || polling) return;
      watchdogTimer = setTimeout(onSilence, WATCHDOG_MS);
    }

    async function onSilence() {
      if (stopped || polling) return;

      const result = await pollNow();
      if (stopped || result === 'done' || result === 'cancelled') return;

      if (result === 'unreachable') {
        // The backend is genuinely gone. Polling owns it from here, and it keeps trying,
        // so the page catches up by itself when the backend returns.
        startPolling();
        return;
      }

      // The backend answered, so the silence was the stream's fault. Reconnect it —
      // free, because the server replays and entries merge by identity.
      source?.close();
      source = null;
      connect();
    }

    // --- the stream -------------------------------------------------------
    function connect() {
      if (stopped) return;

      let opened = false;
      setConnection(attempts === 0 ? STREAM_STATES.connecting : STREAM_STATES.reconnecting);

      source = new EventSource(`${BASE}/api/kits/${encodeURIComponent(kitId)}/progress`, {
        withCredentials: true,
      });

      source.addEventListener('open', () => {
        opened = true;
        attempts = 0; // a working connection earns a fresh set of retries
        setConnection(STREAM_STATES.open);
        armWatchdog();
      });

      source.addEventListener('progress', (event) => {
        opened = true;
        setConnection(STREAM_STATES.open);
        armWatchdog();
        try {
          merge(JSON.parse(event.data));
        } catch {
          // One unreadable frame must not take the stream down; the next frame and the
          // poll fallback both still work.
        }
      });

      source.addEventListener('state', (event) => {
        armWatchdog();
        try {
          const data = JSON.parse(event.data);
          if (data?.status) setStatus(data.status);
        } catch {
          /* ignore, as above */
        }
      });

      source.addEventListener('done', (event) => {
        let kitStatus = null;
        try {
          const data = JSON.parse(event.data);
          // 'closed' is the runner shutting down, not a kit status.
          if (data?.status && data.status !== 'closed') kitStatus = data.status;
        } catch {
          /* ignore, as above */
        }
        finish(kitStatus);
      });

      source.addEventListener('error', () => {
        if (stopped) return;
        clearTimeout(watchdogTimer);

        // EventSource retries on its own schedule and reports failure with no status
        // code. It is closed here so reconnection is this app's decision.
        source?.close();
        source = null;

        if (!opened) {
          // It never worked. Almost always a proxy that will not pass an event stream,
          // so three more attempts would only delay the fallback.
          startPolling();
          return;
        }

        if (attempts >= MAX_RECONNECTS) {
          startPolling();
          return;
        }

        const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
        attempts += 1;
        setConnection(STREAM_STATES.reconnecting);
        // Jitter, so several tabs reopened together do not retry in lockstep.
        retryTimer = setTimeout(connect, wait + Math.floor(Math.random() * 250));
      });
    }

    connect();
    // Armed before anything arrives, so a stream that opens and then says nothing — or
    // never opens at all without reporting it — is still noticed.
    armWatchdog();

    return stopEverything;
  }, [kitId, enabled, merge]);

  const progress = [...entries.values()];

  return {
    progress,
    status,
    connection,
    done: FINISHED.has(status),
    /** True while progress is still arriving by some route. */
    following: connection === STREAM_STATES.open || connection === STREAM_STATES.polling,
    merge,
    setStatus,
  };
}

/**
 * What to tell the reader about the connection, or null when there is nothing worth
 * saying. A healthy live stream says nothing: a badge reading "Connected" is noise, and
 * its absence is what makes the other messages noticeable.
 */
export function describeConnection(connection) {
  switch (connection) {
    case STREAM_STATES.connecting:
      return { tone: 'info', text: 'Connecting to the live update stream…' };
    case STREAM_STATES.reconnecting:
      return { tone: 'warn', text: 'The live connection dropped. Reconnecting…' };
    case STREAM_STATES.polling:
      return { tone: 'info', text: 'Live updates are unavailable, so this page is checking every couple of seconds instead.' };
    case STREAM_STATES.broken:
      return { tone: 'warn', text: 'Cannot reach the server. Still trying — this page will catch up on its own once it is back.' };
    default:
      return null;
  }
}
