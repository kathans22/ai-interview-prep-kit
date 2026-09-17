/**
 * redirects.js — writes the static host's `_redirects` file after `vite build`.
 *
 * Decides: the two rules a deployed single-page app needs from a static host —
 *   1. `/api/*` proxied to the deployed API, when `API_ORIGIN` is set
 *   2. every other path served `index.html`, so reloading `/kits/abc` is not a 404
 *
 * Does NOT decide: where the API is. That is `API_ORIGIN`, set on the static host at build
 * time, so no deployment URL is committed to the repository.
 *
 * WHY THE PROXY IS THE DEFAULT, when the server is fully configured for a cross-origin
 * client (CORS with credentials, `SameSite=None; Secure` cookies). Safari on iPhone blocks
 * cross-site cookies by default, and so does any browser with third-party cookies turned
 * off: the sign-in response sets the cookie, the browser discards it, and every following
 * request is a 401 that looks like a server bug. Proxied, the API is same-origin and the
 * cookie is first-party everywhere. Pointing `VITE_API_BASE` straight at the API instead
 * still works, in browsers that allow cross-site cookies.
 *
 * Netlify reads `_redirects` from the publish directory; rules match top to bottom, and
 * `200!` rewrites (proxies) rather than redirects, even where a file exists.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Validate an API origin: https (or http for localhost), no path, no query.
 *
 * A trailing path would be doubled into every proxied URL (`/api/api/…`), and a plain
 * http origin would send session cookies over an unencrypted hop.
 *
 * @param {string} raw
 * @returns {{ ok: true, origin: string } | { ok: false, reason: string }}
 */
export function parseApiOrigin(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') return { ok: false, reason: 'API_ORIGIN is empty.' };

  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: `API_ORIGIN "${value}" is not an absolute URL.` };
  }

  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return { ok: false, reason: `API_ORIGIN must be https, got "${value}".` };
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    return { ok: false, reason: `API_ORIGIN must be an origin only, with no path: "${value}".` };
  }
  return { ok: true, origin: url.origin };
}

/**
 * The `_redirects` file content.
 *
 * @param {{ apiOrigin?: string }} options
 * @returns {string}
 */
export function buildRedirects({ apiOrigin } = {}) {
  const lines = [];
  if (apiOrigin) {
    const parsed = parseApiOrigin(apiOrigin);
    if (!parsed.ok) throw new Error(parsed.reason);
    // Before the fallback: the first matching rule wins.
    lines.push(`/api/*  ${parsed.origin}/api/:splat  200!`);
  }
  lines.push('/*  /index.html  200');
  return `${lines.join('\n')}\n`;
}

/**
 * Decide what to write for this build, and whether the build must fail.
 *
 * On the static host (`NETLIFY=true`) a build with neither a proxy target nor a direct API
 * base would publish a site that can reach no API — fail it there, loudly. Locally, a plain
 * `npm run build` needs neither.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ ok: true, content: string, mode: string } | { ok: false, reason: string }}
 */
export function planRedirects(env) {
  const apiOrigin = String(env.API_ORIGIN ?? '').trim();
  const apiBase = String(env.VITE_API_BASE ?? '').trim();
  const onHost = env.NETLIFY === 'true';

  if (apiOrigin && apiBase) {
    return {
      ok: false,
      reason:
        'Set API_ORIGIN (proxy /api, recommended) or VITE_API_BASE (call the API directly), not both.',
    };
  }
  if (apiOrigin) {
    const parsed = parseApiOrigin(apiOrigin);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    return { ok: true, content: buildRedirects({ apiOrigin: parsed.origin }), mode: `proxy /api → ${parsed.origin}` };
  }
  if (apiBase) return { ok: true, content: buildRedirects(), mode: `direct to ${apiBase}` };
  if (onHost) {
    return {
      ok: false,
      reason:
        'Neither API_ORIGIN nor VITE_API_BASE is set, so the deployed site could reach no API. ' +
        'Set API_ORIGIN to the API\'s https origin in the site\'s environment variables.',
    };
  }
  return { ok: true, content: buildRedirects(), mode: 'local build, no API target' };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const plan = planRedirects(process.env);
  if (!plan.ok) {
    process.stderr.write(`redirects: ${plan.reason}\n`);
    process.exit(1);
  }
  const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', '_redirects');
  await writeFile(target, plan.content);
  process.stdout.write(`redirects: wrote ${target} (${plan.mode})\n`);
}
