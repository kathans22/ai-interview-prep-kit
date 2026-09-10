/**
 * clean.js — HTML to readable text and usable links.
 *
 * Decides: which parts of a page are content, what the text of the page is, and what
 * each link points at.
 *
 * Does NOT decide: whether a link is worth following (crawl.js scores that), or what the
 * text means. It extracts; it does not judge.
 *
 * LINKS COME OUT ABSOLUTE, RESOLVED AGAINST THE RESPONSE URL. This is the single most
 * consequential line in the module. The fixtures are served from
 * http://localhost:8099/acme/ — a sub-path, not a domain root — so a page linking
 * "handbook/how-we-hire" means /acme/handbook/how-we-hire, while "/about" means the
 * server root. Anything that assumes a domain, prepends a fixed origin, or treats a
 * relative href as root-relative silently loses the hiring page the crawler exists to
 * find. Resolution uses the URL the response actually came from, so redirects are
 * handled correctly too.
 *
 * WHY REGEX AND NOT A PARSER. A real HTML parser is a dependency, and the task here is
 * narrow: strip a handful of element types, keep headings, pull hrefs. The trade is
 * accepted deliberately — malformed markup can confuse this, and pages are stripped of
 * script and style content BEFORE anything else so an unbalanced tag inside a script
 * cannot leak executable-looking text into the output. Anything this misparses degrades
 * to slightly worse text, never to a crash.
 *
 * Pure: no I/O, no model.
 */

/**
 * Elements whose contents are not text a human reads AND not markup we trust. Removed
 * before anything else, including before links are extracted: a string inside a script
 * can look exactly like an anchor, and a page that can plant crawl targets in its own
 * JavaScript gets to choose where the crawler goes next.
 */
const NEVER_PARSED = ['script', 'style', 'noscript', 'template', 'svg', 'iframe'];

/**
 * Elements that are page furniture rather than content. Their TEXT is excluded from the
 * body copy, but their LINKS are still extracted — a careers link in the header or
 * footer is exactly the link this crawler exists to find.
 */
const NOT_BODY_TEXT = ['nav', 'footer', 'aside', 'form'];

/** A small entity table: the ones that actually appear in prose. */
const ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', middot: '·',
});

/** Decode the named and numeric entities that survive into visible text. */
export function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

function safeFromCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Remove an element and everything inside it. */
function dropElement(html, tag) {
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
  let previous;
  let current = html;
  // Repeat until stable: nested elements of the same type need more than one pass.
  do {
    previous = current;
    current = current.replace(pattern, ' ');
  } while (current !== previous);
  // A self-closing or unclosed instance still should not survive as a bare tag.
  return current.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), ' ');
}

/** Strip tags, decode entities, and collapse whitespace to a single line. */
export function textOf(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Convert a page to text and links.
 *
 * @param {string} html
 * @param {string} baseUrl the URL the response came from — links resolve against it
 * @returns {{
 *   title: string,
 *   text: string,
 *   headings: string[],
 *   links: Array<{ href: string, anchorText: string }>
 * }}
 */
export function clean(html, baseUrl) {
  const raw = typeof html === 'string' ? html : '';

  // Strip untrusted machine content first, so nothing below ever sees it. Comments go
  // too: they can hide markup that would otherwise confuse the tag stripper.
  let source = raw.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of NEVER_PARSED) source = dropElement(source, tag);

  const title = extractTitle(source);

  // Links come from the whole page INCLUDING nav and footer — a careers link in the
  // header is still a real link — but never from script or style, which were removed
  // above so a page cannot plant crawl targets in its own JavaScript.
  const links = extractLinks(source, baseUrl);

  let body = source;
  for (const tag of NOT_BODY_TEXT) body = dropElement(body, tag);

  const headings = extractHeadings(body);
  const text = extractText(body);

  return { title, text, headings, links };
}

function extractTitle(html) {
  const tagMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (tagMatch) {
    const value = textOf(tagMatch[1]);
    if (value) return value;
  }
  // Falling back to the first h1 matters for fixture pages and for sites that leave the
  // document title as a template placeholder.
  const headingMatch = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
  return headingMatch ? textOf(headingMatch[1]) : '';
}

function extractHeadings(html) {
  const headings = [];
  const pattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const value = textOf(match[2]);
    if (value) headings.push(value);
  }
  return headings;
}

/**
 * Body text with headings and block boundaries preserved as line breaks.
 *
 * Structure is kept because it is evidence: "How we hire" as its own line reads as a
 * heading to a model, where the same words buried mid-paragraph do not.
 */
function extractText(html) {
  const withBreaks = html
    .replace(/<(h[1-6])\b[^>]*>/gi, '\n\n')
    .replace(/<\/(h[1-6])\s*>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|ul|ol|table|blockquote)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ');

  return decodeEntities(withBreaks.replace(/<[^>]*>/g, ' '))
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Every <a href> on the page, resolved to an absolute URL.
 *
 * Fragment-only, javascript:, mailto: and tel: links are dropped — none of them is a
 * page that can be fetched.
 */
function extractLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;

  let match;
  while ((match = pattern.exec(html)) !== null) {
    const attributes = match[1];
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i.exec(attributes);
    if (!hrefMatch) continue;

    const raw = decodeEntities((hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '').trim());
    if (raw === '' || raw.startsWith('#')) continue;
    if (/^(javascript|mailto|tel|data):/i.test(raw)) continue;

    let resolved;
    try {
      resolved = new URL(raw, baseUrl);
    } catch {
      continue; // An unresolvable href is not a link we can follow.
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;

    resolved.hash = '';
    const href = resolved.toString();
    const anchorText = textOf(match[2]);

    // The same href can appear many times with different anchor text; keep the first
    // occurrence that has words, since an empty anchor tells the ranker nothing.
    const key = href;
    if (seen.has(key)) {
      if (anchorText) {
        const existing = links.find((link) => link.href === key);
        if (existing && !existing.anchorText) existing.anchorText = anchorText;
      }
      continue;
    }

    seen.add(key);
    links.push({ href, anchorText });
  }

  return links;
}
