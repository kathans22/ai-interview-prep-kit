/**
 * cors.test.js — how the deployed API treats a cross-origin browser.
 *
 * Decides, over real HTTP against the real app and auth routes:
 *   - only the configured web origin gets CORS headers, with credentials
 *   - a preflight is answered for that origin and for nobody else
 *   - a state-changing request from any other site is refused before a route runs (CSRF)
 *   - the production session cookie is Secure, HttpOnly and SameSite=None; the local one
 *     is HttpOnly and SameSite=Lax without Secure
 *   - WEB_ORIGIN is normalised to an exact origin, and must be https in production
 *
 * Does NOT decide: that a real browser keeps the cookie. That is checked on the deployment.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/http/app.js';
import { mountAuthRoutes } from '../src/http/authRoutes.js';
import { sessionMiddleware, cookiePolicy } from '../src/auth/session.js';
import { createMemoryStore } from '../src/store/memoryStore.js';
import { validateEnv } from '../src/config/env.js';

const WEB = 'https://prep-kit.netlify.app';
const EVIL = 'https://evil.example';

const servers = [];
after(() => {
  for (const server of servers) server.close();
});

/** A running app with the auth routes, in production or local mode. */
async function startApp({ isProduction }) {
  const config = {
    env: isProduction ? 'production' : 'development',
    isProduction,
    sessionSecret: 's'.repeat(64),
    server: { port: 0, webOrigin: WEB, trustProxyHops: 1 },
    budgets: { idempotencyWindowMs: 900_000, maxLlmCallsPerKit: 12 },
  };
  const app = createApp({ store: createMemoryStore(), config, log: () => {} });
  app.use(sessionMiddleware());
  app.mountRoutes((instance) => mountAuthRoutes(instance));
  app.finalise();

  const server = app.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return (path, { origin, method = 'GET', body, headers = {} } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        ...(origin ? { origin } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
}

const call = await startApp({ isProduction: true });
const local = await startApp({ isProduction: false });

let emailCount = 0;
const newAccount = () => ({ email: `cors${(emailCount += 1)}@example.com`, password: 'a long enough password' });

// ===========================================================================
// CORS
// ===========================================================================

test('the web origin gets CORS headers with credentials; any other origin gets none', async () => {
  const allowed = await call('/api/health', { origin: WEB });
  assert.equal(allowed.headers.get('access-control-allow-origin'), WEB);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
  assert.match(allowed.headers.get('vary'), /Origin/);

  const other = await call('/api/health', { origin: EVIL });
  assert.equal(other.status, 200, 'a read is served — the browser simply cannot see it');
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  assert.equal(other.headers.get('access-control-allow-credentials'), null);
  assert.match(other.headers.get('vary'), /Origin/, 'varied even when refused, so no cache mixes them');

  // Never a wildcard, and never a reflection of whatever was sent.
  const sneaky = await call('/api/health', { origin: `${WEB}.evil.example` });
  assert.equal(sneaky.headers.get('access-control-allow-origin'), null);
});

test('a preflight is answered for the web origin only', async () => {
  const preflight = await call('/api/kits', {
    method: 'OPTIONS',
    origin: WEB,
    headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), WEB);
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
  assert.match(preflight.headers.get('access-control-allow-methods'), /PATCH/);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'content-type');

  const refused = await call('/api/kits', {
    method: 'OPTIONS',
    origin: EVIL,
    headers: { 'access-control-request-method': 'POST' },
  });
  assert.equal(refused.headers.get('access-control-allow-origin'), null);
  assert.equal(refused.headers.get('access-control-allow-methods'), null, 'nothing to act on');
});

// ===========================================================================
// CSRF — what SameSite=None gave up, restored
// ===========================================================================

test('a state-changing request from another site is refused before any route runs', async () => {
  const response = await call('/api/auth/register', { method: 'POST', origin: EVIL, body: newAccount() });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, 'ORIGIN_NOT_ALLOWED');
  assert.equal(response.headers.get('set-cookie'), null, 'no account, no session');

  // The same request from the web client, and from a client that sends no Origin at all
  // (same-origin through the proxy, or not a browser), both go through.
  assert.equal((await call('/api/auth/register', { method: 'POST', origin: WEB, body: newAccount() })).status, 201);
  assert.equal((await call('/api/auth/register', { method: 'POST', body: newAccount() })).status, 201);
});

