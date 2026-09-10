/**
 * extractRequirements.js — turn a job description into a list of requirements.
 *
 * Decides: what the posting asks for, how strongly it asks, and which phrase says so.
 *
 * Does NOT decide: whether the evidence holds up (verifyEvidence, wired in the next
 * unit), what questions to ask about a requirement (generateQuestions), or what to do
 * with a thin posting (the orchestrator). It never touches the database and does not
 * know Express exists.
 *
 * THE PRIORITY COMES FROM THE POSTING'S OWN WORDING, NOT FROM A JUDGEMENT ABOUT
 * IMPORTANCE. "Required", "you must have" and "5+ years of" are must. "Bonus points
 * for", "nice to have" and "a plus" are nice. This distinction is worth being pedantic
 * about because must-recall is the scored criterion: a must silently demoted to nice
 * drops out of the blocking coverage set, and the kit then reports full coverage while
 * missing the thing the candidate will actually be tested on.
 *
 * EVIDENCE MUST BE VERBATIM. Not a summary, not a tidied version — the exact substring
 * as it appears in the posting, punctuation and all. The next unit checks every quote
 * against the JD and drops what it cannot find, so a paraphrase here becomes a lost
 * requirement there. The prompt shows one right and one wrong example, because
 * "verbatim" alone is reliably interpreted as "close enough".
 *
 * A THIN POSTING PRODUCES A SHORT LIST. Two lines of JD cannot honestly yield eight
 * requirements, and padding one is worse than reporting the shortfall: every invented
 * requirement generates questions the candidate will waste preparation on.
 *
 * EVERY EXTRACTED REQUIREMENT IS CHECKED AGAINST THE POSTING BEFORE IT LEAVES.
 * verifyEvidence tries three tiers — exact after normalising, substring either way,
 * then content-word overlap — and a requirement that fails all three is DROPPED. This
 * is the fabrication guard, and it is deliberately the last thing that happens rather
 * than a hope pinned on the prompt.
 *
 * The drops are returned, never swallowed, because the drop RATE is the diagnostic that
 * matters: a few percent is paraphrase, and above roughly 5% the prompt is producing
 * evidence that is not in the posting. The fix at that point is the prompt, never the
 * threshold — loosening it converts a visible extraction fault into an invisible
 * fabrication-acceptance fault, and the requirements that slip through are exactly the
 * ones no candidate should prepare from.
 */

import { completeStructured } from '../llm/json.js';
import { safePrompt } from '../llm/safePrompt.js';
import { object, arrayOf, str, enumOf } from '../llm/schema.js';
import { REQUIREMENT_KINDS, REQUIREMENT_PRIORITIES } from '../contracts/kitSchema.js';
import { nextIds } from '../contracts/ids.js';
import { verifyEvidence, dropRate } from '../deterministic/verifyEvidence.js';
import { badInput, invalidOutput, asGenerationError } from './errors.js';

const STEP = 'extract-requirements';

/** Below this, a posting is a stub and is reported as one. */
export const THIN_JD_CHARS = 400;

/** More than this from one posting means the model is inventing, not extracting. */
const MAX_REQUIREMENTS = 20;

/**
 * Two requirements this similar are the same requirement worded twice.
 *
 * 0.75 rather than 0.85 because one extra word is common in a restatement:
 * "mentoring junior engineers" against "mentoring junior engineers daily" scores 0.75
 * exactly, and those are plainly one requirement. Going lower starts merging genuinely
 * different requirements that share a stem — "3 years React" and "3 years Vue" sit at
 * 0.5, and that gap is the safety margin.
 */
const DEDUPE_SIMILARITY = 0.75;

export const REQUIREMENTS_SCHEMA = object({
  requirements: arrayOf(
    object({
      text: str('The requirement in one clear sentence, as the posting means it.'),
      kind: enumOf(
        REQUIREMENT_KINDS,
        'technical for tools, languages and systems; behavioural for how the person works with others; domain for industry or subject knowledge.'
      ),
      priority: enumOf(
        REQUIREMENT_PRIORITIES,
        'must if the posting states it as required; nice if the posting frames it as optional, bonus or desirable.'
      ),
      evidence: str(
        'The EXACT substring from the posting that states this requirement, copied character for character. Never a paraphrase.'
      ),
    }),
    'One entry per distinct requirement stated in the posting.'
  ),
});

/**
 * The extraction prompt.
 *
 * Exported because the eval harness caches model responses keyed by a hash of this
 * string: a scoring-logic change must re-score for free, while a PROMPT change must
 * invalidate every cached response. Tying the cache key to the prompt itself makes
 * that automatic rather than a thing someone has to remember.
 */
