/**
 * progressRoutes.js — watch a kit being built.
 *
 * Decides: how progress reaches a client, live and after the fact.
 *
 * Does NOT decide: what progress means, or when it happens. The job runner emits; this
 * forwards.
 *
 * TWO ENDPOINTS FOR ONE QUESTION, AND BOTH ARE NECESSARY.
 *   GET /api/kits/:id/progress        Server-Sent Events, for a live build
 *   GET /api/kits/:id/progress/poll   a plain JSON snapshot
 *
 * SSE is the better experience and the worse dependency. It fails in ways a fetch does
 * not: some corporate proxies buffer `text/event-stream` until the response closes, so
 * the user watches nothing happen and then everything at once; HTTP/1.1 browsers cap
 * concurrent connections per origin, and a held-open stream occupies one; and a client
 * that reconnects gets no history unless the server replays it. The polling endpoint is
 * not a lesser alternative — it is the one that always works, and the UI is expected to
 * fall back to it rather than show a broken page.
 *
 * BOTH READ THE SAME PERSISTED PROGRESS. The stream replays what already happened before
 * attaching to the live feed, so a client that connects late — or reloads mid-build —
 * sees the whole story rather than the tail of it. That is the property that makes SSE
 * safe to lose: nothing exists only in the stream.
 */

import { route } from './errors.js';
import { requireAuth, withOwnedKit, loadOwnedKit } from '../auth/requireAuth.js';

/** Terminal statuses: once a kit reaches one, there is nothing further to stream. */
const FINISHED = new Set(['ready', 'failed']);

/** How often to remind a proxy the connection is alive. */
export const HEARTBEAT_MS = 15_000;

/**
 * Mount the progress endpoints.
 *
 * @param {import('express').Express} app
 * @param {{ jobs: { subscribe: Function, isRunning: Function } }} options
 */
export function mountProgressRoutes(app, { jobs } = {}) {
  /**
   * GET /api/kits/:id/progress — SSE.
   */
  app.get(
    '/api/kits/:id/progress',
    requireAuth,
    withOwnedKit(),
    route(async (request, response) => {
      const kitId = String(request.kit.id ?? request.kit._id);

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Nginx buffers proxied responses by default, which turns a live stream into
        // one delivery at the end. This header is the documented opt-out and is inert
        // everywhere else.
        'x-accel-buffering': 'no',
      });

      const send = (event, data) => {
        // A newline inside data would terminate the SSE frame early, so the payload is
        // always one line of JSON.
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Replay first. A client that connected late must not have to guess what it
      // missed, and a reload must not show an empty timeline.
      for (const entry of request.kit.progress ?? []) {
        send('progress', { step: entry.step, status: entry.status, detail: entry.detail, at: entry.at });
      }

      send('state', { status: request.kit.status, revision: request.kit.revision });

      // Already finished: say so and close rather than holding a connection open for a
      // build that will never emit again.
      if (FINISHED.has(request.kit.status)) {
        send('done', { status: request.kit.status });
        response.end();
        return;
      }

      const unsubscribe = jobs.subscribe(kitId, (event) => {
        if (event.status === 'closed') {
          send('done', { status: 'closed' });
          cleanup();
          response.end();
          return;
        }
        send('progress', event);
      });

      // Comment frames. They are ignored by EventSource but keep proxies and load
      // balancers from closing an idle connection they assume is dead.
      const heartbeat = setInterval(() => {
        response.write(': keep-alive\n\n');
      }, HEARTBEAT_MS);

      let cleanedUp = false;
      function cleanup() {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(heartbeat);
        unsubscribe();
      }

      // The client going away is the normal way this ends. Without these, every closed
      // tab leaks an interval and a subscription for the life of the process.
      request.on('close', cleanup);
      response.on('close', cleanup);
    })
  );

  /**
   * GET /api/kits/:id/progress/poll — the fallback.
   *
   * Returns the same information as a snapshot, plus `done`, so a polling client knows
   * when to stop asking rather than polling a finished kit forever.
   */
  app.get(
    '/api/kits/:id/progress/poll',
    requireAuth,
    route(async (request, response) => {
      const kit = await loadOwnedKit(request, request.params.id);
      const progress = kit.progress ?? [];

      // `since` lets a client ask only for what is new, so a poll loop does not re-send
      // the whole history every two seconds.
      const since = Number(request.query.since);
      const from = Number.isInteger(since) && since >= 0 ? since : 0;

      response.json({
        status: kit.status,
        revision: kit.revision,
        done: FINISHED.has(kit.status),
        running: jobs?.isRunning?.(String(kit.id ?? kit._id)) ?? false,
        total: progress.length,
        progress: progress.slice(from).map((entry) => ({
          step: entry.step,
          status: entry.status,
          detail: entry.detail,
          at: entry.at,
        })),
        error: kit.error?.code ? { code: kit.error.code, message: kit.error.message } : null,
      });
    })
  );

  return app;
}
