/**
 * urlGuard.js — may we fetch this URL?
 *
 * Decides: scheme, and whether the host resolves to an address we are willing to reach.
 * http and https only; private, loopback, link-local and reserved addresses are refused
 * unless the environment explicitly permits them.
 *
 * Does NOT decide: whether the page is useful, whether robots.txt allows it (robots.js),
 * or what to do when a URL is refused — callers record the skip and carry on.
 *
 * THE TENSION, STATED DELIBERATELY RATHER THAN LEFT AS A BUG.
 * A crawler that follows a URL supplied by a user is an SSRF hole: point it at
 * http://169.254.169.254/ and it will happily fetch cloud instance credentials for you.
 * The correct production behaviour is to refuse every private and link-local address.
 * But this project's own acceptance test crawls http://localhost:8099/acme/, which is
 * exactly such an address. The two requirements genuinely conflict, so the guard is
 * ENVIRONMENT-GATED: refusing by default, permissive only when ALLOW_PRIVATE_HOSTS is
 * set true by the adapter at boot. That flag is `true` in the local .env and must be
 * `false` wherever the service is exposed.
 *
 * RESOLUTION, NOT SPELLING. Blocking the string "localhost" is theatre: "127.0.0.1",
 * "0x7f.1", a domain whose A record points at 10.0.0.5, and a redirect to any of them
 * all reach the same place. The hostname is resolved and the resulting ADDRESS is
 * judged — and re-judged after every redirect hop, because a public URL that 302s to a
 * private one is the standard bypass.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

/** Why a URL was refused. A closed set; callers switch on these. */
export const URL_SKIP_REASONS = Object.freeze({
  MALFORMED: 'URL_MALFORMED',
  UNSUPPORTED_SCHEME: 'URL_UNSUPPORTED_SCHEME',
  PRIVATE_HOST: 'URL_PRIVATE_HOST',
  DNS_FAILED: 'URL_DNS_FAILED',
});

/**
 * Is this IP address one we refuse to reach from a crawler?
 *
 * Pure and synchronous, so the range logic is testable without DNS.
 *
 * @param {string} address an IPv4 or IPv6 address
 * @returns {boolean}
 */
export function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);
  // Not an address at all — treat as unsafe rather than assume.
  return true;
}

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;

  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, includes the cloud metadata IP
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 carrier-grade NAT
  if (a >= 224) return true; // multicast, reserved and broadcast
  return false;
}

function isPrivateIPv6(address) {
  const value = address.toLowerCase().split('%')[0];

  if (value === '::' || value === '::1') return true; // unspecified, loopback
  if (value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (/^f[cd]/.test(value)) return true; // fc00::/7 unique local
  if (value.startsWith('ff')) return true; // multicast

  // IPv4-mapped (::ffff:10.0.0.1) inherits the IPv4 verdict.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return isPrivateIPv4(mapped[1]);

  return false;
}

/**
 * Parse and normalise a URL string.
 *
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string, message: string }}
 */
export function parseUrl(candidate) {
  let url;
  try {
    url = new URL(String(candidate));
  } catch {
    return {
      ok: false,
      reason: URL_SKIP_REASONS.MALFORMED,
      message: `Not a valid absolute URL: ${String(candidate)}`,
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      reason: URL_SKIP_REASONS.UNSUPPORTED_SCHEME,
      message: `Only http and https are fetched; got "${url.protocol}".`,
    };
  }

  return { ok: true, url };
}

/**
 * Build a guard.
 *
 * @param {object} options
 * @param {boolean} [options.allowPrivateHosts=false] set from ALLOW_PRIVATE_HOSTS by the
 *   adapter. Core never reads the environment itself.
 * @param {(hostname: string, options?: object) => Promise<Array<{address: string}>>} [options.lookup]
 *   DNS resolver, injected so tests need no network and can simulate a rebind.
 */
export function createUrlGuard({ allowPrivateHosts = false, lookup = dns.lookup } = {}) {
  /**
   * Check one URL.
   *
   * @param {string|URL} candidate
   * @returns {Promise<{ allowed: boolean, url?: URL, addresses?: string[], reason?: string, message?: string }>}
   */
  async function check(candidate) {
    const parsed = parseUrl(candidate);
    if (!parsed.ok) return { allowed: false, reason: parsed.reason, message: parsed.message };

    const { url } = parsed;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');

    // A literal address needs no resolution, and resolving one would be a needless
    // round trip that some resolvers answer differently.
    if (net.isIP(hostname)) {
      const isPrivate = isPrivateAddress(hostname);
      if (isPrivate && !allowPrivateHosts) {
        return {
          allowed: false,
          url,
          addresses: [hostname],
          reason: URL_SKIP_REASONS.PRIVATE_HOST,
          message: `${hostname} is a private, loopback or reserved address. Set ALLOW_PRIVATE_HOSTS=true only for local fixtures.`,
        };
      }
      return { allowed: true, url, addresses: [hostname], private: isPrivate };
    }

    let addresses;
    try {
      const resolved = await lookup(hostname, { all: true });
      addresses = (Array.isArray(resolved) ? resolved : [resolved])
        .map((entry) => entry?.address)
        .filter(Boolean);
    } catch (cause) {
      return {
        allowed: false,
        url,
        reason: URL_SKIP_REASONS.DNS_FAILED,
        message: `Could not resolve ${hostname}: ${cause.message}`,
      };
    }

    if (addresses.length === 0) {
      return {
        allowed: false,
        url,
        reason: URL_SKIP_REASONS.DNS_FAILED,
        message: `${hostname} resolved to no addresses.`,
      };
    }

    // EVERY address must pass. A host with one public and one private A record would
    // otherwise be a coin flip decided by whichever the OS connects to.
    const offending = addresses.find((address) => isPrivateAddress(address));
    if (offending && !allowPrivateHosts) {
      return {
        allowed: false,
        url,
        addresses,
        reason: URL_SKIP_REASONS.PRIVATE_HOST,
        message: `${hostname} resolves to ${offending}, a private or reserved address.`,
      };
    }

    return { allowed: true, url, addresses, private: Boolean(offending) };
  }

  /**
   * Re-check after a redirect. Identical policy — the point is that it is CALLED again,
   * because a public URL that redirects to 169.254.169.254 is the standard bypass and a
   * guard applied only to the first URL does not stop it.
   */
  async function checkRedirect(location, { from } = {}) {
    const result = await check(location);
    if (!result.allowed) {
      return { ...result, message: `${result.message} (redirected from ${from ?? 'unknown'})` };
    }
    return result;
  }

  return { check, checkRedirect, allowPrivateHosts };
}
