/**
 * requireAuth.js — the guard on every kit route, and the ownership check behind it.
 *
 * Decides: whether a request may proceed, and whether the caller owns the thing they
 * named.
 *
 * Does NOT decide: what they may then do with it. There are no roles and no permissions
 * — ownership is the entire authorisation model, which is why it must be airtight.
 *
 * TWO SEPARATE QUESTIONS, AND CONFLATING THEM IS THE CLASSIC BUG:
 *   `requireAuth`   — is anyone signed in?            401 if not.
 *   `loadOwnedKit`  — is this kit theirs?             404 if not.
 *
 * A MISSING KIT AND SOMEONE ELSE'S KIT RETURN THE SAME 404. This is the important line
 * in the file. Returning 403 for a kit that exists but belongs to another user turns
 * every id into an oracle: an attacker enumerating ids learns exactly which ones are
 * real, and how many kits the service holds. 404 for both means an id reveals nothing.
 * The user experience is identical — a person who does not own a kit has no use for
 * knowing it exists.
 *
 * OWNERSHIP IS ENFORCED IN THE QUERY, NOT AFTER IT. Every lookup filters by `userId`, so
 * a kit belonging to someone else is never loaded into memory in the first place. The
 * alternative — fetch by id, then compare owners — works right up until one route
 * forgets the comparison, and that route is indistinguishable from the others at a
 * glance.
 */

import { ApiError } from '../http/errors.js';

/** 401 messages, by reason, so the client can route the user correctly. */
const MESSAGES = Object.freeze({
  NOT_AUTHENTICATED: 'Sign in to continue.',
  SESSION_EXPIRED: 'Your session has expired. Sign in again.',
  SESSION_INVALID: 'Your session is not valid. Sign in again.',
});

/**
 * Reject anything without a valid session.
 *
 * The 401 body carries the specific code — `SESSION_EXPIRED` sends a user to the login
 * form with an explanation, while `NOT_AUTHENTICATED` may simply mean they have not
 * signed in yet. A single generic 401 makes those indistinguishable to the frontend.
 */
export function requireAuth(request, response, next) {
  if (request.session?.userId) {
    next();
    return;
  }

  const code = request.sessionError ?? 'NOT_AUTHENTICATED';
  next(new ApiError(code, MESSAGES[code] ?? MESSAGES.NOT_AUTHENTICATED));
}

/**
 * Load a kit the caller owns, or 404.
 *
 * @param {object} request must carry `request.session.userId` — mount after requireAuth
 * @param {string} kitId
 * @returns {Promise<object>} the kit document
 * @throws {ApiError} KIT_NOT_FOUND, whether it is missing or simply not theirs
 */
export async function loadOwnedKit(request, kitId) {
  if (typeof kitId !== 'string' || kitId.trim() === '') {
    throw new ApiError('VALIDATION_FAILED', 'A kit id is required.');
  }

  // Scoped by owner in the query itself. Another user's kit is never materialised.
  const kit = await request.store.kits.findOwned({
    kitId,
    userId: request.session.userId,
  });

  if (!kit) {
    // Deliberately identical to the message for a kit that never existed.
    throw new ApiError('KIT_NOT_FOUND', 'No kit with that id.');
  }

  return kit;
}

/**
 * Middleware form: load the kit onto the request for routes that all need it.
 *
 * Saves each handler from repeating the lookup, and — more usefully — makes it
 * impossible for one of them to forget the ownership scope.
 */
export function withOwnedKit(paramName = 'id') {
  return async function loadKit(request, response, next) {
    try {
      request.kit = await loadOwnedKit(request, request.params[paramName]);
      next();
    } catch (error) {
      next(error);
    }
  };
}
