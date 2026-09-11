/**
 * kitRoutes.js — create, list, read and delete kits.
 *
 * Decides: the shape of those four endpoints and the order of their checks.
 *
 * Does NOT decide: how a kit is built (`@aipk/core/orchestrator/buildKit.js`), how
 * duplicates are detected (`models/idempotency.js`), or who owns what (`requireAuth`).
 * Every handler here is: validate, check ownership, call something, map the result.
 *
 * CREATE RETURNS IMMEDIATELY. A build takes up to 150 seconds; an HTTP request that
 * waits for it is a request that dies to a proxy timeout, a laptop lid, or a bored user
 * reloading — and on reload it starts a SECOND build, spending quota twice for one kit.
 * So POST records the intent, starts the work in the background, and hands back an id
 * the client polls or streams. The job runner arrives in the next unit; this unit's
 * contract is the response shape it will populate.
 *
 * IDEMPOTENCY IS CHECKED BEFORE ANYTHING IS CREATED. A double-clicked form is the
 * ordinary case, not an attack, and on a 20-requests-a-day ceiling a duplicate build is
 * a whole day's quota spent on a kit that already exists. The window is documented and
 * the response says plainly that this is why no new kit appeared.
 */

import { route, ApiError } from './errors.js';
import { validateKitInput } from './validate.js';
import { requireAuth, withOwnedKit } from '../auth/requireAuth.js';
import { duplicateMessage, duplicateQuery, describeDuplicate } from '../models/idempotency.js';

/** A client cannot ask for more than this many kits in one listing. */
const MAX_LIST = 100;

/**
 * Mount the kit routes.
 *
 * @param {import('express').Express} app
 * @param {object} [options]
 * @param {Function} [options.startJob] enqueue a build; injected so this unit is
 *   testable before the runner exists, and so the CLI never accidentally depends on it
 * @param {Function} [options.rateLimit]
 */
export function mountKitRoutes(app, { startJob = null, rateLimit = (req, res, next) => next() } = {}) {
  /**
   * POST /api/kits — start a generation.
   *
   * 202 Accepted, not 201 Created: the kit does not exist yet. 201 with an empty kit
   * would tell a client its resource is ready when it is queued.
   */
  app.post(
    '/api/kits',
    requireAuth,
    rateLimit,
    route(async (request, response) => {
      const input = validateKitInput(request.body);
      const userId = request.session.userId;

      const windowMs = request.config.budgets.idempotencyWindowMs;

      // The POLICY — how the hash is built, how far back to look, which statuses count —
      // comes from `idempotency.js`, which documents all three. This route used to
      // restate them inline, so the module held an authoritative copy that nothing
      // called and changing the rule where it was written changed nothing at runtime.
      const query = duplicateQuery(input, { windowMs });

      // The QUERY goes to the STORE, not to a Mongoose model: the route must work
      // against either backing store, and a route that reaches for Mongoose query
      // syntax is a route the in-memory store can never satisfy.
      const existing = await request.store.kits.findDuplicate({ userId, ...query });

      const duplicate = {
        duplicate: Boolean(existing),
        kit: existing,
        hash: query.jdHash,
        reason: describeDuplicate(existing),
      };

      if (duplicate.duplicate) {
        // 200, not 202: nothing was accepted for processing, because nothing needed to
        // be. The body says which kit and why, so the UI can explain rather than look
        // like the button did nothing.
        response.status(200).json({
          kitId: String(duplicate.kit.id ?? duplicate.kit._id),
          status: duplicate.kit.status,
          duplicate: true,
          reason: duplicate.reason,
          message: duplicateMessage(windowMs),
        });
        return;
      }

      const created = await request.store.kits.create({
        userId,
        input,
        jdHash: duplicate.hash,
        status: 'queued',
      });

      const kitId = String(created.id ?? created._id);

      if (startJob) {
        // Deliberately not awaited. The whole point of this endpoint is that it returns
        // before the work finishes; awaiting here would reintroduce the long request it
        // exists to avoid. The runner owns its own failures and records them on the kit.
        startJob({ kitId, userId, input, config: request.config, deps: request.deps });
      }

      response.status(202).json({ kitId, status: 'queued', duplicate: false });
    })
  );

  /**
   * GET /api/kits — the caller's kits, newest first.
   *
   * Summaries only. A listing that embedded every full kit would send megabytes to
   * render a list of titles.
   */
  app.get(
    '/api/kits',
    requireAuth,
    route(async (request, response) => {
      const limit = Math.min(Number(request.query.limit) || 50, MAX_LIST);

      const kits = await request.store.kits.listOwned({
        userId: request.session.userId,
        limit,
      });

      response.json({
        kits: kits.map((kit) => ({
          id: String(kit.id ?? kit._id),
          status: kit.status,
          revision: kit.revision,
          company_url: kit.input?.company_url ?? '',
          days: kit.input?.days ?? null,
          jdChars: kit.input?.jd?.length ?? 0,
          // The listing must show failures, not hide them behind a status word: a user
          // looking at a failed kit needs to know whether to retry or change the input.
          error: kit.error?.code ? { code: kit.error.code, message: kit.error.message } : null,
          questionCount: Array.isArray(kit.kit?.questions) ? kit.kit.questions.length : 0,
          createdAt: kit.createdAt,
          updatedAt: kit.updatedAt,
        })),
      });
    })
  );

  /**
   * GET /api/kits/:id — the full kit and its current revision.
   *
   * The revision is what a client must send back with any edit, so it travels with
   * every read. A client that has to ask for it separately is a client that will
   * sometimes forget and lose an edit to a 409.
   */
  app.get(
    '/api/kits/:id',
    requireAuth,
    withOwnedKit(),
    route(async (request, response) => {
      const kit = request.kit;

      response.json({
        id: String(kit.id ?? kit._id),
        status: kit.status,
        revision: kit.revision,
        input: {
          company_url: kit.input?.company_url ?? '',
          days: kit.input?.days ?? null,
          jdChars: kit.input?.jd?.length ?? 0,
        },
        kit: kit.kit,
        progress: kit.progress ?? [],
        canUndo: Object.fromEntries(
          ['company_brief', 'questions', 'flashcards', 'schedule'].map((section) => [
            section,
            Boolean(kit.previousSections?.[section]),
          ])
        ),
        error: kit.error?.code ? { code: kit.error.code, message: kit.error.message } : null,
        createdAt: kit.createdAt,
        updatedAt: kit.updatedAt,
      });
    })
  );

  /**
   * DELETE /api/kits/:id
   *
   * Scoped by owner in the delete itself, not by a check beforehand — the same reason
   * reads are: a check-then-act has a window, and a delete is not something to get
   * wrong.
   */
  app.delete(
    '/api/kits/:id',
    requireAuth,
    route(async (request, response) => {
      const removed = await request.store.kits.remove({
        kitId: request.params.id,
        userId: request.session.userId,
      });

      if (!removed) {
        // Same 404 as a kit that never existed, for the same reason as everywhere else.
        throw new ApiError('KIT_NOT_FOUND', 'No kit with that id.');
      }

      response.json({ ok: true, id: request.params.id });
    })
  );

  return app;
}
