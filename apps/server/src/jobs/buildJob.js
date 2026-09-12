/**
 * buildJob.js — run a kit build outside the request that asked for it.
 *
 * Decides: when a build starts, what it writes as it goes, and what a failure leaves
 * behind.
 *
 * Does NOT decide: how a kit is built. It calls `buildKit` and records the result. The
 * HTTP layer and the CLI call the same orchestrator; this only adds persistence and a
 * progress trail.
 *
 * AN IN-PROCESS QUEUE, AND ITS LIMITS STATED PLAINLY. Jobs run in this Node process,
 * tracked in a Map. There is no Redis, no BullMQ, no worker pool.
 *
 *   What that buys: a build survives the request that started it, progress is written
 *   as it happens, and the whole thing is testable in-process with no broker.
 *
 *   What it costs, honestly: a restart loses in-flight jobs. A kit left `running` when
 *   the process died stays `running` forever unless something reclaims it — which is
 *   exactly why `store.kits.reclaimStale()` exists and is called at boot. And with more than one
 *   server process, each has its own queue, so concurrency limits are per-process. For
 *   a single-instance deploy that is correct; for a scaled one it would need a real
 *   broker, and pretending otherwise would be the dishonest option.
 *
 * CONCURRENCY IS CAPPED, AND THE CAP IS THE POINT. Every concurrent build draws on the
 * same Gemini limiter and the same 20-requests-a-day ceiling. Two builds at once is the
 * configured batch concurrency; more would not go faster, because the limiter would
 * queue them anyway — it would only make the memory footprint and the failure blast
 * radius larger.
 *
 * THE JOB NEVER THROWS. A rejected promise from an unawaited call is an unhandled
 * rejection, which in Node kills the process by default. Every failure path here ends
 * in a write to the kit, not an exception.
 */

import { buildKit } from '@aipk/core/orchestrator/buildKit.js';

import { KIT_STATUS } from '../models/Kit.js';

// `STALE_AFTER_MS` used to live here, beside a reclaim that could not run. Both the
// window and the error code now live in `models/Kit.js`, which is where the two stores
// that actually implement the reclaim can share them.

/**
 * Create a job runner.
 *
 * @param {object} options
 * @param {object} options.store
 * @param {number} [options.concurrency] builds in flight at once
 * @param {Function} [options.build] injected for tests; defaults to the real orchestrator
 * @param {Function} [options.log]
 */
