/**
 * evalExtraction.js — score requirement extraction against hand-labelled postings.
 *
 * Decides: whether extraction is good enough to ship, using numbers rather than
 * impressions. Extraction carries 20 of the 55 automated points and is judged on
 * postings nobody here will ever see, so the only honest way to know it works is to
 * measure it on postings it has not been tuned to.
 *
 * Does NOT decide: how to fix a bad score. When recall is low or the drop rate is
 * high, the answer is the PROMPT — never the thresholds, and never the labels.
 *
 * THE METRICS, AND WHAT EACH ONE CATCHES:
 *   must-recall        labelled musts the model found         — missing the job's core
 *   must-precision     extracted musts that were labelled     — inflating the must set
 *   priority accuracy  must/nice assigned as labelled         — "bonus points" read as required
 *   invention count    forbidden strings, or no evidence      — facts the posting never stated
 *
 * CACHING. Each fixture's model response is cached to disk under a key that includes a
 * hash of the extraction prompt. Re-running after a SCORING change costs zero calls;
 * changing the PROMPT invalidates every entry automatically, because the prompt is the
 * key. That distinction is what makes it safe to iterate on scoring logic against a
 * daily request ceiling.
 *
 * Usage:
 *   node --env-file=.env scripts/evalExtraction.js            score, using the cache
 *   node --env-file=.env scripts/evalExtraction.js --refresh  ignore the cache, re-call
 *   node scripts/evalExtraction.js --offline                  cache only; fail if missing
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractRequirements,
  EXTRACTION_SYSTEM_INSTRUCTION,
} from '@aipk/core/generation/extractRequirements.js';
import { createGeminiProviderFromEnv } from '@aipk/core/llm/provider.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'fixtures', 'extraction');
const CACHE = join(FIXTURES, '.cache');

/** Targets from the brief. The exit code depends only on these. */
export const TARGETS = Object.freeze({
  mustRecall: 0.9,
  mustPrecision: 0.85,
  priorityAccuracy: 0.9,
  inventions: 0,
});

const args = new Set(process.argv.slice(2));
const REFRESH = args.has('--refresh');
const OFFLINE = args.has('--offline');

/**
 * Requests that actually reached Google, as distinct from work units spent.
 *
 * `spend` fires once per extraction whether the answer came from the network or from
 * disk, so reporting it as "model calls" would tell you the eval cost five requests
 * when it cost none. Against a daily ceiling that is the one number a reader must be
 * able to trust.
 */
let liveCalls = 0;

/** The prompt's fingerprint. Changing the prompt changes every cache key. */
const PROMPT_HASH = createHash('sha256').update(EXTRACTION_SYSTEM_INSTRUCTION).digest('hex').slice(0, 12);

/** Normalise for label matching: lowercase, punctuation to space, collapse spaces. */
function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s+#.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does a requirement satisfy a label?
 *
 * Word-boundary matching, not bare `includes`. A label like "r" (the language) or "go"
 * would otherwise match "our", "regulated" or "algorithm" and score a miss as a hit —
 * which would quietly inflate recall, the single number this harness exists to report
 * honestly. Multi-word labels are matched as a phrase.
 *
 * A trailing plural is tolerated on the final word: the label "api" must match a
 * requirement that says "public APIs". Without this the harness reports a miss the
 * model did not make, and an eval that lies in the pessimistic direction is still an
 * eval that lies — it would send someone tuning a prompt that was already right.
 */
