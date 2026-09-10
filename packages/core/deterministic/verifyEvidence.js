/**
 * verifyEvidence.js — does each requirement actually come from the job description?
 *
 * Decides: whether a requirement's `evidence` string — the phrase the extractor claims it
 * came from — can be found in the JD. Three tiers, tried in order, and a requirement is
 * only unsupported when all three fail.
 *
 * Does NOT decide: what to do with an unsupported requirement, whether the requirement is
 * well written, or whether the JD is any good. It never mutates or removes anything; the
 * caller drops, and the caller logs.
 *
 * WHY THREE TIERS AND NOT STRICT EQUALITY. This guard exists to catch fabrication — a
 * requirement the model invented that the JD never mentions. Strict equality catches that,
 * but it also punishes ordinary paraphrase: a JD bullet reading "• 5+ years' experience
 * with React" against evidence "5+ years experience with React" is the same fact with a
 * bullet and an apostrophe removed. Every requirement wrongly dropped costs must-recall,
 * which is the scored criterion this guard was built to protect. A guard that silently
 * deletes good requirements is worse than no guard at all, so the tiers exist to make
 * false drops rare while still refusing anything the JD does not support:
 *
 *   tier 1 — exact match against a normalised JD line
 *   tier 2 — normalised substring, in EITHER direction (evidence inside the JD, or a JD
 *            line inside a longer evidence quote)
 *   tier 3 — content-word Jaccard >= EVIDENCE_JACCARD_THRESHOLD against the best-matching
 *            JD line, stopwords removed
 *
 * THE THRESHOLD IS NOT A TUNING KNOB. If the drop rate climbs above roughly 5%, the
 * extraction PROMPT is producing evidence that is not in the JD. Fix the prompt. Lowering
 * the threshold to make the number look better converts a visible extraction fault into
 * an invisible fabrication-acceptance fault, which is strictly worse.
 *
 * Pure: no I/O, no model, no mutation of the inputs.
 */

/** Tier 3 acceptance threshold. See the note above before changing it. */
export const EVIDENCE_JACCARD_THRESHOLD = 0.6;

/** Match tiers, in the order they are attempted. */
export const EVIDENCE_TIERS = Object.freeze({
  EXACT: 1,
  SUBSTRING: 2,
  JACCARD: 3,
  NONE: null,
});

/**
 * Words carrying no distinguishing content. Kept deliberately small: an aggressive list
 * would strip domain words and inflate similarity between unrelated lines.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from', 'had', 'has',
  'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'our', 'over', 'per', 'that', 'the',
  'their', 'them', 'they', 'this', 'to', 'up', 'was', 'we', 'were', 'will', 'with', 'you', 'your',
]);

/** Leading bullet markers, including numbered and lettered list prefixes. */
const BULLET_PREFIX = /^[\s•‣▪●·*+\-–—]+|^\(?\d+[.)]\s*|^[a-z][.)]\s+/i;

/**
 * Fold typographic characters to ASCII so a curly apostrophe or an en dash cannot cause
 * a false drop.
 */
function foldTypography(text) {
  return text
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[   ]/g, ' ')
    .replace(/…/g, '...');
}

/**
 * Normalise for comparison: fold typography, strip bullets, lowercase, remove
 * punctuation, collapse whitespace.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalise(text) {
  if (typeof text !== 'string') return '';
  return foldTypography(text)
    .replace(BULLET_PREFIX, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s+#.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a JD into normalised, non-empty lines, keeping the original for reporting. */
export function toLines(jdText) {
  if (typeof jdText !== 'string') return [];
  return jdText
    .split(/\r?\n/)
    .map((raw) => ({ raw: raw.trim(), normalised: normalise(raw) }))
    .filter((line) => line.normalised !== '');
}

/** Content words of a normalised string, stopwords removed. */
function contentWords(normalised) {
  return new Set(
    normalised
      .split(' ')
      .filter((word) => word !== '' && !STOPWORDS.has(word))
  );
}

