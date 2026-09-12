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
import { validateKitInput, validateBatchInput } from './validate.js';
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
   * POST /api/kits/batch — several postings at once.
   *
   * The same thing the CLI does, through HTTP: one kit per case, each with its own
   * `days`, all queued and none awaited.
   *
   * EVERY CASE GETS AN ANSWER, INCLUDING THE ONES THAT DID NOT START. The response has
   * one entry per input case, keyed by the id the caller gave, saying whether it was
   * queued or matched an existing kit. A response that listed only the new kits would
   * leave the client to work out which of its cases were missing and why.
   *
   * IT IS RATE LIMITED AND CAPPED. Five kits is up to sixty model calls against a
   * ceiling of twenty a day, so the cap is in `validateBatchInput` and this route draws
   * on the same generation limiter as single creation. Without both, one request is a
   * whole day's quota and the user finds out from the failures.
   *
   * IDEMPOTENCY IS PER CASE, using the same policy as a single submission — uploading
   * the same file twice must not build everything again.
   */
  app.post(
    '/api/kits/batch',
    requireAuth,
    rateLimit,
    route(async (request, response) => {
      const cases = validateBatchInput(request.body);
      const userId = request.session.userId;
      const windowMs = request.config.budgets.idempotencyWindowMs;

      const results = [];

      for (const kase of cases) {
        const { id, ...input } = kase;
        const query = duplicateQuery(input, { windowMs });

        // eslint-disable-next-line no-await-in-loop
        const existing = await request.store.kits.findDuplicate({ userId, ...query });

        if (existing) {
          results.push({
            id,
            kitId: String(existing.id ?? existing._id),
            status: existing.status,
            duplicate: true,
            reason: describeDuplicate(existing),
          });
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        const created = await request.store.kits.create({
          userId,
          input,
          jdHash: query.jdHash,
          status: 'queued',
        });

        const kitId = String(created.id ?? created._id);

        if (startJob) {
          // Not awaited, exactly as single creation is not. The runner's own
          // concurrency decides how many actually build at once; queueing five here
          // does not mean five simultaneous calls to Gemini.
          startJob({ kitId, userId, input, config: request.config, deps: request.deps });
        }

        results.push({ id, kitId, status: 'queued', duplicate: false, reason: 'NO_RECENT_MATCH' });
      }

      const queued = results.filter((entry) => !entry.duplicate).length;

      // 202 whenever anything was accepted for processing. If every case matched an
      // existing kit then nothing was, and that is a 200 — the same distinction single
      // creation makes.
      response.status(queued > 0 ? 202 : 200).json({
        accepted: queued,
        duplicates: results.length - queued,
        kits: results,
        ...(queued === 0 ? { message: duplicateMessage(windowMs) } : {}),
      });
    })
  );

  /**
   * POST /api/kits/:id/resume — continue an interrupted generation.
   *
   * WHAT "INTERRUPTED" MEANS. A kit that failed, or one left `running` by a process
   * that died. Not a `ready` kit — that one is finished, and "resuming" it would mean
   * rebuilding a kit the user already has while spending a fresh twelve calls. Not a
   * `queued` one either: it has not started, so it has nothing to continue from and is
   * already going to run.
   *
   * WHY IT IS CHEAPER THAN STARTING AGAIN. `buildKit` takes `resumeFrom` and treats
   * every research step as "if this is not already in state, do it", so a resume is an
   * overlay rather than a second code path. The saved page cache goes back in too, so a
   * company site crawled before the interruption is not fetched again. Measured in
   * Stage 7: eight model calls became one and eight HTTP fetches became zero.
   *
   * A CHECKPOINT FROM A DIFFERENT POSTING IS REFUSED, by core, on its own input
   * fingerprint. This route does not re-check that — duplicating the guard would create
   * a second answer to the same question.
   *
   * IT SPENDS QUOTA, so it takes the generation limiter like creation does.
   */
  app.post(
    '/api/kits/:id/resume',
    requireAuth,
    rateLimit,
    withOwnedKit(),
    route(async (request, response) => {
      const kitDoc = request.kit;
      const kitId = String(kitDoc.id ?? kitDoc._id);

      if (kitDoc.status === 'ready') {
        throw new ApiError(
          'KIT_ALREADY_READY',
          'This kit finished building. Regenerate a section if you want different ' +
            'content — resuming would rebuild a kit you already have and spend the quota twice.'
        );
      }
      if (kitDoc.status === 'queued') {
        throw new ApiError(
          'KIT_NOT_STARTED',
          'This kit is queued and has not started yet, so there is nothing to resume.'
        );
      }
      if (!startJob) {
        throw new ApiError('GENERATION_UNAVAILABLE', 'No build runner is configured.');
      }

      /**
       * `fresh: true` asks for a rebuild from the start, ignoring any checkpoint.
       *
       * Without it this endpoint has one behaviour that depends on hidden state — it
       * resumes when a checkpoint exists and starts over when it does not — so a client
       * cannot offer "continue" and "start over" as distinct actions, only one button
       * whose effect it has to explain afterwards. The flag is what makes the two real.
       *
       * Boolean or absent. A string "true" is refused rather than coerced, because
       * silently accepting it would make `fresh: "false"` start a rebuild.
       */
      const fresh = request.body?.fresh;
      if (fresh !== undefined && typeof fresh !== 'boolean') {
        throw new ApiError('VALIDATION_FAILED', 'fresh must be true or false.');
      }

      const resumable = Boolean(kitDoc.checkpoint) && fresh !== true;

      // Cleared before requeueing, and in the same write that marks it queued. A failed
      // kit that keeps its old error would show the previous failure the whole time the
      // retry is running, which reads as "still broken".
      //
      // A fresh run also DROPS the checkpoint. Leaving it would mean the next ordinary
      // resume picked up a checkpoint the user deliberately abandoned, which is the
      // opposite of what they asked for.
      await request.store.kits.write({
        kitId,
        set: {
          status: 'queued',
          error: { code: null, message: null, at: null },
          ...(fresh === true ? { checkpoint: null } : {}),
        },
        push: {
          progress: {
            step: 'resume',
            status: 'started',
            detail: { from: resumable ? 'checkpoint' : 'the beginning' },
            at: new Date(),
          },
        },
      });

      startJob({
        kitId,
        userId: request.session.userId,
        input: kitDoc.input,
        config: request.config,
        deps: request.deps,
        // Core loads the record itself and refuses one whose fingerprint does not match
        // this posting. Passing the id rather than the record keeps that guard in one place.
        resumeFrom: resumable ? kitId : null,
      });

      response.status(202).json({
        kitId,
        status: 'queued',
        // Said plainly, because the two cost very different amounts: without a
        // checkpoint this is a full rebuild, and the user is entitled to know that
        // before it spends their day's quota.
        resumedFrom: resumable ? 'checkpoint' : 'the beginning',
        message: resumable
          ? 'Continuing from the last checkpoint. Completed steps will be skipped.'
          : fresh === true
            ? 'Starting again from the beginning, as asked. Any saved checkpoint was discarded.'
            : 'No checkpoint was saved for this kit, so it will build again from the start.',
      });
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

        // WHETHER there is a checkpoint, never the checkpoint itself — it holds every
        // expensive intermediate output and would make this response megabytes.
        //
        // The client needs the boolean to be honest about its own buttons: offering
        // "continue from the last checkpoint" when none was saved promises a saving
        // that does not exist, and the user only finds out after spending the quota.
        hasCheckpoint: Boolean(kit.checkpoint),
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
