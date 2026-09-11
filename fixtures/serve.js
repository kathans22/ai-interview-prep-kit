/**
 * serve.js — a static server for the four fixture company sites.
 *
 * Decides: how fixture URLs map to files, and which routes misbehave on purpose.
 *
 * Does NOT decide: anything about the pipeline. It is a stand-in for the public
 * internet, and the pipeline must not be able to tell the difference.
 *
 * WHY LOCAL FIXTURES RATHER THAN REAL SITES. A test that crawls a real company is a
 * test whose result depends on someone else's deploy schedule, rate limiting and
 * robots.txt. These four sites make the crawler's hard cases reproducible:
 *
 *   /acme/    the hiring page is at /acme/handbook/how-we-hire — a path no list would
 *             guess, reachable only by following links and reading anchor text
 *   /nohire/  a real company site with no hiring page at all, so "null" is the right
 *             answer and must be produced cleanly
 *   /broken/  404s, a redirect loop and a route that never responds, so skip reporting
 *             and the timeout are exercised rather than assumed
 *   /hostile/ prompt injection in visible page text, used in Stage 16
 *
 * URLs are extensionless on purpose (/acme/handbook/how-we-hire, not .html), because a
 * crawler that only recognises .html links would pass a test built from .html files and
 * fail on the web.
 *
 * Run directly:  node fixtures/serve.js [port]
 * Or import startFixtureServer() and let it pick a free port in tests.
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITES_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'sites');

/** Routes that misbehave deliberately. Kept in one place so the tests can name them. */
export const BROKEN_ROUTES = Object.freeze({
  /** Never responds. Proves the fetch timeout, not the server's patience. */
  HANG: '/broken/slow',
  /** Redirects to itself. Proves the redirect cap. */
  LOOP: '/broken/loop',
  /** Always 500, to exercise the retry path. */
  ERROR: '/broken/error',
  /** Serves a PDF content type, to exercise the content-type filter. */
  PDF: '/broken/brochure.pdf',
});

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
});

/** Resolve a URL path to a file inside sites/, refusing anything that escapes it. */
async function resolveFile(pathname) {
  const decoded = decodeURIComponent(pathname);
  // normalize collapses ".." before it can climb out of SITES_ROOT.
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  const base = join(SITES_ROOT, relative);

  if (!base.startsWith(SITES_ROOT + sep) && base !== SITES_ROOT) return null;

  const candidates = decoded.endsWith('/')
    ? [join(base, 'index.html')]
    : [base, `${base}.html`, join(base, 'index.html')];

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

function extensionOf(path) {
  const index = path.lastIndexOf('.');
  return index === -1 ? '' : path.slice(index).toLowerCase();
}

/**
 * Start the fixture server.
 *
 * @param {{ port?: number, host?: string }} [options] port 0 asks the OS for a free
 *   port, which is what tests should use — a hardcoded 8099 makes two test runs on one
 *   machine collide.
 * @returns {Promise<{ origin: string, port: number, close: () => Promise<void> }>}
 */
export async function startFixtureServer({ port = 0, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    const { pathname } = url;

    if (pathname === BROKEN_ROUTES.HANG) {
      // Deliberately no response, ever. The socket stays open until the client gives up.
      return;
    }

    if (pathname === BROKEN_ROUTES.LOOP) {
      response.writeHead(302, { location: BROKEN_ROUTES.LOOP });
      response.end();
      return;
    }

    if (pathname === BROKEN_ROUTES.ERROR) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('internal error');
      return;
    }

    if (pathname === BROKEN_ROUTES.PDF) {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end('%PDF-1.4 not really a pdf');
      return;
    }

    const file = await resolveFile(pathname);
    if (!file) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>404</title><h1>Not found</h1>');
      return;
    }

    try {
      const body = await readFile(file);
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extensionOf(file)] ?? 'text/html; charset=utf-8',
        'content-length': body.byteLength,
      });
      response.end(body);
    } catch (cause) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(`fixture read failed: ${cause.message}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;

  return {
    origin: `http://${host}:${actualPort}`,
    port: actualPort,
    async close() {
      // Sockets held open by the hanging route would keep the process alive forever.
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// Direct execution: node fixtures/serve.js [port]
//
// pathToFileURL, not a hand-built file:// string: on Windows the latter differs from
// import.meta.url in both slash count and percent-encoding, so the comparison silently
// fails and the server never starts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? process.env.FIXTURE_PORT ?? 8099);
  const { origin } = await startFixtureServer({ port, host: '127.0.0.1' });
  process.stdout.write(
    [
      `fixture sites serving on ${origin}`,
      `  ${origin}/acme/      hiring page hidden at /acme/handbook/how-we-hire`,
      `  ${origin}/nohire/    no hiring page anywhere`,
      `  ${origin}/broken/    404s, a redirect loop, a 500, a PDF and a hanging route`,
      `  ${origin}/hostile/   prompt injection in visible text`,
      'press ctrl-c to stop',
      '',
    ].join('\n')
  );
}
