/**
 * redirects.test.js — the static host's rewrite rules, written after `vite build`.
 *
 * The two ways a deployed single-page app breaks silently are both here: a reload of a
 * deep link that 404s, and an /api proxy pointing somewhere subtly wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRedirects, parseApiOrigin, planRedirects } from '../scripts/redirects.js';

test('with an API origin, /api is proxied first and everything else falls back to the app', () => {
  assert.equal(
    buildRedirects({ apiOrigin: 'https://prep-kit-api.onrender.com' }),
    '/api/*  https://prep-kit-api.onrender.com/api/:splat  200!\n/*  /index.html  200\n'
  );
});

test('without one, only the fallback is written', () => {
  assert.equal(buildRedirects(), '/*  /index.html  200\n');
});

test('an API origin is normalised, and anything but an https origin is refused', () => {
  assert.deepEqual(parseApiOrigin(' https://api.example.com/ '), { ok: true, origin: 'https://api.example.com' });
  assert.equal(parseApiOrigin('http://localhost:4000').ok, true, 'plain http is fine for local testing');

  for (const bad of ['', 'api.example.com', 'http://api.example.com', 'https://api.example.com/api', 'https://api.example.com/?x=1']) {
    assert.equal(parseApiOrigin(bad).ok, false, bad);
  }
});

test('on the static host, a build that could reach no API fails instead of publishing', () => {
  const plan = planRedirects({ NETLIFY: 'true' });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /API_ORIGIN/);

  assert.equal(planRedirects({}).ok, true, 'a local build needs neither');
});

test('proxy and direct modes are exclusive, and a bad origin fails the build', () => {
  assert.equal(planRedirects({ API_ORIGIN: 'https://a.example', VITE_API_BASE: 'https://a.example' }).ok, false);
  assert.equal(planRedirects({ NETLIFY: 'true', API_ORIGIN: 'https://a.example/api' }).ok, false);

  const proxy = planRedirects({ NETLIFY: 'true', API_ORIGIN: 'https://a.example' });
  assert.equal(proxy.ok, true);
  assert.match(proxy.content, /^\/api\/\*  https:\/\/a\.example\/api\/:splat  200!$/m);

  const direct = planRedirects({ NETLIFY: 'true', VITE_API_BASE: 'https://a.example' });
  assert.equal(direct.ok, true);
  assert.doesNotMatch(direct.content, /\/api\//, 'calling the API directly needs no proxy rule');
});
