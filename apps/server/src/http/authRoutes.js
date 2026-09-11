/**
 * authRoutes.js — register, log in, log out, and report who you are.
 *
 * Decides: the four auth endpoints and their responses.
 *
 * Does NOT decide: how a session is signed or read (session.js), or how a password is
 * hashed (passwords.js). A route that did its own crypto would be a route where a
 * mistake is invisible.
 *
 * AUTH IS MINIMAL BY INSTRUCTION: no email verification, no password reset, no roles.
 * That is a smaller surface, and a smaller surface is one with fewer places to be wrong.
 * What it is NOT is an excuse for a weak version of what remains — the password is
 * hashed with bcrypt, the cookie is httpOnly and sameSite, and login says nothing about
 * which half of the credentials was wrong.
 *
 * REGISTRATION AND LOGIN BOTH SPEAK CAREFULLY.
 *   Login returns one message for a wrong email and a wrong password. Distinguishing
 *   them turns the login form into an account-existence oracle — "this email is not
 *   registered" tells an attacker exactly which addresses to try elsewhere.
 *   Registration cannot hide that an email is taken, because the user has to be told
 *   why they cannot proceed. That asymmetry is deliberate and standard.
 */

import { route, ApiError } from './errors.js';
import { validateCredentials } from './validate.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { issueSession, clearSession } from '../auth/session.js';

/**
 * Mount the auth routes.
 *
 * @param {import('express').Express} app
 * @param {{ rateLimit?: Function }} [options] middleware applied to the write routes
 */
export function mountAuthRoutes(app, { rateLimit = (request, response, next) => next() } = {}) {
  /**
   * POST /api/auth/register
   *
   * Creates the account and signs the person in, because requiring a separate login
   * immediately after registering is a step that exists only to annoy.
   */
  app.post(
    '/api/auth/register',
    rateLimit,
    route(async (request, response) => {
      const { email, password } = validateCredentials(request.body);

      const existing = await request.store.users.findByEmail(email);
      if (existing) {
        // Unavoidable disclosure: the user must be told why they cannot register.
        throw new ApiError('EMAIL_TAKEN', 'An account with that email already exists. Sign in instead.');
      }

      const passwordHash = await hashPassword(password);

      let user;
      try {
        user = await request.store.users.create({ email, passwordHash });
      } catch (error) {
        // Two registrations racing on the same address: the unique index catches what
        // the check above could not, because between them another request can land.
        if (error?.code === 11000 || error?.code === 'DUPLICATE_EMAIL') {
          throw new ApiError('EMAIL_TAKEN', 'An account with that email already exists. Sign in instead.');
        }
        throw error;
      }

      issueSession(response, { userId: String(user.id ?? user._id), config: request.config });

      response.status(201).json({ user: { id: String(user.id ?? user._id), email: user.email } });
    })
  );

  /**
   * POST /api/auth/login
   */
  app.post(
    '/api/auth/login',
    rateLimit,
    route(async (request, response) => {
      const { email, password } = validateCredentials(request.body);

      const user = await request.store.users.findByEmail(email);

      // Hash even when the user does not exist. Without this, a missing account returns
      // in microseconds and a real one takes the bcrypt work factor — a timing
      // difference large enough to enumerate addresses over the network.
      const hash = user?.passwordHash ?? (await hashPassword.dummyHash());
      const ok = await verifyPassword(password, hash);

      if (!user || !ok) {
        throw new ApiError('INVALID_CREDENTIALS', 'That email and password do not match an account.');
      }

      issueSession(response, { userId: String(user.id ?? user._id), config: request.config });

      response.json({ user: { id: String(user.id ?? user._id), email: user.email } });
    })
  );

  /**
   * POST /api/auth/logout
   *
   * Always succeeds. Logging out when already logged out is the state the caller wanted,
   * and returning an error for it only ever produces a confusing UI.
   */
  app.post(
    '/api/auth/logout',
    route(async (request, response) => {
      clearSession(response, { config: request.config });
      response.json({ ok: true });
    })
  );

  /**
   * GET /api/auth/me
   *
   * The frontend's "am I signed in?" call. A missing or expired session is a 401 with a
   * code the client can branch on, not an empty 200 — which would make "signed out" and
   * "signed in as nobody" indistinguishable.
   */
  app.get(
    '/api/auth/me',
    route(async (request, response) => {
      if (!request.session?.userId) {
        throw new ApiError('NOT_AUTHENTICATED', 'You are not signed in.');
      }

      const user = await request.store.users.findById(request.session.userId);
      if (!user) {
        // The session is valid but the account is gone. Clear the cookie so the client
        // stops presenting a credential that can never work again.
        clearSession(response, { config: request.config });
        throw new ApiError('SESSION_INVALID', 'Your account no longer exists. Sign in again.');
      }

      response.json({ user: { id: String(user.id ?? user._id), email: user.email } });
    })
  );

  return app;
}
