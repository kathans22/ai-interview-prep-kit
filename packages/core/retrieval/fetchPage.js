/**
 * fetchPage.js — get one page, or explain why not.
 *
 * Decides: timeouts, redirect handling, which content types are worth reading, how much
 * of a response to accept, and when a failure is worth one more try.
 *
 * Does NOT decide: whether the URL is allowed (urlGuard), whether robots permits it
 * (robots.js), or what the page means (clean.js). It also does not decide that a run has
 * failed — which is the point below.
 *
 * IT NEVER THROWS UPWARD. Every outcome is a value: `{ ok: true, ... }` or
 * `{ ok: false, reason, message }`. One unreachable company site must not end a batch of
 * five cases, and one 404 among twelve crawled links must not end a case. A thrown error
 * would have to be caught identically at every call site, and the first call site that
 * forgot would turn a missing page into a failed kit — which the contract explicitly
 * says it is not.
 *
 * REDIRECTS ARE FOLLOWED BY HAND. `redirect: 'follow'` would hand the whole chain to the
 * runtime and return only the final response, which means the guard would see the first
 * URL and the last one, but never the hops between. Following manually lets every hop be
 * re-checked, so a public URL cannot 302 its way to a private address.
 *
 * SIZE IS CAPPED WHILE STREAMING, NOT AFTER. Content-Length is a claim, and a hostile or
 * broken server can omit it or lie. The body is read in chunks and abandoned the moment
 * it exceeds the cap, so a multi-gigabyte response costs a few kilobytes of memory.
 */

import { URL_SKIP_REASONS } from './urlGuard.js';

/** Why a fetch produced nothing usable. Extends the guard's reasons. */
export const FETCH_SKIP_REASONS = Object.freeze({
  ...URL_SKIP_REASONS,
  TIMEOUT: 'FETCH_TIMEOUT',
  TOO_MANY_REDIRECTS: 'FETCH_TOO_MANY_REDIRECTS',
  REDIRECT_WITHOUT_LOCATION: 'FETCH_REDIRECT_WITHOUT_LOCATION',
  HTTP_ERROR: 'FETCH_HTTP_ERROR',
  UNSUPPORTED_CONTENT_TYPE: 'FETCH_UNSUPPORTED_CONTENT_TYPE',
  TOO_LARGE: 'FETCH_TOO_LARGE',
  NETWORK: 'FETCH_NETWORK_ERROR',
});

/** Only these are worth reading. A PDF or an image is not a company page to us. */
export const ALLOWED_CONTENT_TYPES = Object.freeze(['text/html', 'text/plain']);

export const FETCH_DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  maxBytes: 2_000_000,
  maxRedirects: 5,
  retries: 1,
  retryDelayMs: 500,
  userAgent: 'ai-interview-prep-kit/1.0 (+research crawler; respects robots.txt)',
});

function skip(reason, message, extra = {}) {
  return { ok: false, reason, message, ...extra };
}

/** Marker for a deadline that expired, distinguishable from a caller's own abort. */
const TIMED_OUT = Symbol('fetch-timed-out');

/**
 * Enforce the deadline ourselves rather than relying on the fetch implementation to
 * honour AbortSignal.
 *
 * The real fetch does honour it. But the guarantee this function needs is "the crawler
 * cannot hang", and delegating that to whatever was injected makes it a hope rather than
 * a guarantee — a stub, a polyfill or a proxying wrapper that drops the signal would
 * stall the whole run on one bad route. The fixture site has a deliberately hanging
 * route for exactly this reason.
 */