test('a read from another site is not refused — CORS already keeps the answer from it', async () => {
  assert.equal((await call('/api/health', { origin: EVIL })).status, 200);
});

// ===========================================================================
// The session cookie
// ===========================================================================

function cookieAttributes(response) {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'a cookie was set');
  return header.split(';').map((part) => part.trim());
}

test('in production the session cookie is Secure, HttpOnly and SameSite=None', async () => {
  const response = await call('/api/auth/register', { method: 'POST', origin: WEB, body: newAccount() });
  const attributes = cookieAttributes(response);

  assert.ok(attributes.includes('HttpOnly'));
  assert.ok(attributes.includes('Secure'));
  assert.ok(attributes.includes('SameSite=None'));
  assert.ok(!attributes.includes('SameSite=Lax'));

  // Logging out clears it with the SAME attributes — a mismatched clear leaves the
  // original cookie in place in some browsers.
  const [session] = response.headers.get('set-cookie').split(';');
  const logout = await call('/api/auth/logout', { method: 'POST', origin: WEB, headers: { cookie: session } });
  const cleared = cookieAttributes(logout);
  assert.ok(cleared.includes('Max-Age=0'));
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=None']) assert.ok(cleared.includes(attribute), attribute);
});

test('locally the cookie is HttpOnly and SameSite=Lax, without Secure', async () => {
  const response = await local('/api/auth/register', { method: 'POST', body: newAccount() });
  const attributes = cookieAttributes(response);

  assert.ok(attributes.includes('HttpOnly'));
  assert.ok(attributes.includes('SameSite=Lax'));
  assert.ok(!attributes.includes('Secure'), 'a Secure cookie over plain http is never sent back');
  assert.deepEqual(cookiePolicy({ isProduction: false }), { secure: false, sameSite: 'Lax' });
  assert.deepEqual(cookiePolicy({ isProduction: true }), { secure: true, sameSite: 'None' });
});

// ===========================================================================
// WEB_ORIGIN
// ===========================================================================

function env(overrides) {
  return {
    NODE_ENV: 'production', PORT: '10000', WEB_ORIGIN: WEB, TRUST_PROXY_HOPS: '2',
    MONGODB_URI: 'mongodb+srv://u:p@c.example.net/ai_interview_prep_kit', SESSION_SECRET: 'x'.repeat(44),
    GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-3.5-flash-lite', GEMINI_RPM: '15', GEMINI_TPM: '250000',
    GEMINI_RPD: '500', LLM_MAX_OUTPUT_TOKENS: '8192', MAX_LLM_CALLS_PER_KIT: '12',
    CASE_SOFT_DEADLINE_MS: '150000', BATCH_CONCURRENCY: '2', IDEMPOTENCY_WINDOW_MS: '900000',
    SEARCH_PROVIDER: 'none', ALLOW_PRIVATE_HOSTS: 'false', CRAWL_MAX_PAGES: '12', CRAWL_CONCURRENCY: '3',
    FETCH_TIMEOUT_MS: '10000', FETCH_MAX_BYTES: '2000000',
    ...overrides,
  };
}

test('WEB_ORIGIN is normalised to the exact origin a browser sends', () => {
  for (const written of [`${WEB}/`, ` ${WEB} `, 'HTTPS://Prep-Kit.Netlify.App/']) {
    const result = validateEnv(env({ WEB_ORIGIN: written }));
    assert.equal(result.ok, true, written);
    assert.equal(result.config.server.webOrigin, WEB, written);
  }
});

test('WEB_ORIGIN with a path is refused, and production demands https', () => {
  const withPath = validateEnv(env({ WEB_ORIGIN: `${WEB}/app` }));
  assert.equal(withPath.ok, false);
  assert.ok(withPath.problems.some((entry) => entry.name === 'WEB_ORIGIN' && entry.code === 'CONFIG_MALFORMED'));

  const insecure = validateEnv(env({ WEB_ORIGIN: 'http://prep-kit.netlify.app' }));
  assert.equal(insecure.ok, false);
  assert.ok(insecure.problems.some((entry) => entry.code === 'CONFIG_INSECURE_ORIGIN'));

  assert.equal(
    validateEnv(env({ NODE_ENV: 'development', ALLOW_PRIVATE_HOSTS: 'true', WEB_ORIGIN: 'http://localhost:5173' })).ok,
    true,
    'plain http is fine locally'
  );
});
