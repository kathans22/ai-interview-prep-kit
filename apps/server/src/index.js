#!/usr/bin/env node
/**
 * index.js — the server entry point.
 *
 * Decides: the order in which a process becomes ready to serve, and what makes it
 * refuse to start.
 *
 * Does NOT decide: anything a route does. Everything here is assembly — the pieces were
 * all built in Stages 8, 9 and 10 and each already knows its own job.
 *
 * THIS FILE'S ABSENCE WAS THE LARGEST GAP IN THE PROJECT. Every route, guard, session
 * and limiter existed and was tested, and none of them could be reached, because no
 * process ever started them. The root `dev:server` script has pointed at this path since
 * Stage 0 (CF-012). Three consequences all had the same single cause:
 *   - MongoDB was never connected, so no collection was ever created
 *   - `configureLimiter` was never called, so the API would have paced nothing (CF-024)
 *   - `reclaimStale` was never called, so a restart orphaned running kits (CF-049)
 *
 * BOOT ORDER IS NOT ARBITRARY:
 *   1. config      — a fatal misconfiguration should cost nothing to discover
 *   2. limiter     — before any code path can make a model call
 *   3. database    — before anything that would queue a query against no connection
 *   4. reclaim     — before serving, so a user never sees a spinner nothing will finish
 *   5. routes      — assembled once
 *   6. listen      — last, because accepting a request the process cannot serve is worse
 *                    than not accepting it
 *
 * IT REFUSES TO START RATHER THAN LIMP. A server that boots without its database serves
 * 500s that look like application bugs, and a server that boots without its limiter
 * silently burns a 20-a-day quota. Both are failures that cost more to diagnose later
 * than to refuse now.
 */

import process from 'node:process';

import { configureLimiter, isLimiterConfigured } from '@aipk/core/llm/limiter.js';
import { createGeminiProvider } from '@aipk/core/llm/provider.js';
import { buildKit } from '@aipk/core/orchestrator/buildKit.js';

import { loadConfigOrExit } from './config/env.js';
import { createApp } from './http/app.js';
import { mountAuthRoutes } from './http/authRoutes.js';
import { mountKitRoutes } from './http/kitRoutes.js';
import { mountProgressRoutes } from './http/progressRoutes.js';
import { mountEditRoutes } from './http/editRoutes.js';
import { mountRegenerateRoutes } from './http/regenerateRoutes.js';
import { mountPracticeRoutes } from './http/practiceRoutes.js';
import { createLimiters } from './http/rateLimit.js';
import { sessionMiddleware } from './auth/session.js';
import { createMongoStore, connectMongo, disconnectMongo } from './store/mongoStore.js';
import { createJobRunner } from './jobs/buildJob.js';
import { createRunContext } from './cli/runCase.js';

/** Log line. Plain text on stdout — a process manager captures it; core never logs. */
function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

/**
 * Assemble and start.
 *
 * Exported so a test can boot a real server against a scratch database without spawning
 * a process, and so nothing here runs merely because the module was imported.
 */