async function withDeadline(promise, timeoutMs) {
  let timer;
  const deadline = new Promise((resolve) => {
    // Deliberately NOT unref'd. An unreferenced timer cannot keep the event loop alive,
    // so if the pending fetch holds nothing open — a stub, a mocked transport — the
    // deadline never fires and the await hangs forever, which is the exact failure this
    // function exists to prevent. clearTimeout in the finally below keeps it cheap.
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body in chunks, abandoning it if it grows past the cap. */
async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { tooLarge: true, size: declared };
  }

  if (!response.body) {
    const text = await response.text();
    const size = Buffer.byteLength(text);
    return size > maxBytes ? { tooLarge: true, size } : { text, size };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      // Stop pulling bytes we have already decided not to use.
      await reader.cancel().catch(() => {});
      return { tooLarge: true, size };
    }
    chunks.push(value);
  }

  return { text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'), size };
}

/**
 * Build a fetcher.
 *
 * @param {object} options
 * @param {{ check: Function, checkRedirect: Function }} options.guard
 * @param {typeof globalThis.fetch} [options.fetchImpl] injected for tests
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {number} [options.maxRedirects]
 * @param {number} [options.retries]
 */
export function createPageFetcher({
  guard,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = FETCH_DEFAULTS.timeoutMs,
  maxBytes = FETCH_DEFAULTS.maxBytes,
  maxRedirects = FETCH_DEFAULTS.maxRedirects,
  retries = FETCH_DEFAULTS.retries,
  retryDelayMs = FETCH_DEFAULTS.retryDelayMs,
  userAgent = FETCH_DEFAULTS.userAgent,
} = {}) {
  if (!guard || typeof guard.check !== 'function') {
    throw new Error('FETCH_NOT_CONFIGURED: createPageFetcher requires a url guard.');
  }

  /** One attempt, following redirects by hand and re-checking each hop. */
  async function attempt(startUrl) {
    let currentUrl = String(startUrl);
    const chain = [];

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const verdict = hop === 0
        ? await guard.check(currentUrl)
        : await guard.checkRedirect(currentUrl, { from: chain[chain.length - 1] });

      if (!verdict.allowed) {
        return skip(verdict.reason, verdict.message, { url: currentUrl, redirectChain: chain });
      }

      chain.push(currentUrl);

      let response;
      try {
        response = await withDeadline(
          fetchImpl(verdict.url.toString(), {
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
            headers: { 'user-agent': userAgent, accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
          }),
          timeoutMs
        );

        if (response === TIMED_OUT) {
          return skip(
            FETCH_SKIP_REASONS.TIMEOUT,
            `No response within ${timeoutMs}ms.`,
            { url: currentUrl, retryable: true, redirectChain: chain }
          );
        }
      } catch (cause) {
        const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
        return skip(
          timedOut ? FETCH_SKIP_REASONS.TIMEOUT : FETCH_SKIP_REASONS.NETWORK,
          timedOut
            ? `No response within ${timeoutMs}ms.`
            : `Network failure: ${cause?.message ?? String(cause)}`,
          { url: currentUrl, retryable: true, redirectChain: chain }
        );
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          return skip(
            FETCH_SKIP_REASONS.REDIRECT_WITHOUT_LOCATION,
            `Status ${response.status} with no Location header.`,
            { url: currentUrl, status: response.status, redirectChain: chain }
          );
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!response.ok) {
        return skip(
          FETCH_SKIP_REASONS.HTTP_ERROR,
          `HTTP ${response.status} ${response.statusText ?? ''}`.trim(),
          {
            url: currentUrl,
            status: response.status,
            // 5xx may pass; 404 will not, however many times it is asked.
            retryable: response.status >= 500,
            redirectChain: chain,
          }
        );
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      const mediaType = contentType.split(';')[0].trim();
      if (mediaType && !ALLOWED_CONTENT_TYPES.includes(mediaType)) {
        return skip(
          FETCH_SKIP_REASONS.UNSUPPORTED_CONTENT_TYPE,
          `Content-Type "${mediaType}" is not readable text.`,
          { url: currentUrl, status: response.status, contentType: mediaType, redirectChain: chain }
        );
      }

      let body;
      try {
        body = await readCapped(response, maxBytes);
      } catch (cause) {
        return skip(FETCH_SKIP_REASONS.NETWORK, `Body read failed: ${cause.message}`, {
          url: currentUrl,
          retryable: true,
          redirectChain: chain,
        });
      }

      if (body.tooLarge) {
        return skip(
          FETCH_SKIP_REASONS.TOO_LARGE,
          `Response exceeds ${maxBytes} bytes (saw ${body.size}).`,
          { url: currentUrl, status: response.status, size: body.size, redirectChain: chain }
        );
      }

      return {
        ok: true,
        status: response.status,
        url: currentUrl,
        requestedUrl: chain[0],
        html: body.text,
        contentType: mediaType || 'text/html',
        bytes: body.size,
        redirectChain: chain,
      };
    }

    return skip(
      FETCH_SKIP_REASONS.TOO_MANY_REDIRECTS,
      `More than ${maxRedirects} redirects.`,
      { url: currentUrl, redirectChain: chain }
    );
  }

  /**
   * Fetch one page.
   *
   * @param {string} url
   * @returns {Promise<{ok: true, status: number, url: string, html: string} | {ok: false, reason: string, message: string}>}
   */
  async function fetchPage(url) {
    let last = await attempt(url);

    for (let retry = 0; retry < retries && !last.ok && last.retryable; retry += 1) {
      await sleep(retryDelayMs * 2 ** retry);
      last = await attempt(url);
    }

    return last;
  }

  return { fetchPage };
}