export function createJobRunner({ store, concurrency = 2, build = buildKit, log = () => {} } = {}) {
  if (!store) throw new Error('JOBS_NOT_CONFIGURED: createJobRunner requires a store.');

  /** kitId -> { promise, startedAt } for jobs currently running. */
  const running = new Map();
  /** Jobs waiting for a slot. */
  const queue = [];
  /** Listeners for progress, keyed by kitId — this is what SSE subscribes to. */
  const listeners = new Map();

  function emit(kitId, event) {
    for (const listener of listeners.get(kitId) ?? []) {
      try {
        listener(event);
      } catch {
        // A broken listener is the listener's problem, never the build's.
      }
    }
  }

  /** Subscribe to a kit's progress. Returns an unsubscribe function. */
  function subscribe(kitId, listener) {
    if (!listeners.has(kitId)) listeners.set(kitId, new Set());
    listeners.get(kitId).add(listener);
    return () => {
      listeners.get(kitId)?.delete(listener);
      if (listeners.get(kitId)?.size === 0) listeners.delete(kitId);
    };
  }

  async function runOne({ kitId, input, config, deps, resumeFrom = null }) {
    const startedAt = Date.now();

    await store.kits.write({
      kitId,
      set: { status: KIT_STATUS.RUNNING },
      push: { progress: { step: 'build', status: 'started', detail: {}, at: new Date() } },
    });
    emit(kitId, { step: 'build', status: 'started' });

    try {
      const result = await build(
        // `resumeFrom` reaches buildKit as part of the input, which is where it belongs:
        // resuming is a property of the run being asked for, not of the collaborators
        // it is given. Null for an ordinary build, so the normal path is unchanged.
        { jd: input.jd, company_url: input.company_url, days: input.days, kitId, resumeFrom },
        { ...deps, config },
        {
          onProgress: (step, status, event) => {
            // Built from the arguments, not forwarded from `event`. The reporter happens
            // to include step and status in its event object, but a stream that relies
            // on that breaks silently the moment a caller passes a bare detail object —
            // the client then receives `undefined:undefined` and shows nothing.
            emit(kitId, { step, status, detail: event ?? {}, at: new Date().toISOString() });
            // Progress is persisted as well as streamed: a client that connects late,
            // or reloads, must be able to see what already happened. A stream-only
            // design shows an empty page to anyone who did not watch it live.
            store.kits
              .write({ kitId, push: { progress: { step, status, detail: event ?? {}, at: new Date() } } })
              .catch(() => {});
          },
        }
      );

      await store.kits.write({
        kitId,
        set: {
          status: KIT_STATUS.READY,
          kit: result.kit,
          'error.code': null,
          'error.message': null,
          pageCache: result.pageCache ?? null,
        },
        push: {
          progress: {
            step: 'build',
            status: 'done',
            detail: { ms: Date.now() - startedAt, notes: result.notes?.length ?? 0 },
            at: new Date(),
          },
        },
      });

      emit(kitId, { step: 'build', status: 'done', ms: Date.now() - startedAt });
      log('[job] built', kitId, `${Date.now() - startedAt}ms`);
      return { ok: true };
    } catch (error) {
      // Only a total inability to produce a kit reaches here — everything else degraded
      // inside the orchestrator and returned a kit with notes.
      const code = error?.code ?? 'BUILD_FAILED';

      await store.kits
        .write({
          kitId,
          set: {
            status: KIT_STATUS.FAILED,
            'error.code': code,
            'error.message': error?.message ?? 'The build failed.',
            'error.at': new Date(),
          },
          push: { progress: { step: 'build', status: 'failed', detail: { code }, at: new Date() } },
        })
        .catch(() => {});

      emit(kitId, { step: 'build', status: 'failed', code });
      log('[job] failed', kitId, code, error?.message);
      return { ok: false, code };
    } finally {
      running.delete(kitId);
      emit(kitId, { step: 'build', status: 'closed' });
      listeners.delete(kitId);
      pump();
    }
  }

  /** Start queued jobs until the concurrency cap is reached. */
  function pump() {
    while (running.size < concurrency && queue.length > 0) {
      const job = queue.shift();
      const promise = runOne(job);
      running.set(job.kitId, { promise, startedAt: Date.now() });
    }
  }

  /**
   * Enqueue a build. Returns immediately; never throws.
   *
   * @returns {{ queued: boolean, position: number }}
   */
  function start(job) {
    if (running.has(job.kitId) || queue.some((entry) => entry.kitId === job.kitId)) {
      // Already building. Starting a second run for one kit would double the quota
      // spend and race two writers onto the same document.
      return { queued: false, position: 0, reason: 'ALREADY_RUNNING' };
    }

    queue.push(job);
    pump();
    return { queued: true, position: queue.length };
  }

  /** Wait for everything to settle. Tests and shutdown use this; routes never do. */
  async function drain() {
    while (running.size > 0 || queue.length > 0) {
      await Promise.all([...running.values()].map((entry) => entry.promise));
    }
  }

  /**
   * RECLAIMING STALE KITS IS THE STORE'S JOB, NOT THIS MODULE'S.
   *
   * There used to be a second `reclaimStale` here. It was never reachable: nothing
   * called it, and it depended on a `store.kits.findStaleRunning` that neither store
   * implemented, so it would have returned zero even if something had. It also wrote a
   * different error code from the one the live path writes, which is how a client came
   * to match the wrong one (BUG-035).
   *
   * `store.kits.reclaimStale()` is the real implementation and `index.js` calls it at
   * boot. It belongs there for a reason beyond tidiness: on MongoDB it is a single
   * `updateMany`, so the whole sweep is one atomic statement rather than a read followed
   * by a write per kit — which is what you want when a process has just restarted and
   * another instance may be doing the same thing.
   */

  return {
    start,
    subscribe,
    drain,
    isRunning: (kitId) => running.has(kitId),
    stats: () => ({ running: running.size, queued: queue.length, concurrency }),
  };
}