export const EXTRACTION_SYSTEM_INSTRUCTION = [
  'You extract hiring requirements from a job posting. You do not invent, infer or',
  'improve on what the posting says.',
  '',
  'PRIORITY IS DECIDED BY THE POSTING\'S WORDING, not by how important the skill seems.',
  '  must  — "required", "must have", "you have", "we need", "N+ years of", "essential",',
  '          "strong experience with", or the requirement sitting under a heading like',
  '          "Requirements" or "What you will need".',
  '  nice  — "bonus", "bonus points for", "nice to have", "a plus", "desirable",',
  '          "ideally", "we would love", "familiarity with ... is a plus", or the',
  '          requirement sitting under "Nice to have" / "Bonus".',
  'If the wording is genuinely ambiguous, choose must only when the posting places it',
  'among stated requirements; otherwise choose nice.',
  '',
  'KIND:',
  '  technical    — languages, frameworks, tools, systems, engineering practices',
  '  behavioural  — collaboration, mentoring, communication, ownership, ways of working',
  '  domain       — industry, subject-matter or regulatory knowledge',
  '',
  'EVIDENCE MUST BE A VERBATIM QUOTE from the posting — the exact characters, including',
  'punctuation and capitalisation. It is checked against the posting automatically and a',
  'requirement whose evidence cannot be found is DISCARDED.',
  '',
  '  Posting line:  "• 5+ years’ experience with React and TypeScript"',
  '  CORRECT evidence: "5+ years’ experience with React and TypeScript"',
  '  WRONG evidence:   "five or more years of React experience"   (reworded)',
  '  WRONG evidence:   "React and TypeScript experience required"  (recombined)',
  '',
  'You may drop the bullet marker, but nothing else.',
  '',
  'EXTRACT ONLY WHAT IS THERE. A short posting yields a short list. Do not pad it with',
  'requirements that are typical for the role but absent from this posting. Returning',
  'three requirements for a three-line posting is correct.',
].join('\n');

/** Normalise for comparison when de-duplicating. */
function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s+#.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(['a', 'an', 'and', 'the', 'with', 'of', 'in', 'to', 'for', 'or', 'is', 'are', 'you', 'we']);

/**
 * Content words, crudely singularised.
 *
 * "skills" and "skill" are the same word for this purpose, and without the trim they
 * score as a mismatch — which is how "Strong React skills" and "Strong React skill"
 * survive de-duplication as two requirements. Naive on purpose: a real stemmer is a
 * dependency, and the cost of over-trimming here is bounded by the similarity
 * threshold rather than by the trim itself.
 */
function contentWords(text) {
  return new Set(
    normalise(text)
      .split(' ')
      .filter((word) => word && !STOPWORDS.has(word))
      .map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word))
  );
}