function labelMatches(label, requirement) {
  const needle = normalise(label);
  if (needle === '') return false;

  const haystack = `${normalise(requirement.text)} ${normalise(requirement.evidence)}`;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(s|es)?(\\s|$)`, 'u').test(haystack);
}

/** Every requirement a label matches, not just the first. */
function findMatches(label, requirements) {
  return requirements.filter((requirement) => labelMatches(label, requirement));
}

/**
 * The requirement a label refers to, preferring one with the priority we expect.
 *
 * A label can legitimately appear in more than one requirement — "payments" occurs in
 * both "escalation point during a payments incident" (a must) and "prior work in
 * payments" (a nice). Taking the first match and judging its priority scores a
 * correct extraction as an error. Where several match, the one carrying the expected
 * priority is the one the label meant.
 */
function findMatch(label, requirements, expectedPriority = null) {
  const matches = findMatches(label, requirements);
  if (matches.length === 0) return null;
  if (!expectedPriority) return matches[0];
  return matches.find((requirement) => requirement.priority === expectedPriority) ?? matches[0];
}

/** Load every fixture, in filename order. */
async function loadFixtures() {
  const files = (await readdir(FIXTURES)).filter((name) => name.endsWith('.json')).sort();
  const cases = [];
  for (const file of files) {
    cases.push(JSON.parse(await readFile(join(FIXTURES, file), 'utf8')));
  }
  return cases;
}

/**
 * A provider that answers from disk when it can.
 *
 * It wraps the real provider rather than replacing it, so the cached shape is exactly
 * what the real one returns — a cache that stores a tidied-up version would score
 * something the pipeline never sees.
 */
function cachingProvider(real, fixtureId) {
  const file = join(CACHE, `${fixtureId}.${PROMPT_HASH}.json`);

  return {
    name: 'cached',
    model: real?.model ?? 'cached',
    async complete(request) {
      if (!REFRESH) {
        try {
          const cached = JSON.parse(await readFile(file, 'utf8'));
          return { data: cached.data, raw: null, text: JSON.stringify(cached.data), cached: true };
        } catch {
          // No usable cache entry; fall through to a real call.
        }
      }

      if (OFFLINE) {
        throw new Error(
          `No cached response for ${fixtureId} at prompt ${PROMPT_HASH}. ` +
            'Run without --offline to make the call.'
        );
      }
      if (!real) throw new Error('No provider configured. Set GEMINI_API_KEY, or use --offline.');

      liveCalls += 1;
      const result = await real.complete(request);
      await mkdir(CACHE, { recursive: true });
      await writeFile(
        file,
        `${JSON.stringify({ fixtureId, promptHash: PROMPT_HASH, at: new Date().toISOString(), data: result.data }, null, 2)}\n`
      );
      return { ...result, cached: false };
    },
    countTokens: async () => (real ? real.countTokens() : null),
  };
}

/** Score one fixture. */
function scoreCase(fixture, extraction) {
  const { requirements } = extraction;
  const expect = fixture.expect ?? {};
  const labelledMusts = expect.must ?? [];
  const labelledNices = expect.nice ?? [];
  const forbidden = expect.must_not_appear ?? [];

  // --- recall: labelled musts the model found at all ------------------------
  const mustHits = labelledMusts.map((label) => ({ label, match: findMatch(label, requirements, 'must') }));
  const foundMusts = mustHits.filter((hit) => hit.match !== null);
  const missedMusts = mustHits.filter((hit) => hit.match === null).map((hit) => hit.label);

  // --- precision: extracted musts that correspond to a labelled must --------
  const extractedMusts = requirements.filter((requirement) => requirement.priority === 'must');
  const justifiedMusts = extractedMusts.filter((requirement) =>
    labelledMusts.some((label) => labelMatches(label, requirement))
  );

  // --- priority accuracy: over every labelled item that was found -----------
  const niceHits = labelledNices.map((label) => ({ label, match: findMatch(label, requirements, 'nice') }));
  const priorityChecks = [
    ...foundMusts.map((hit) => ({ label: hit.label, want: 'must', got: hit.match.priority })),
    ...niceHits.filter((hit) => hit.match).map((hit) => ({ label: hit.label, want: 'nice', got: hit.match.priority })),
  ];
  const priorityCorrect = priorityChecks.filter((check) => check.want === check.got);
  const priorityWrong = priorityChecks.filter((check) => check.want !== check.got);

  // --- invention: a forbidden string, or a requirement with no evidence -----
  const inventions = [];
  for (const label of forbidden) {
    const match = findMatch(label, requirements);
    if (match) inventions.push({ kind: 'FORBIDDEN', label, requirement: match.text, id: match.id });
  }
  for (const requirement of requirements) {
    if (String(requirement.evidence ?? '').trim() === '') {
      inventions.push({ kind: 'NO_EVIDENCE', label: '', requirement: requirement.text, id: requirement.id });
    }
  }

  return {
    id: fixture.id,
    kept: requirements.length,
    mustRecall: labelledMusts.length === 0 ? 1 : foundMusts.length / labelledMusts.length,
    mustPrecision: extractedMusts.length === 0 ? 1 : justifiedMusts.length / extractedMusts.length,
    priorityAccuracy: priorityChecks.length === 0 ? 1 : priorityCorrect.length / priorityChecks.length,
    inventions,
    missedMusts,
    priorityWrong,
    labelledMusts: labelledMusts.length,
    extractedMusts: extractedMusts.length,
  };
}

function pct(value) {
  return `${(value * 100).toFixed(0)}%`;
}

function mark(value, target, higherIsBetter = true) {
  const ok = higherIsBetter ? value >= target : value <= target;
  return ok ? ' ' : '!';
}

async function main() {
  const fixtures = await loadFixtures();
  if (fixtures.length === 0) {
    process.stderr.write(`No fixtures found in ${FIXTURES}\n`);
    process.exit(1);
  }

  let real = null;
  if (!OFFLINE) {
    try {
      real = createGeminiProviderFromEnv();
    } catch (cause) {
      if (!REFRESH) {
        process.stdout.write(`No live provider (${cause.code ?? 'error'}); using cache only.\n\n`);
      } else {
        process.stderr.write(`Cannot refresh without a provider: ${cause.message}\n`);
        process.exit(1);
      }
    }
  }

  process.stdout.write(`extraction eval · prompt ${PROMPT_HASH} · ${fixtures.length} fixtures`);
  process.stdout.write(REFRESH ? ' · REFRESHING CACHE\n\n' : OFFLINE ? ' · offline\n\n' : '\n\n');

  const results = [];
  let calls = 0;

  for (const fixture of fixtures) {
    const provider = cachingProvider(real, fixture.id);
    let extraction;
    try {
      extraction = await extractRequirements(fixture.jd, {
        provider,
        spend: () => {
          calls += 1;
        },
      });
    } catch (cause) {
      process.stderr.write(`\n${fixture.id}: FAILED — ${cause.code ?? 'error'}: ${cause.message}\n`);
      process.exit(1);
    }
    results.push(scoreCase(fixture, extraction));
  }

  // --- per-case table --------------------------------------------------------
  const header = ['case', 'kept', 'recall', 'prec', 'prio', 'inv'];
  process.stdout.write(
    `${header[0].padEnd(22)}${header[1].padStart(5)}${header[2].padStart(9)}${header[3].padStart(8)}${header[4].padStart(8)}${header[5].padStart(6)}\n`
  );
  process.stdout.write(`${'-'.repeat(58)}\n`);

  for (const result of results) {
    process.stdout.write(
      result.id.padEnd(22) +
        String(result.kept).padStart(5) +
        `${pct(result.mustRecall)}${mark(result.mustRecall, TARGETS.mustRecall)}`.padStart(9) +
        `${pct(result.mustPrecision)}${mark(result.mustPrecision, TARGETS.mustPrecision)}`.padStart(8) +
        `${pct(result.priorityAccuracy)}${mark(result.priorityAccuracy, TARGETS.priorityAccuracy)}`.padStart(8) +
        `${`${result.inventions.length}${result.inventions.length > 0 ? '!' : ' '}`.padStart(6)}\n`
    );
  }

  // --- detail worth reading --------------------------------------------------
  for (const result of results) {
    const hasDetail =
      result.missedMusts.length > 0 || result.priorityWrong.length > 0 || result.inventions.length > 0;
    if (!hasDetail) continue;

    process.stdout.write(`\n${result.id}\n`);
    for (const label of result.missedMusts) {
      process.stdout.write(`  MISSED must   "${label}"\n`);
    }
    for (const wrong of result.priorityWrong) {
      process.stdout.write(`  PRIORITY      "${wrong.label}" labelled ${wrong.want}, extracted ${wrong.got}\n`);
    }
    for (const invention of result.inventions) {
      process.stdout.write(
        invention.kind === 'FORBIDDEN'
          ? `  INVENTED      "${invention.label}" appears in ${invention.id}: ${invention.requirement}\n`
          : `  NO EVIDENCE   ${invention.id}: ${invention.requirement}\n`
      );
    }
    // Printed in full: a legitimate requirement thrown away must be visible, not a
    // percentage. This is the line that tells you whether a drop was the guard working
    // or the prompt paraphrasing.
    for (const drop of result.dropped) {
      process.stdout.write(
        `  DROPPED       ${drop.id} (score ${drop.score}, ${drop.reason}) "${drop.evidence.slice(0, 70)}"\n`
      );
      if (drop.closestLine) process.stdout.write(`                closest: "${drop.closestLine.slice(0, 70)}"\n`);
    }
  }

  // --- summary ---------------------------------------------------------------
  const mean = (pick) => results.reduce((total, result) => total + pick(result), 0) / results.length;
  const totals = {
    mustRecall: mean((r) => r.mustRecall),
    mustPrecision: mean((r) => r.mustPrecision),
    priorityAccuracy: mean((r) => r.priorityAccuracy),
    inventions: results.reduce((total, r) => total + r.inventions.length, 0),
  };

  const line = (label, value, target, higherIsBetter = true) => {
    const ok = higherIsBetter ? value >= target : value <= target;
    return `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(20)} ${pct(value).padStart(5)}   target ${higherIsBetter ? '>=' : '<='} ${pct(target)}\n`;
  };

  process.stdout.write(
    `\n${'='.repeat(58)}\nSUMMARY · ${calls} extraction${calls === 1 ? '' : 's'} scored · ` +
      `${liveCalls} live model call${liveCalls === 1 ? '' : 's'}` +
      `${liveCalls === 0 ? ' (all from cache)' : ''}\n\n`
  );
  process.stdout.write(line('must-recall', totals.mustRecall, TARGETS.mustRecall));
  process.stdout.write(line('must-precision', totals.mustPrecision, TARGETS.mustPrecision));
  process.stdout.write(line('priority accuracy', totals.priorityAccuracy, TARGETS.priorityAccuracy));
  process.stdout.write(
    `  ${totals.inventions === 0 ? 'PASS' : 'FAIL'}  ${'invention count'.padEnd(20)} ${String(totals.inventions).padStart(5)}   target = 0 (non-negotiable)\n`
  );

  // Invention is the only non-negotiable, so it alone decides the exit code — the
  // others are targets to iterate against, and a harness that refused to run until
  // everything passed would be useless during the iteration it exists to support.
  if (totals.inventions > 0) {
    process.stdout.write('\nFAILED: extraction invented requirements the posting does not contain.\n');
    process.exit(1);
  }

  const belowTarget =
    totals.mustRecall < TARGETS.mustRecall ||
    totals.mustPrecision < TARGETS.mustPrecision ||
    totals.priorityAccuracy < TARGETS.priorityAccuracy;

  process.stdout.write(
    belowTarget
      ? '\nBelow target on at least one metric. Iterate the PROMPT, not the thresholds.\n'
      : '\nAll targets met.\n'
  );
  process.exit(0);
}

main().catch((cause) => {
  process.stderr.write(`eval:extraction failed — ${cause.message}\n`);
  process.exit(1);
});