/** Jaccard similarity of two sets: |intersection| / |union|. */
function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Match one evidence string against a prepared JD.
 *
 * @param {string} evidence
 * @param {{ lines: Array<{raw: string, normalised: string}>, whole: string }} jd
 * @returns {{ tier: number|null, score: number, line: string|null }}
 *   score is 1 for tiers 1 and 2, and the Jaccard ratio for tier 3. For a failed match it
 *   is the best ratio achieved, which is what makes a near miss diagnosable.
 */
export function matchEvidence(evidence, jd) {
  const needle = normalise(evidence);
  if (needle === '') return { tier: EVIDENCE_TIERS.NONE, score: 0, line: null };

  // Tier 1 — exact, against any single normalised line.
  for (const line of jd.lines) {
    if (line.normalised === needle) {
      return { tier: EVIDENCE_TIERS.EXACT, score: 1, line: line.raw };
    }
  }

  // Tier 2 — substring in either direction. The reverse direction matters: an extractor
  // often quotes a whole bullet as evidence for a requirement phrased more tightly.
  if (jd.whole.includes(needle)) {
    const containing = jd.lines.find((line) => line.normalised.includes(needle));
    return { tier: EVIDENCE_TIERS.SUBSTRING, score: 1, line: containing?.raw ?? null };
  }
  for (const line of jd.lines) {
    if (needle.includes(line.normalised)) {
      return { tier: EVIDENCE_TIERS.SUBSTRING, score: 1, line: line.raw };
    }
  }

  // Tier 3 — content-word overlap against the best-matching line.
  const needleWords = contentWords(needle);
  let best = { score: 0, line: null };
  for (const line of jd.lines) {
    const score = jaccard(needleWords, contentWords(line.normalised));
    if (score > best.score) best = { score, line: line.raw };
  }

  if (best.score >= EVIDENCE_JACCARD_THRESHOLD) {
    return { tier: EVIDENCE_TIERS.JACCARD, score: best.score, line: best.line };
  }

  return { tier: EVIDENCE_TIERS.NONE, score: best.score, line: best.line };
}

/**
 * Verify every requirement's evidence against the job description.
 *
 * @param {string} jdText
 * @param {Array<{id?: string, text?: string, evidence?: string}>} requirements
 * @param {{ onDrop?: (drop: object) => void }} [options] onDrop is called once per
 *   unsupported requirement. Core does no logging of its own — the adapter decides where
 *   output goes — but every drop is reported so none can happen quietly.
 * @returns {{
 *   supported: string[],
 *   unsupported: string[],
 *   matches: Array<{ id: string, tier: number|null, score: number }>,
 *   drops: Array<{ id: string, evidence: string, score: number, closestLine: string|null }>
 * }}
 */
export function verifyEvidence(jdText, requirements, { onDrop } = {}) {
  const lines = toLines(jdText);
  const jd = { lines, whole: normalise(jdText) };

  const supported = [];
  const unsupported = [];
  const matches = [];
  const drops = [];

  for (const requirement of Array.isArray(requirements) ? requirements : []) {
    const id = typeof requirement?.id === 'string' ? requirement.id : '';
    if (id === '') continue;

    const evidence = typeof requirement?.evidence === 'string' ? requirement.evidence : '';
    const { tier, score, line } = matchEvidence(evidence, jd);

    matches.push({ id, tier, score: Number(score.toFixed(4)) });

    if (tier === EVIDENCE_TIERS.NONE) {
      unsupported.push(id);
      const drop = {
        id,
        evidence,
        score: Number(score.toFixed(4)),
        closestLine: line,
        reason: evidence === '' ? 'EVIDENCE_MISSING' : 'EVIDENCE_UNSUPPORTED',
      };
      drops.push(drop);
      if (typeof onDrop === 'function') onDrop(drop);
    } else {
      supported.push(id);
    }
  }

  return { supported, unsupported, matches, drops };
}

/**
 * The share of requirements that failed all three tiers. Stage 6 reports this; above
 * roughly 0.05 the extraction prompt is at fault, not the threshold.
 *
 * @param {{ supported: string[], unsupported: string[] }} result
 */
export function dropRate({ supported = [], unsupported = [] } = {}) {
  const total = supported.length + unsupported.length;
  return total === 0 ? 0 : unsupported.length / total;
}
