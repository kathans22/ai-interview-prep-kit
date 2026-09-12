/**
 * useProgress.js — follow a kit being built.
 *
 * Decides: how progress events are collected and merged, and what the connection's own
 * state is.
 *
 * Does NOT decide: what a step means or how it is drawn (`steps.js`, `ProgressSteps`),
 * and nothing about the build itself.
 *
 * EVENTS ARE MERGED BY IDENTITY, NOT APPENDED. The server replays the whole persisted
 * log every time a client connects — deliberately, so a reload or a late connection sees
 * the story rather than its tail. That makes appending wrong: one reconnect and every
 * step appears twice. Each entry is keyed by step, status and timestamp, which the
 * server writes and never changes, so replaying the same log twice is idempotent and a
 * reconnect costs nothing. This is what makes the reconnect in the next unit safe rather
 * than merely tolerable.
 *
 * `EventSource` IS NOT `fetch`, so it does not go through `api.js`. It has no promise to
 * reject, its failure mode is a silent retry loop, and its only error signal is an event
 * with no status code. Its URL is built here from the same base — the one thing it
 * borrows — and its errors become a connection STATE rather than an `AppError`, because
 * "the stream dropped" is not something a screen should show as a failure when the data
 * is still arriving by other means.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const BASE = import.meta.env?.VITE_API_BASE ?? '';

/** Connection states this hook reports. */
export const STREAM_STATES = Object.freeze({
  idle: 'idle',
  connecting: 'connecting',
  open: 'open',
  /** The build reached a terminal status; there is nothing more to stream. */
  closed: 'closed',
  /** The stream dropped or never opened. */
  broken: 'broken',
});

/** Stable identity for a persisted progress entry. */
function keyOf(entry) {
  return `${entry.step}|${entry.status}|${entry.at ?? ''}`;
}

/** Terminal kit statuses. Once reached, the stream has nothing left to say. */
const FINISHED = new Set(['ready', 'failed']);

export function useProgress(kitId, { initial = [], initialStatus = null, enabled = true } = {}) {
  // A Map keyed by entry identity: insertion-ordered, so the timeline stays in the order
  // the server wrote it, and replay-safe.
  const [entries, setEntries] = useState(() => new Map((initial ?? []).map((entry) => [keyOf(entry), entry])));
  const [status, setStatus] = useState(initialStatus);
  const [connection, setConnection] = useState(enabled ? STREAM_STATES.connecting : STREAM_STATES.idle);

  const sourceRef = useRef(null);

  const merge = useCallback((entry) => {
    if (!entry?.step) return;
    setEntries((current) => {
      const key = keyOf(entry);
      if (current.has(key)) return current; // a replayed entry changes nothing
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

    setConnection(STREAM_STATES.connecting);

    const source = new EventSource(`${BASE}/api/kits/${encodeURIComponent(kitId)}/progress`, {
      withCredentials: true,
    });
    sourceRef.current = source;

    source.addEventListener('open', () => setConnection(STREAM_STATES.open));

    source.addEventListener('progress', (event) => {
      setConnection(STREAM_STATES.open);
      try {
        merge(JSON.parse(event.data));
      } catch {
        // One unreadable frame must not take the stream down; the poll fallback and the
        // next frame both still work.
      }
    });

    source.addEventListener('state', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data?.status) setStatus(data.status);
      } catch {
        /* ignore, as above */
      }
    });

    source.addEventListener('done', (event) => {
      try {
        const data = JSON.parse(event.data);
        // 'closed' is the runner shutting down, not a kit status.
        if (data?.status && data.status !== 'closed') setStatus(data.status);
      } catch {
        /* ignore, as above */
      }
      setConnection(STREAM_STATES.closed);
      source.close();
    });

    source.addEventListener('error', () => {
      // EventSource reports failure with no status code, and by default retries on its
      // own schedule. It is closed here so reconnection is this app's decision rather
      // than the browser's — see the next unit.
      source.close();
      setConnection(STREAM_STATES.broken);
    });

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [kitId, enabled, merge]);

  const progress = [...entries.values()];

  return {
    progress,
    status,
    connection,
    done: FINISHED.has(status),
    /** Merge entries from somewhere else — the polling fallback uses this. */
    merge,
    setStatus,
    setConnection,
  };
}
