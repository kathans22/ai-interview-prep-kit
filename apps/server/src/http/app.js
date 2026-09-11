/**
 * app.js — the Express application, assembled from injected parts.
 *
 * Decides: middleware order, what a request may contain, and where routes are mounted.
 *
 * Does NOT decide: how a kit is built, stored or merged. Routes validate, call core or a
 * store, and map the result. Anything longer than that belongs in `@aipk/core` — the
 * monorepo exists so the CLI and this app run the same code, and logic that lives in a
 * route is logic the CLI cannot reach.
 *
 * EVERYTHING IS INJECTED, INCLUDING THE STORE. `createApp({ store, ... })` takes its
 * persistence as a collaborator rather than importing Mongoose models directly. That is
 * not ceremony: it means the whole HTTP surface — auth, ownership, revision conflicts,
 * 401s — is testable in-process with an in-memory store, so `npm test` needs no running
 * MongoDB. A test suite that requires a database is a suite that stops being run.
 *
 * MIDDLEWARE ORDER IS LOAD-BEARING:
 *   1. request id      so every log line and error can be tied to one request
 *   2. CORS            before anything that might reject, or the browser sees a CORS
 *                      error instead of the 401 that actually happened
 *   3. body parsing    with a size cap
 *   4. session         reads the cookie; does not require one
 *   5. routes          each decides for itself whether auth is required
 *   6. 404             anything unmatched
 *   7. error handler   last, four arguments
 */

import express from 'express';

import { ApiError, createErrorHandler, notFound } from './errors.js';

/** A JD is the largest thing a client legitimately sends. */
export const MAX_BODY_BYTES = 512 * 1024;

/**
 * Build the app.
 *
 * @param {object} options
 * @param {object} options.store persistence, injected — see `createMongoStore`
 * @param {object} options.config validated config (`apps/server/src/config/env.js`)
 * @param {object} [options.deps] collaborators for generation: provider, fetcher, etc.
 * @param {Function} [options.log]
 * @returns {import('express').Express}
 */
export function createApp({ store, config, deps = {}, log = console.error } = {}) {
  if (!store) throw new Error('APP_NOT_CONFIGURED: createApp requires a store.');
  if (!config) throw new Error('APP_NOT_CONFIGURED: createApp requires a validated config.');

  const app = express();

  // Express advertises itself by default. There is no reason to tell the internet which
  // framework and version to look up exploits for.
  app.disable('x-powered-by');

  // Trust the proxy in production so `secure` cookies and client IPs work behind one.
  // Left off locally, where there is no proxy and trusting a forwarded header would let
  // any client claim any IP — which would defeat the rate limiter.
  if (config.isProduction) app.set('trust proxy', 1);

  // --- 1. request id -------------------------------------------------------
  app.use((request, response, next) => {
    request.id = globalThis.crypto.randomUUID();
    response.setHeader('x-request-id', request.id);
    next();
  });

  // --- 2. CORS, with credentials ------------------------------------------
  // Exactly one origin, never a wildcard: cookies are sent with credentials, and
  // `Access-Control-Allow-Origin: *` is invalid with credentials anyway. Reflecting the
  // caller's origin would make the allowlist decorative.
  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (origin && origin === config.server.webOrigin) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('access-control-allow-credentials', 'true');
      response.setHeader('vary', 'Origin');
    }
    response.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    response.setHeader('access-control-allow-headers', 'content-type');

    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }
    next();
  });

  // --- 3. body parsing -----------------------------------------------------
  app.use(
    express.json({
      limit: MAX_BODY_BYTES,
      // A body that is not JSON is a client fault worth naming, not a parser crash.
      verify: (request, response, buffer) => {
        request.rawBodyLength = buffer.length;
      },
    })
  );

  // Turn body-parser's own failures into our error shape before they reach the handler
  // as anonymous 400s with an HTML body.
  app.use((error, request, response, next) => {
    if (error?.type === 'entity.too.large') {
      next(new ApiError('PAYLOAD_TOO_LARGE', `Request body exceeds ${MAX_BODY_BYTES} bytes.`));
      return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
      next(new ApiError('VALIDATION_FAILED', 'Request body is not valid JSON.'));
      return;
    }
    next(error);
  });

  // Make the injected collaborators reachable from any route without a module-level
  // singleton — which would be the one thing preventing two apps in one test process.
  app.use((request, response, next) => {
    request.store = store;
    request.config = config;
    request.deps = deps;
    next();
  });

  // --- health --------------------------------------------------------------
  // Deliberately unauthenticated and deliberately dull: it reports that the process is
  // up, not whether the database or Gemini are, because a health check that depends on
  // a third party reports someone else's outage as our own.
  app.get('/api/health', (request, response) => {
    response.json({ ok: true, env: config.env, at: new Date().toISOString() });
  });

  // Route groups are attached by the caller via app.mountRoutes(...) as they are built,
  // so this module never grows a list of imports it has to keep in order.
  app.mountRoutes = (mount) => {
    mount(app);
    return app;
  };

  /** Finalise: 404 then the error handler. Called once, after all routes are mounted. */
  app.finalise = () => {
    app.use((request, response, next) => {
      next(notFound(`No route for ${request.method} ${request.path}.`));
    });
    app.use(createErrorHandler({ log }));
    return app;
  };

  return app;
}
