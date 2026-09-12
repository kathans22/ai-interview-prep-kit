/**
 * useKits.js — the data hooks for kits.
 *
 * Decides: which endpoint each screen reads, and nothing more than that.
 *
 * Does NOT decide: how a kit is rendered, what a valid kit is, or what an edit means.
 * Every one of those is a server-side rule living in `packages/core` — a hook that
 * "helpfully" filtered or reshaped a kit would be a second implementation of a contract
 * that already has one.
 *
 * Each hook is a thin pairing of `useAsync` with one function from `api.js`. That is
 * deliberate: the whole point of putting fetching in hooks is that components stop
 * containing request logic, and the way to keep that true is for the hooks to contain no
 * logic either.
 */

import { useCallback } from 'react';

import { kits, practice } from '../lib/api.js';
import { useAsync } from './useAsync.js';

/** The caller's kits, newest first. Failures are rows too — the listing must show them. */
export function useKitList({ limit } = {}) {
  const task = useCallback((signal) => kits.list({ limit, signal }), [limit]);
  const { data, ...rest } = useAsync(task, { deps: [limit] });

  return { ...rest, kits: data?.kits ?? [] };
}

/**
 * One kit and everything the page around it needs.
 *
 * The revision is not returned: it is recorded in the ledger by `api.js` and read back
 * from there by every write. A screen that held its own copy would eventually send a
 * number from before the last regeneration.
 */
export function useKit(id) {
  const task = useCallback((signal) => kits.get(id, signal), [id]);
  const { data, ...rest } = useAsync(task, { deps: [id], immediate: Boolean(id) });

  return {
    ...rest,
    kit: data?.kit ?? null,
    status: data?.status ?? null,
    /** Which sections a regeneration can still be undone on. */
    canUndo: data?.canUndo ?? {},
    /** Whether a resume would have anything to resume FROM. Never the checkpoint itself. */
    hasCheckpoint: Boolean(data?.hasCheckpoint),
    progress: data?.progress ?? [],
    /** The build's own failure, when it has one. Distinct from a request failure. */
    buildError: data?.error ?? null,
    input: data?.input ?? null,
    /** The request-level state machine, so a screen can tell the two failures apart. */
    requestStatus: rest.status,
  };
}

/**
 * Create a kit. Not immediate — a build costs model quota, so it fires only when a
 * person submits the form.
 *
 * A duplicate submission comes back 200 with `duplicate: true` rather than as an error,
 * because nothing went wrong: the kit the visitor asked for already exists or is already
 * building. The screen says which, instead of looking like the button did nothing.
 */
export function useCreateKit() {
  const task = useCallback((signal, input) => kits.create(input), []);
  const { run, ...rest } = useAsync(task, { immediate: false });

  return { ...rest, create: run };
}

/**
 * Submit several postings at once.
 *
 * Every case comes back with an answer, including the ones that did not start — a
 * response listing only new kits would leave the caller to work out which of its cases
 * are missing and why. `accepted` and `duplicates` separate the two.
 */
export function useCreateBatch() {
  const task = useCallback((signal, cases) => kits.batch(cases), []);
  const { run, ...rest } = useAsync(task, { immediate: false });

  return { ...rest, submit: run };
}

/**
 * Continue an interrupted or failed kit.
 *
 * The one server mechanism for both continuing and retrying: it resumes from a
 * checkpoint when there is one and starts over when there is not, and the response says
 * which. The caller reports that rather than guessing, because the two cost very
 * different fractions of a day's model quota.
 */
export function useResumeKit() {
  const task = useCallback((signal, id, options) => kits.resume(id, options), []);
  const { run, ...rest } = useAsync(task, { immediate: false });

  return { ...rest, resume: run };
}

/** Delete a kit. Not immediate — a destructive action waits to be asked for. */
export function useDeleteKit() {
  const task = useCallback((signal, id) => kits.remove(id), []);
  const { run, ...rest } = useAsync(task, { immediate: false });

  return { ...rest, remove: run };
}

/** This kit's practice history, weakest question first. */
export function usePracticeHistory(id) {
  const task = useCallback((signal) => practice.history(id, signal), [id]);
  const { data, ...rest } = useAsync(task, { deps: [id], immediate: Boolean(id) });

  return { ...rest, total: data?.total ?? 0, entries: data?.entries ?? [], questions: data?.questions ?? [] };
}

/** Record one confidence rating. Append-only on the server; no revision, no conflict. */
export function useRecordPractice(id) {
  const task = useCallback((signal, rating) => practice.record(id, rating), [id]);
  const { run, ...rest } = useAsync(task, { immediate: false, deps: [id] });

  return { ...rest, record: run };
}