export async function start({ env = process.env, provider: injectedProvider = null } = {}) {
  // --- 1. configuration -----------------------------------------------------
  const config = loadConfigOrExit(env);

  // --- 2. the limiter, before anything can make a model call ----------------
  // Until this runs, `getLimiter()` returns a pass-through and every request goes out
  // unpaced. That is not theoretical: the limiter had no call site at all until Stage 10
  // (BUG-019), and this is the boot half of CF-024.
  if (!isLimiterConfigured()) {
    configureLimiter({
      rpm: config.gemini.rpm,
      tpm: config.gemini.tpm,
      rpd: config.gemini.rpd,
    });
    log(
      `limiter configured: ${config.gemini.rpm} rpm, ${config.gemini.tpm} tpm, ` +
        `${config.gemini.rpd} rpd`
    );
  }

  // --- 3. the database ------------------------------------------------------
  const connection = await connectMongo(config.mongodbUri);
  log(`mongodb connected: database "${connection.name}"`);

  const store = createMongoStore();

  // --- 4. reclaim what a previous process left running ----------------------
  // The job runner is in-process, so a kit left `running` when the process died would
  // stay that way for ever — a spinner nothing will ever finish (CF-049).
  const reclaimed = await store.kits.reclaimStale();
  if (reclaimed > 0) log(`reclaimed ${reclaimed} kit(s) left running by a previous process`);

  // --- 5. routes ------------------------------------------------------------
  // Injectable so an integration test can boot the REAL server — real routes, real
  // database, real job runner — without spending a model call. Without this the only
  // way to exercise a boot is to let it generate, and a kit costs nine calls out of
  // twenty a day. Production passes nothing and gets the real client.
  const provider =
    injectedProvider ??
    createGeminiProvider({
      apiKey: config.gemini.apiKey,
      model: config.gemini.model,
      maxOutputTokens: config.gemini.maxOutputTokens,
    });

  const app = createApp({ store, config, deps: { provider }, log });
  app.use(sessionMiddleware());

  // The build a job runs is the SAME `buildKit` the CLI calls, with the same dependency
  // set — `createRunContext` is what assembles it. A second wiring here would be a
  // second pipeline, which is the one thing the monorepo exists to prevent.
  const runContext = createRunContext({ config, provider });

  const jobs = createJobRunner({
    store,
    concurrency: config.budgets.batchConcurrency,
    // The runner calls `build(input, deps, hooks)`. Its `deps` carries only what the
    // route had on the request, so the shared retrieval collaborators are taken from
    // the run context instead — the same set the CLI builds. The per-kit budget and
    // governor are left to `buildKit`'s own defaults, which read the numbers passed
    // here, because those must not be shared between concurrent builds.
    build: async (input, _deps, hooks) =>
      buildKit(
        input,
        {
          provider: runContext.provider,
          fetcher: runContext.fetcher,
          robots: runContext.robots,
          cache: runContext.cache,
          searchProvider: runContext.searchProvider,
          maxLlmCallsPerKit: config.budgets.maxLlmCallsPerKit,
          caseSoftDeadlineMs: config.budgets.caseSoftDeadlineMs,
          crawlMaxPages: config.retrieval.crawlMaxPages,
          crawlMaxDepth: config.retrieval.crawlMaxDepth,
          crawlConcurrency: config.retrieval.crawlConcurrency,
        },
        hooks
      ),
  });

  const limiters = createLimiters();

  app.mountRoutes((instance) => {
    mountAuthRoutes(instance, { rateLimit: limiters.auth });
    mountKitRoutes(instance, {
      startJob: (job) => jobs.start(job),
      rateLimit: limiters.generation,
    });
    mountProgressRoutes(instance, { jobs });
    mountEditRoutes(instance);
    // Regeneration spends model calls, so it shares the generation limiter with
    // creation — its own header says a few clicks is a day of quota.
    mountRegenerateRoutes(instance, { rateLimit: limiters.generation });
    // Practice ratings cost nothing and are not limited: refusing to record that
    // someone revised would be limiting the wrong thing.
    mountPracticeRoutes(instance);
  });

  // Installs the 404 and the error handler. Anything mounted after this is unreachable.
  app.finalise();

  // --- 6. listen ------------------------------------------------------------
  const server = app.listen(config.server.port);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  log(`listening on http://localhost:${server.address().port} (${config.env})`);
  log(`cors origin: ${config.server.webOrigin}`);

  /**
   * Shut down without dropping work.
   *
   * Stop accepting connections, let in-flight builds finish, then close the database.
   * Closing the database first would fail every write a running build still needs to
   * make, turning a clean restart into a set of half-written kits.
   */
  async function shutdown(signal) {
    log(`${signal} received, shutting down`);
    server.close();
    try {
      await jobs.drain();
    } catch (error) {
      log(`drain failed: ${error?.message ?? error}`);
    }
    await disconnectMongo();
    log('shutdown complete');
  }

  return { app, server, store, jobs, connection, shutdown };
}

/**
 * Direct execution.
 *
 * `pathToFileURL`, never a hand-built `file://` + path — on Windows the hand-built form
 * never matches `import.meta.url` (slash count, and `%20` for a space in the path), so
 * the process would start nothing and exit 0. That is BUG-016, which silently made the
 * batch command a no-op.
 */
const { pathToFileURL } = await import('node:url');
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    const { shutdown } = await start();
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        shutdown(signal).then(
          () => process.exit(0),
          () => process.exit(1)
        );
      });
    }
  } catch (error) {
    process.stderr.write(`Server failed to start: ${error?.message ?? error}\n`);
    process.exit(1);
  }
}