function similarity(left, right) {
  const a = contentWords(left);
  const b = contentWords(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Collapse requirements that say the same thing twice.
 *
 * Deterministic and done in code, not by the model: "which of these two are the same?"
 * is set arithmetic once the texts are normalised, and asking a model would cost a call
 * and give a different answer on a different day. When two collide, the must-priority
 * one wins — demoting a must to nice by accident is the expensive direction.
 */
export function dedupeRequirements(requirements) {
  const kept = [];
  const merged = [];

  for (const candidate of requirements) {
    // Identical evidence is the stronger signal, so it is checked first. Two entries
    // quoting the same phrase came from the same line of the posting, however
    // differently they were worded — "5+ years with React" and "Five or more years of
    // React" score only 0.5 on word overlap but are plainly one requirement. Text
    // similarity alone would keep both and inflate the requirement count.
    const evidenceKey = normalise(candidate.evidence);

    let duplicateIndex = -1;
    if (evidenceKey !== '') {
      duplicateIndex = kept.findIndex((existing) => normalise(existing.evidence) === evidenceKey);
    }
    if (duplicateIndex === -1) {
      duplicateIndex = kept.findIndex(
        (existing) => similarity(existing.text, candidate.text) >= DEDUPE_SIMILARITY
      );
    }

    if (duplicateIndex === -1) {
      kept.push({ ...candidate });
      continue;
    }

    const existing = kept[duplicateIndex];
    merged.push({ kept: existing.text, dropped: candidate.text });

    if (existing.priority !== 'must' && candidate.priority === 'must') {
      // Keep the stronger claim: a must wrongly demoted drops out of blocking coverage.
      kept[duplicateIndex] = { ...existing, priority: 'must', evidence: candidate.evidence };
    }
  }

  return { requirements: kept, merged };
}

/** Reject anything the schema cannot catch, naming the offending entry. */
function validateEntries(entries) {
  if (!Array.isArray(entries)) {
    throw invalidOutput(STEP, 'The model did not return a requirements array.');
  }

  return entries
    .map((entry, index) => {
      const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
      const evidence = typeof entry?.evidence === 'string' ? entry.evidence.trim() : '';
      const kind = typeof entry?.kind === 'string' ? entry.kind.trim() : '';
      const priority = typeof entry?.priority === 'string' ? entry.priority.trim() : '';

      if (text === '') return null; // A requirement with no text is not a requirement.

      if (!REQUIREMENT_KINDS.includes(kind)) {
        throw invalidOutput(STEP, `requirements[${index}].kind is "${kind}", not one of ${REQUIREMENT_KINDS.join(' | ')}.`, { entry });
      }
      if (!REQUIREMENT_PRIORITIES.includes(priority)) {
        throw invalidOutput(STEP, `requirements[${index}].priority is "${priority}", not one of ${REQUIREMENT_PRIORITIES.join(' | ')}.`, { entry });
      }

      return { text, kind, priority, evidence };
    })
    .filter(Boolean);
}

/**
 * Extract requirements from a job description.
 *
 * @param {string} jdText the pasted posting — untrusted, routed through safePrompt
 * @param {object} options
 * @param {{ complete: Function }} options.provider
 * @param {() => void} [options.spend] budget hook
 * @param {(event: object) => void} [options.onRepair]
 * @param {(drop: object) => void} [options.onDrop] called once per unsupported
 *   requirement, so the eval harness sees every drop without core doing any logging
 * @param {boolean} [options.verify=true] set false only to inspect raw extraction; a
 *   real run must never skip the fabrication guard
 * @returns {Promise<{
 *   requirements: object[], thin: boolean, note: string, merged: object[],
 *   dropped: object[], dropRate: number, evidence: object[]
 * }>}
 */
export async function extractRequirements(jdText, { provider, spend, onRepair, onDrop, verify = true } = {}) {
  if (typeof jdText !== 'string' || jdText.trim() === '') {
    throw badInput(STEP, 'A job description is required.');
  }
  if (!provider || typeof provider.complete !== 'function') {
    throw badInput(STEP, 'A provider is required.');
  }

  const trimmed = jdText.trim();
  const thin = trimmed.length < THIN_JD_CHARS;

  const wrapped = safePrompt({ text: trimmed, kind: 'jd', label: 'pasted job description' });

  let answer;
  try {
    answer = await completeStructured({
      provider,
      request: {
        systemInstruction: EXTRACTION_SYSTEM_INSTRUCTION,
        contents: wrapped.text,
        responseSchema: REQUIREMENTS_SCHEMA,
      },
      step: STEP,
      spend,
      onRepair,
    });
  } catch (cause) {
    throw asGenerationError(cause, STEP);
  }

  const entries = validateEntries(answer?.requirements);
  const { requirements: deduped, merged } = dedupeRequirements(entries);

  const capped = deduped.slice(0, MAX_REQUIREMENTS);

  // Ids are assigned BEFORE verification so a drop can be reported by id, and so the
  // surviving requirements keep the numbering they were extracted with. Renumbering
  // after a drop would be tidier to look at and would mean r3 in the drop log is a
  // different requirement from r3 in the kit.
  const ids = nextIds('r', capped.length, []);
  const withIds = capped.map((entry, index) => ({ id: ids[index], ...entry }));

  let requirements = withIds;
  let dropped = [];
  let evidence = [];
  let rate = 0;

  if (verify) {
    const verdict = verifyEvidence(trimmed, withIds, { onDrop });
    const unsupported = new Set(verdict.unsupported);

    requirements = withIds.filter((requirement) => !unsupported.has(requirement.id));
    dropped = verdict.drops.map((drop) => {
      const source = withIds.find((requirement) => requirement.id === drop.id);
      return { ...drop, text: source?.text ?? '', priority: source?.priority ?? null };
    });
    evidence = verdict.matches;
    rate = dropRate(verdict);
  }

  const notes = [];
  if (dropped.length > 0) {
    const droppedMusts = dropped.filter((drop) => drop.priority === 'must').length;
    notes.push(
      `${dropped.length} requirement(s) were dropped because their evidence could not be ` +
        `found in the posting (${(rate * 100).toFixed(0)}% of those extracted` +
        `${droppedMusts > 0 ? `, ${droppedMusts} of them must-priority` : ''}).`
    );
  }
  if (thin) {
    notes.push(
      `The posting is ${trimmed.length} characters, below the ${THIN_JD_CHARS}-character ` +
        'threshold for a full description. The requirement list is short because the ' +
        'posting is short, not because extraction failed.'
    );
  }
  if (merged.length > 0) notes.push(`${merged.length} near-duplicate requirement(s) merged.`);
  if (deduped.length > MAX_REQUIREMENTS) {
    notes.push(`Capped at ${MAX_REQUIREMENTS} requirements; ${deduped.length} were returned.`);
  }
  if (wrapped.truncated) {
    notes.push(`The posting was truncated to ${wrapped.includedLength} characters for the model.`);
  }

  return { requirements, thin, note: notes.join(' '), merged, dropped, dropRate: rate, evidence };
}
