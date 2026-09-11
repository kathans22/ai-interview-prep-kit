/**
 * session.js — who is making this request?
 *
 * Decides: the cookie's contents, how it is signed, when it expires, and what an invalid
 * one means.
 *
 * Does NOT decide: what a signed-in user may do. That is ownership, checked per kit.
 *
 * A SIGNED STATELESS COOKIE, NOT A SESSION STORE. The cookie holds a user id and an
 * expiry, signed with SESSION_SECRET using HMAC-SHA256. No `express-session`, no
 * `connect-mongo`, no server-side session collection.
 *
 *   Why: the whole HTTP surface stays testable without a running MongoDB, there is no
 *   session table to expire or index, and a horizontally-scaled deploy needs no shared
 *   session store. Two fewer dependencies in the auth path is two fewer things to audit.
 *
 *   The cost, stated plainly: a stateless session CANNOT BE REVOKED SERVER-SIDE. Logging
 *   out clears the cookie on that browser; a cookie already copied elsewhere stays valid
 *   until it expires. That is why the lifetime is a week rather than a year, and why a
 *   password change would need a rotation scheme if this project ever grew one. For an
 *   app with no password reset and no roles, it is the right trade — but it is a trade,
 *   not a free win.
 *
 * THE COOKIE IS httpOnly AND sameSite=lax. httpOnly puts it out of reach of JavaScript,
 * so an XSS flaw cannot read it. sameSite=lax means it is not attached to cross-site
 * POSTs, which is CSRF protection for every mutating endpoint here without a token
 * scheme. `secure` follows NODE_ENV: on in production, off locally, because a secure
 * cookie over plain http is simply never sent and the symptom is "login silently does
 * nothing".
 *
 * SIGNATURE COMPARISON IS CONSTANT-TIME. A fast `===` on an HMAC leaks, byte by byte,
 * how much of a forged signature was right.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'aipk_session';

/** A week. Long enough not to annoy, short enough to bound an un-revocable cookie. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Why a session was rejected. The client branches on these. */
export const SESSION_ERRORS = Object.freeze({
  MISSING: 'NOT_AUTHENTICATED',
  INVALID: 'SESSION_INVALID',
  EXPIRED: 'SESSION_EXPIRED',
});

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Constant-time compare of two base64url signatures. */
function signaturesMatch(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch, which would itself be a length oracle.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Build the cookie value: `<userId>.<expiresAt>.<signature>`.
 *
 * The expiry is inside the signed payload, not only in the cookie's own Max-Age. A
 * client controls its cookie jar completely and can keep sending an "expired" cookie
 * forever; only a server-verified expiry actually expires anything.
 */
export function encodeSession({ userId, expiresAt, secret }) {
  const payload = `${userId}.${expiresAt}`;
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Read and verify a cookie value.
 *
 * @returns {{ ok: true, userId: string, expiresAt: number } | { ok: false, reason: string }}
 */
export function decodeSession(value, { secret, now = Date.now } = {}) {
  if (typeof value !== 'string' || value === '') return { ok: false, reason: SESSION_ERRORS.MISSING };

  const parts = value.split('.');
  if (parts.length !== 3) return { ok: false, reason: SESSION_ERRORS.INVALID };

  const [userId, expiresRaw, signature] = parts;
  const payload = `${userId}.${expiresRaw}`;

  if (!signaturesMatch(signature, sign(payload, secret))) {
    return { ok: false, reason: SESSION_ERRORS.INVALID };
  }

  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: SESSION_ERRORS.INVALID };
  // Checked AFTER the signature: an unsigned cookie should never be told whether its
  // made-up expiry was in the past or the future.
  if (expiresAt <= now()) return { ok: false, reason: SESSION_ERRORS.EXPIRED };

  if (!userId) return { ok: false, reason: SESSION_ERRORS.INVALID };

  return { ok: true, userId, expiresAt };
}

/** Serialise a Set-Cookie header. Written by hand to avoid a cookie dependency. */
function cookieHeader(name, value, { maxAgeMs, secure, path = '/' }) {
  const parts = [
    `${name}=${value}`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Set the session cookie on a response. */
export function issueSession(response, { userId, config, now = Date.now, ttlMs = SESSION_TTL_MS }) {
  const expiresAt = now() + ttlMs;
  const value = encodeSession({ userId, expiresAt, secret: config.sessionSecret });

  response.setHeader(
    'set-cookie',
    cookieHeader(SESSION_COOKIE, value, { maxAgeMs: ttlMs, secure: config.isProduction })
  );
  return { userId, expiresAt };
}

/** Clear it. Same attributes, empty value, zero lifetime — anything else may not replace it. */
export function clearSession(response, { config }) {
  response.setHeader(
    'set-cookie',
    cookieHeader(SESSION_COOKIE, '', { maxAgeMs: 0, secure: config.isProduction })
  );
}

/** Parse a Cookie header without a dependency. */
export function parseCookies(header) {
  const jar = {};
  if (typeof header !== 'string') return jar;

  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    const name = pair.slice(0, index).trim();
    if (name === '') continue;
    jar[name] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return jar;
}

/**
 * Middleware: read the session if there is one.
 *
 * Deliberately does NOT reject. Some routes are public, and a middleware that 401s
 * everything would have to know which. `request.session` is set or it is not;
 * `requireAuth` decides what that means.
 */
export function sessionMiddleware({ now = Date.now } = {}) {
  return function readSession(request, response, next) {
    const cookies = parseCookies(request.headers.cookie);
    const result = decodeSession(cookies[SESSION_COOKIE], {
      secret: request.config.sessionSecret,
      now,
    });

    request.session = result.ok ? { userId: result.userId, expiresAt: result.expiresAt } : null;
    // Kept so requireAuth can say WHY — "your session expired" and "that cookie is not
    // valid" send a user to different places.
    request.sessionError = result.ok ? null : result.reason;
    next();
  };
}
