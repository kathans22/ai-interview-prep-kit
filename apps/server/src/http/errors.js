/**
 * errors.js — one shape for every failure the API returns.
 *
 * Decides: the response body for an error, and which HTTP status each internal code maps
 * to.
 *
 * Does NOT decide: what went wrong. Core and the models raise coded errors; this
 * translates them for HTTP. The translation table is the only place that knows an
 * `LLM_RATE_LIMITED` is a 503 to a browser and a `STALE_REVISION` is a 409.
 *
 * EVERY ERROR IS `{ error: { code, message } }`. Never a raw stack, never a bare string,
 * never a 500 with an empty body. Three reasons, in order of how much they matter:
 *   - A stack trace in a response leaks file paths, dependency versions and sometimes
 *     input, to anyone who can make the server fail.
 *   - A frontend cannot branch on prose. `STALE_REVISION` is actionable; "Something went
 *     wrong" forces a reload and loses the user's edit.
 *   - A consistent shape means the client has one error path, not one per endpoint.
 *
 * THE MESSAGE IS FOR A PERSON, THE CODE IS FOR THE CLIENT. Messages say what happened and
 * what to do about it, because this API's errors are read by a UI that shows them.
 */

/** Internal code -> HTTP status. Anything unlisted is a 500. */
const STATUS_BY_CODE = Object.freeze({
  // --- client faults -------------------------------------------------------
  VALIDATION_FAILED: 400,
  BUILD_NO_JD: 400,
  BUILD_BAD_DAYS: 400,
  MERGE_UNKNOWN_SECTION: 400,
  UNDO_UNKNOWN_SECTION: 400,
  NOTHING_TO_UNDO: 400,
  INVALID_CREDENTIALS: 401,
  NOT_AUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  SESSION_INVALID: 401,
  FORBIDDEN: 403,
  KIT_NOT_FOUND: 404,
  NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  STALE_REVISION: 409,
  KIT_NOT_READY: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,

  // --- our faults, or the world's ------------------------------------------
  BUILD_FAILED: 500,
  BUILD_NO_REQUIREMENTS: 422,
  BUILD_INVALID_KIT: 500,
  BUILD_INVALID_SCHEDULE: 500,
  GENERATION_INVALID_OUTPUT: 502,
  GENERATION_BAD_INPUT: 400,
  GENERATION_UNAVAILABLE: 503,
  LLM_RATE_LIMITED: 503,
  LLM_UNAVAILABLE: 503,
  LLM_CONTENT_BLOCKED: 422,
  LLM_INVALID_OUTPUT: 502,
  LLM_REQUEST_FAILED: 500,
  LLM_NOT_CONFIGURED: 500,
  BUDGET_EXHAUSTED: 503,
  DATABASE_UNAVAILABLE: 503,
});

/** An error raised deliberately by a route, with the status already decided. */
export class ApiError extends Error {
  constructor(code, message, { status, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code] ?? 500;
    this.details = details ?? null;
  }
}

/** Shorthands for the failures routes raise most. */
export const badRequest = (message, details) => new ApiError('VALIDATION_FAILED', message, { details });
export const notFound = (message = 'Not found.') => new ApiError('NOT_FOUND', message);
export const unauthenticated = (message = 'Sign in to continue.') => new ApiError('NOT_AUTHENTICATED', message);
export const forbidden = (message = 'You do not have access to this.') => new ApiError('FORBIDDEN', message);

/** The status an error should produce. */
export function statusFor(error) {
  if (error?.status && Number.isInteger(error.status)) return error.status;
  return STATUS_BY_CODE[error?.code] ?? 500;
}

/**
 * The body for an error.
 *
 * A 500 deliberately does NOT echo the underlying message. An unexpected failure's text
 * is written for a developer reading a log, and it is exactly the text most likely to
 * contain a file path, a connection string or a fragment of someone's input. Handled
 * errors carry messages written to be read; unhandled ones get a generic line and the
 * real detail goes to the log.
 */
export function errorBody(error, { exposeInternal = false } = {}) {
  const status = statusFor(error);
  const code = error?.code ?? 'INTERNAL_ERROR';

  if (status >= 500 && !isDeliberate(error) && !exposeInternal) {
    return {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something failed on our side. The failure has been logged.',
      },
    };
  }

  const body = { error: { code, message: error?.message ?? 'Request failed.' } };

  // Some failures carry the data a client needs to recover. A stale revision without the
  // current revision forces a blind reload; with it, the client can reapply the edit.
  if (error?.code === 'STALE_REVISION') {
    body.error.currentRevision = error.currentRevision;
    body.error.expectedRevision = error.expectedRevision;
  }
  if (error?.details) body.error.details = error.details;

  return body;
}

/** Was this error raised on purpose, with a message written for a reader? */
function isDeliberate(error) {
  return error instanceof ApiError || typeof error?.code === 'string';
}

/**
 * The Express error handler. Last middleware, four arguments, no exceptions.
 *
 * @param {{ log?: Function }} [options] injected so tests can assert what was logged
 *   without writing to stderr
 */
export function createErrorHandler({ log = console.error } = {}) {
  // eslint-disable-next-line no-unused-vars -- Express identifies the handler by arity.
  return function errorHandler(error, request, response, next) {
    const status = statusFor(error);

    // Log the whole thing on our side; send the sanitised version to the client.
    if (status >= 500) {
      log('[api] unhandled failure', {
        method: request.method,
        path: request.path,
        code: error?.code,
        message: error?.message,
        stack: error?.stack,
      });
    }

    if (response.headersSent) {
      // A stream already started — SSE, most likely. Nothing useful can be sent now, and
      // trying produces a second set of headers and a confusing crash.
      response.end();
      return;
    }

    response.status(status).json(errorBody(error));
  };
}

/**
 * Wrap an async route so a rejected promise reaches the error handler.
 *
 * Express 5 forwards rejections from async handlers on its own, but wrapping is explicit
 * and survives a downgrade — and an unhandled rejection here is a request that hangs
 * until the client times out, which is the worst failure mode available.
 */
export function route(handler) {
  return function wrapped(request, response, next) {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}
