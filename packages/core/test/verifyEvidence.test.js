/**
 * verifyEvidence.test.js — the three matching tiers, and the exit-check pair:
 * a fabricated requirement must be rejected, a lightly paraphrased real one accepted.
 *
 * Decides: that each tier fires when it should, that a near miss reports a usable score,
 * and that nothing is dropped quietly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  verifyEvidence,
  matchEvidence,
  normalise,
  toLines,
  dropRate,
  EVIDENCE_TIERS,
  EVIDENCE_JACCARD_THRESHOLD,
} from '../deterministic/verifyEvidence.js';

const JD = [
  'Senior Frontend Engineer — Acme Logistics',
  '',
  'What you will do:',
  '• 5+ years’ experience with React and TypeScript',
  '• Comfortable mentoring junior engineers through code review',
  '- Own the operator console used by dispatchers every day',
  '2. Familiarity with warehouse logistics or fleet routing is a plus',
  'We work remotely across the UK.',
].join('\n');

function prepared() {
  return { lines: toLines(JD), whole: normalise(JD) };
}

function requirement(id, evidence) {
  return { id, text: `requirement ${id}`, kind: 'technical', priority: 'must', evidence };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

test('normalise folds typography, strips bullets and collapses whitespace', () => {
  assert.equal(normalise('• 5+ years’ experience'), '5+ years experience');
  assert.equal(normalise('- Own   the console'), 'own the console');
  assert.equal(normalise('2. Familiarity with routing'), 'familiarity with routing');
  assert.equal(normalise('“Smart quotes” and — dashes'), 'smart quotes and dashes');
  assert.equal(normalise(undefined), '');
});

test('toLines drops blank lines and keeps the original text for reporting', () => {
  const lines = toLines(JD);
  assert.ok(lines.every((line) => line.normalised !== ''));
  assert.ok(lines.some((line) => line.raw.startsWith('•')), 'raw text is preserved');
});

// ---------------------------------------------------------------------------
// Tier 1 — exact after normalising
// ---------------------------------------------------------------------------

test('tier 1: a bullet and a smart apostrophe do not prevent an exact match', () => {
  const match = matchEvidence('5+ years experience with React and TypeScript', prepared());
  assert.equal(match.tier, EVIDENCE_TIERS.EXACT);
  assert.equal(match.score, 1);
});

test('tier 1: case and spacing differences still match exactly', () => {
  const match = matchEvidence('  COMFORTABLE   mentoring junior engineers through code review ', prepared());
  assert.equal(match.tier, EVIDENCE_TIERS.EXACT);
});

// ---------------------------------------------------------------------------
// Tier 2 — substring, both directions
// ---------------------------------------------------------------------------

test('tier 2: evidence that is a fragment of a JD line matches', () => {
  const match = matchEvidence('mentoring junior engineers', prepared());
  assert.equal(match.tier, EVIDENCE_TIERS.SUBSTRING);
  assert.match(match.line, /Comfortable mentoring/);
});

test('tier 2: a JD line quoted inside a longer evidence string matches', () => {
  const evidence = 'The posting says: We work remotely across the UK. — so the role is remote.';
  const match = matchEvidence(evidence, prepared());
  assert.equal(match.tier, EVIDENCE_TIERS.SUBSTRING);
});

// ---------------------------------------------------------------------------
// Tier 3 — content-word Jaccard
// ---------------------------------------------------------------------------

test('tier 3: a light paraphrase is accepted rather than dropped', () => {
  // Reordered, stopwords changed, one word added: the same fact, differently worded.
  const match = matchEvidence('Familiarity with fleet routing or warehouse logistics', prepared());
  assert.equal(match.tier, EVIDENCE_TIERS.JACCARD);
  assert.ok(match.score >= EVIDENCE_JACCARD_THRESHOLD);
});

test('tier 3: matching does not stop at tier 1 — a paraphrase reaches tier 3', () => {
  const match = matchEvidence('Own the operator console used by dispatchers', prepared());
  assert.notEqual(match.tier, EVIDENCE_TIERS.NONE, 'must not be dropped');
});

test('tier 3: an unrelated sentence stays below the threshold', () => {
  const match = matchEvidence('Must hold an active AWS Solutions Architect certification', prepared());
  assert.equal(match.tier, EVIDENCE_TIERS.NONE);
  assert.ok(match.score < EVIDENCE_JACCARD_THRESHOLD);
});

// ---------------------------------------------------------------------------
// EXIT CHECK
// ---------------------------------------------------------------------------

test('EXIT CHECK: rejects a fabricated requirement, accepts a lightly paraphrased real one', () => {
  const result = verifyEvidence(JD, [
    requirement('r1', '5+ years’ experience with React and TypeScript'), // verbatim
    requirement('r2', '5+ years of experience with React and TypeScript'), // light paraphrase
    requirement('r3', 'mentoring junior engineers'), // fragment
    requirement('r4', 'Requires an active AWS Solutions Architect certification'), // fabricated
    requirement('r5', 'Must be willing to relocate to Berlin and work on-site'), // fabricated
  ]);

  assert.deepEqual(result.supported, ['r1', 'r2', 'r3']);
  assert.deepEqual(result.unsupported, ['r4', 'r5']);

  const tiers = Object.fromEntries(result.matches.map((match) => [match.id, match.tier]));
  assert.equal(tiers.r1, EVIDENCE_TIERS.EXACT);
  assert.ok([EVIDENCE_TIERS.SUBSTRING, EVIDENCE_TIERS.JACCARD].includes(tiers.r2));
  assert.equal(tiers.r4, EVIDENCE_TIERS.NONE);
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test('every drop is reported with its evidence, best score and closest line', () => {
  const seen = [];
  const result = verifyEvidence(JD, [requirement('r9', 'Kubernetes cluster administration')], {
    onDrop: (drop) => seen.push(drop),
  });

  assert.equal(result.drops.length, 1);
  assert.equal(seen.length, 1, 'onDrop must fire so no drop is silent');
  assert.equal(seen[0].id, 'r9');
  assert.equal(seen[0].evidence, 'Kubernetes cluster administration');
  assert.equal(typeof seen[0].score, 'number');
  assert.equal(seen[0].reason, 'EVIDENCE_UNSUPPORTED');
});

test('a failed match reports the best score achieved, not zero', () => {
  // Close but under the line: the score is what makes a near miss diagnosable.
  const match = matchEvidence('mentoring senior architects through design review', prepared());
  assert.equal(match.tier, EVIDENCE_TIERS.NONE);
  assert.ok(match.score > 0, 'a near miss must not report 0');
  assert.ok(match.line !== null, 'the closest line must be named');
});

test('missing or empty evidence is unsupported, with its own reason', () => {
  const result = verifyEvidence(JD, [
    requirement('r1', ''),
    { id: 'r2', text: 'no evidence field at all' },
  ]);

  assert.deepEqual(result.unsupported, ['r1', 'r2']);
  assert.ok(result.drops.every((drop) => drop.reason === 'EVIDENCE_MISSING'));
});

test('requirements without a usable id are skipped, not counted', () => {
  const result = verifyEvidence(JD, [{ evidence: 'anything' }, { id: '', evidence: 'anything' }]);
  assert.deepEqual(result.supported, []);
  assert.deepEqual(result.unsupported, []);
  assert.deepEqual(result.matches, []);
});

test('an empty JD supports nothing, and does not throw', () => {
  const result = verifyEvidence('', [requirement('r1', 'anything at all')]);
  assert.deepEqual(result.unsupported, ['r1']);
  assert.equal(verifyEvidence(null, []).supported.length, 0);
});

test('dropRate reports the share Stage 6 watches', () => {
  assert.equal(dropRate({ supported: ['r1', 'r2', 'r3'], unsupported: ['r4'] }), 0.25);
  assert.equal(dropRate({ supported: [], unsupported: [] }), 0, 'no requirements is not a 100% drop');
  assert.equal(dropRate(), 0);
});

test('the input requirements are never mutated', () => {
  const requirements = [requirement('r1', 'Kubernetes cluster administration')];
  const snapshot = structuredClone(requirements);
  verifyEvidence(JD, requirements);
  assert.deepEqual(requirements, snapshot, 'verification must not drop or edit anything itself');
});
