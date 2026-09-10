/**
 * generateFlashcards.js — recall prompts for the things worth memorising.
 *
 * Decides: which requirements deserve a flashcard, and what goes on each side.
 *
 * Does NOT decide: whether there is time to make them. This step is OPTIONAL under the
 * time governor and under the call budget — the orchestrator skips it when the clock
 * or the budget is tight, and the kit records that it was skipped. That is why nothing
 * downstream may assume flashcards exist.
 *
 * A FLASHCARD IS NOT A SHORT QUESTION. The questions in this kit are things an
 * interviewer asks; a flashcard is a thing the candidate drills — a term, a mechanism,
 * a number, a trade-off with a name. "Describe a time you mentored someone" is a
 * question and makes a terrible flashcard, because the back would be the candidate's
 * own story rather than a fact. The prompt draws that line explicitly, and the router
 * below refuses behavioural requirements for the same reason: a card whose answer is
 * "it depends on your experience" is a card nobody can revise from.
 */

import { completeStructured } from '../llm/json.js';
import { safePrompt } from '../llm/safePrompt.js';
import { object, arrayOf, str } from '../llm/schema.js';
import { nextIds } from '../contracts/ids.js';
import { badInput, invalidOutput, asGenerationError } from './errors.js';

const STEP = 'flashcards';

/** More than this is a revision deck, not a prep kit. */
const MAX_FLASHCARDS = 16;

export const FLASHCARDS_SCHEMA = object({
  flashcards: arrayOf(
    object({
      requirement_id: str('The id of the requirement this card drills, copied exactly.'),
      front: str('The prompt side: a term, mechanism or question with one definite answer.'),
      back: str('The answer side: two or three sentences at most. A fact, not an essay.'),
    }),
    'One or two cards per requirement that supports drilling. Skip requirements that do not.'
  ),
});

const SYSTEM_INSTRUCTION = [
  'You write flashcards for a candidate revising for an interview.',
  '',
  'A flashcard has ONE definite answer. Terms, mechanisms, numbers, named trade-offs,',
  'the difference between two things that are easily confused.',
  '',
  '  GOOD front: "What does back-pressure mean in a streaming pipeline?"',
  '  GOOD back:  "The consumer signalling the producer to slow down, so a slow',
  '               consumer bounds the producer rather than buffering without limit."',
  '',
  '  BAD front:  "Describe a time you mentored a junior engineer."',
  '              — the answer is the candidate\'s own story, not a fact. Not a card.',
  '  BAD back:   "It depends on the situation and your experience."',
  '              — nothing to revise.',
  '',
  'Skip any requirement that does not support a card with a definite answer. Returning',
  'six good cards for ten requirements is correct; padding to ten is not.',
  '',
  'The back is two or three sentences. If it needs more, it is a question, not a card.',
].join('\n');

/**
 * Which requirements can carry a flashcard at all.
 *
 * Deterministic, and done before the call rather than asked of the model: behavioural
 * requirements produce cards whose answer is the candidate's own history, which is not
 * revisable. Filtering here also shortens the prompt, which is free accuracy.
 */
export function flashcardCandidates(requirements = []) {
  return (Array.isArray(requirements) ? requirements : []).filter(
    (requirement) =>
      requirement &&
      typeof requirement.id === 'string' &&
      String(requirement.text ?? '').trim() !== '' &&
      requirement.kind !== 'behavioural'
  );
}

/**
 * Generate flashcards.
 *
 * @param {object} input
 * @param {object[]} input.requirements
 * @param {object[]} [input.questions] existing questions, so cards complement rather
 *   than restate them
 * @param {string[]} [input.existingIds]
 * @param {object} options
 * @param {{ complete: Function }} options.provider
 * @param {() => void} [options.spend]
 * @returns {Promise<{ flashcards: object[], rejected: object[], skipped: string }>}
 */
export async function generateFlashcards(
  { requirements = [], questions = [], existingIds = [] } = {},
  { provider, spend, onRepair } = {}
) {
  const candidates = flashcardCandidates(requirements);

  // Nothing drillable is a complete answer, and costs no call.
  if (candidates.length === 0) {
    return {
      flashcards: [],
      rejected: [],
      skipped: 'No requirements support a flashcard with a definite answer.',
    };
  }

  if (!provider || typeof provider.complete !== 'function') {
    throw badInput(STEP, 'A provider is required.');
  }

  const lines = ['REQUIREMENTS'];
  for (const requirement of candidates) {
    lines.push(`  id: ${requirement.id}`);
    lines.push(`    requirement: ${requirement.text}`);
    lines.push(`    kind: ${requirement.kind ?? 'unstated'}`);
  }

  if (Array.isArray(questions) && questions.length > 0) {
    lines.push('', 'QUESTIONS ALREADY IN THE KIT — complement these, do not restate them');
    for (const question of questions.slice(0, 20)) {
      lines.push(`  - ${question.prompt}`);
    }
  }

  const wrapped = safePrompt({
    text: lines.join('\n'),
    kind: 'default',
    label: 'flashcard source material',
    limit: 10_000,
  });

  let answer;
  try {
    answer = await completeStructured({
      provider,
      request: {
        systemInstruction: SYSTEM_INSTRUCTION,
        contents: wrapped.text,
        responseSchema: FLASHCARDS_SCHEMA,
      },
      step: STEP,
      spend,
      onRepair,
    });
  } catch (cause) {
    throw asGenerationError(cause, STEP);
  }

  if (!Array.isArray(answer?.flashcards)) {
    throw invalidOutput(STEP, 'The model did not return a flashcards array.');
  }

  const known = new Set(candidates.map((requirement) => requirement.id));
  const accepted = [];
  const rejected = [];

  answer.flashcards.forEach((entry, index) => {
    const requirementId = typeof entry?.requirement_id === 'string' ? entry.requirement_id.trim() : '';
    const front = typeof entry?.front === 'string' ? entry.front.trim() : '';
    const back = typeof entry?.back === 'string' ? entry.back.trim() : '';

    if (!known.has(requirementId)) {
      rejected.push({ index, reason: 'UNKNOWN_REQUIREMENT_ID', requirementId });
      return;
    }
    if (front === '' || back === '') {
      rejected.push({ index, reason: 'EMPTY_SIDE', requirementId });
      return;
    }
    accepted.push({ front, back, requirement_ids: [requirementId] });
  });

  const capped = accepted.slice(0, MAX_FLASHCARDS);
  const ids = nextIds('f', capped.length, existingIds);
  const flashcards = capped.map((card, index) => ({ id: ids[index], ...card }));

  return { flashcards, rejected, skipped: '' };
}
