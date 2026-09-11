/**
 * merge.js — fold a regenerated section into an existing kit without destroying a
 * person's work.
 *
 * Decides: which items a regeneration replaces, which it leaves alone, and what id a
 * replacement carries.
 *
 * Does NOT decide: whether to regenerate, what the new content is, or how the result is
 * stored. It is a pure function over plain objects — no database, no model, no clock
 * except an injectable one — which is why it could be written and tested before any route
 * existed. A merge that needed a request to run would only ever be tested through one.
 *
 * THE FOUR RULES, AND THE REASON EACH EXISTS:
 *
 *   1. A regeneration replaces ONLY items that are `generated` and unpinned.
 *      An edit is the most valuable content in a kit — the one part a person spent
 *      attention on — and a background regeneration landing on top of it is the exact
 *      accident the brief calls out. `isReplaceable` is the single authority.
 *
 *   2. Regenerating one section never touches another.
 *      Regenerating the technical questions must leave behavioural alone, the brief
 *      alone, the flashcards alone. The scope of a merge is the scope the caller asked
 *      for, narrowed by what it is allowed to touch — never widened.
 *
 *   3. A replacement REUSES THE ID IT REPLACES.
 *      This is the rule with the least obvious consequence and the worst failure mode.
 *      `schedule.days[].question_ids` references question ids; so does
 *      `coverage.uncovered_requirement_ids` for requirements. Assign a fresh id to a
 *      regenerated question and every schedule reference to the old one dangles —
 *      `validateKit` then rejects the kit, and the user sees their whole kit break
 *      because they asked for better questions. Reusing the id keeps the graph intact.
 *
 *   4. After any merge the question set has changed, so coverage and the schedule are
 *      RECOMPUTED, never carried over. Both are pure functions of the questions; keeping
 *      a stale schedule is how a kit ends up scheduling a question it no longer contains.
 *
 * The merge reports what it did. A caller that cannot say "three replaced, two kept
 * because you edited them" cannot explain itself to a user, and an unexplained
 * disappearance looks exactly like a bug.
 */

import { isReplaceable, withProvenance, ORIGINS, BRIEF_FIELDS, briefProvenance } from './provenance.js';
import { findGaps } from '../deterministic/coverage.js';
import { allocate } from '../deterministic/scheduleAllocator.js';
import { nextIds } from './ids.js';

/** Sections a caller may regenerate. */
export const MERGEABLE_SECTIONS = Object.freeze(['company_brief', 'questions', 'flashcards', 'schedule']);

/**
 * Merge a regenerated set of questions into a kit.
 *
 * @param {object} options
 * @param {object} options.kit the existing kit — NOT mutated
 * @param {object[]} options.incoming freshly generated questions
 * @param {string} [options.category] restrict the merge to one category. Omit to treat
 *   the incoming set as covering every category it mentions.
 * @param {string} [options.updatedAt]
 * @returns {{ questions: object[], replaced: string[], kept: string[], added: string[], removed: string[] }}
 */
export function mergeQuestions({ kit, incoming, category = null, updatedAt } = {}) {
  const existing = Array.isArray(kit?.questions) ? kit.questions : [];
  const fresh = Array.isArray(incoming) ? incoming : [];

  // Rule 2: the merge only ever considers items inside the requested scope. Anything
  // outside it is copied through untouched, without being examined.
  const inScope = (question) => (category === null ? true : question?.category === category);

  const survivors = [];
  const replaced = [];
  const kept = [];
  const removed = [];

  /** Incoming questions not yet used to replace an existing one. */
  const available = [...fresh];

  for (const question of existing) {
    if (!inScope(question)) {
      survivors.push(question);
      continue;
    }

    if (!isReplaceable(question)) {
      // Rule 1: edited, manual or pinned items survive a regeneration untouched.
      survivors.push(question);
      kept.push(question.id);
      continue;
    }

    // Rule 3: the replacement inherits this item's id, so every schedule reference to it
    // stays valid. Matching by requirement first keeps a replacement about the same
    // requirement as the question it replaces.
    const matchIndex = findReplacement(available, question);
    if (matchIndex === -1) {
      // Nothing came back for this slot. A regeneration that returned less than it
      // replaced removes the surplus rather than keeping a stale question the caller
      // explicitly asked to replace.
      removed.push(question.id);
      continue;
    }

    const [replacement] = available.splice(matchIndex, 1);
    survivors.push(
      withProvenance(
        { ...replacement, id: question.id, category: replacement.category ?? question.category },
        { origin: ORIGINS.GENERATED, pinned: false, updatedAt }
      )
    );
    replaced.push(question.id);
  }

  // Anything left over is genuinely new and needs an id that collides with nothing —
  // including the ids of questions this merge just preserved.
  const usedIds = survivors.map((question) => question.id);
  const newIds = nextIds('q', available.length, usedIds);
  const added = [];

  available.forEach((question, index) => {
    const id = newIds[index];
    survivors.push(
      withProvenance({ ...question, id }, { origin: ORIGINS.GENERATED, pinned: false, updatedAt })
    );
    added.push(id);
  });

  return { questions: survivors, replaced, kept, added, removed };
}

/**
 * Which incoming question should take this slot?
 *
 * Prefer one about the same requirement: a regenerated question that replaces a question
 * about a different requirement would silently move coverage around, and the schedule
 * reference it inherits would then point at material about something else.
 */
function findReplacement(available, question) {
  const wanted = Array.isArray(question?.requirement_ids) ? question.requirement_ids : [];

  const sameRequirement = available.findIndex((candidate) =>
    (Array.isArray(candidate?.requirement_ids) ? candidate.requirement_ids : []).some((id) =>
      wanted.includes(id)
    )
  );
  if (sameRequirement !== -1) return sameRequirement;

  // No incoming question covers this requirement. Falling back to the first available one
  // would reassign coverage; leaving the slot empty is the honest outcome, and the
  // coverage pass will notice.
  return -1;
}

/**
 * Merge regenerated flashcards. Same rules, simpler because nothing references a card.
 */
export function mergeFlashcards({ kit, incoming, updatedAt } = {}) {
  const existing = Array.isArray(kit?.flashcards) ? kit.flashcards : [];
  const fresh = Array.isArray(incoming) ? incoming : [];

  const survivors = [];
  const replaced = [];
  const kept = [];
  const available = [...fresh];

  for (const card of existing) {
    if (!isReplaceable(card)) {
      survivors.push(card);
      kept.push(card.id);
      continue;
    }
    const next = available.shift();
    if (!next) continue;
    survivors.push(withProvenance({ ...next, id: card.id }, { origin: ORIGINS.GENERATED, pinned: false, updatedAt }));
    replaced.push(card.id);
  }

  const newIds = nextIds('f', available.length, survivors.map((card) => card.id));
  const added = [];
  available.forEach((card, index) => {
    survivors.push(withProvenance({ ...card, id: newIds[index] }, { origin: ORIGINS.GENERATED, pinned: false, updatedAt }));
    added.push(newIds[index]);
  });

  return { flashcards: survivors, replaced, kept, added };
}

/**
 * Merge a regenerated company brief, field by field.
 *
 * The brief's fields are strings, so their provenance lives in a parallel map. A field a
 * person edited keeps both its text and its `edited` marker; a generated one is replaced.
 * `sources` is never taken from the incoming brief — provenance belongs to the ledger,
 * and a regeneration cannot add a URL nobody fetched.
 */
export function mergeCompanyBrief({ kit, incoming, updatedAt } = {}) {
  const existing = kit?.company_brief ?? {};
  const provenance = briefProvenance(existing.provenance);

  const merged = { ...existing };
  const replaced = [];
  const kept = [];

  for (const field of BRIEF_FIELDS) {
    if (isReplaceable(provenance[field])) {
      if (typeof incoming?.[field] === 'string') {
        merged[field] = incoming[field];
        provenance[field] = withProvenance({}, { origin: ORIGINS.GENERATED, pinned: false, updatedAt });
        replaced.push(field);
      }
    } else {
      kept.push(field);
    }
  }

  // Sources stay as they were: the ledger decides what was fetched, not a regeneration.
  merged.sources = Array.isArray(existing.sources) ? existing.sources : [];
  merged.provenance = provenance;

  return { company_brief: merged, replaced, kept };
}

/**
 * Recompute everything that depends on the question set.
 *
 * Rule 4. Coverage and the schedule are pure functions of the requirements and questions,
 * so after a merge they are derived again rather than carried over. A pinned schedule day
 * is the one exception, and it is handled by re-applying pinned days over the fresh
 * allocation: the allocator cannot know a person arranged day 3 deliberately.
 *
 * @param {object} kit a kit whose questions have already been merged — NOT mutated
 * @returns {object} a new kit with coverage and schedule recomputed
 */
export function recomputeDerived(kit, { updatedAt } = {}) {
  const requirements = Array.isArray(kit?.role?.requirements) ? kit.role.requirements : [];
  const questions = Array.isArray(kit?.questions) ? kit.questions : [];
  const daysAvailable = kit?.schedule?.days_available ?? 0;

  const gaps = findGaps(requirements, questions);
  const fresh = allocate({ questions, requirements, daysAvailable });

  // Re-apply any day a person pinned or hand-arranged, keeping its own content but
  // dropping references to questions that no longer exist — a pinned day is a statement
  // about arrangement, not a licence to reference deleted material.
  const questionIds = new Set(questions.map((question) => question.id));
  const previousDays = Array.isArray(kit?.schedule?.days) ? kit.schedule.days : [];

  const days = fresh.days.map((day) => {
    const previous = previousDays.find((candidate) => candidate.day === day.day);
    if (!previous || isReplaceable(previous)) return withProvenance(day, { updatedAt });

    return withProvenance(
      {
        ...previous,
        question_ids: (Array.isArray(previous.question_ids) ? previous.question_ids : []).filter((id) =>
          questionIds.has(id)
        ),
      },
      { origin: previous.origin, pinned: previous.pinned, updatedAt: previous.updatedAt }
    );
  });

  return {
    ...kit,
    schedule: { days_available: fresh.days_available, days },
    coverage: {
      uncovered_requirement_ids: gaps.uncovered_requirement_ids,
      // A merge is not a generation pass. The count records passes the pipeline ran, and
      // inflating it here would misreport how hard the system worked.
      passes: kit?.coverage?.passes ?? 0,
    },
  };
}

/**
 * The whole operation: merge one section, then recompute what depends on it.
 *
 * @param {object} options
 * @param {object} options.kit
 * @param {'company_brief'|'questions'|'flashcards'} options.section
 * @param {object|object[]} options.incoming
 * @param {string} [options.category] for questions, restrict to one category
 * @param {string} [options.updatedAt]
 * @returns {{ kit: object, report: object }}
 */
export function mergeSection({ kit, section, incoming, category = null, updatedAt } = {}) {
  if (!MERGEABLE_SECTIONS.includes(section)) {
    throw new Error(
      `MERGE_UNKNOWN_SECTION: "${section}" is not mergeable. Expected one of ${MERGEABLE_SECTIONS.join(', ')}.`
    );
  }

  const stamp = updatedAt ?? new Date().toISOString();
  let next = { ...kit };
  let report;

  if (section === 'questions') {
    const result = mergeQuestions({ kit, incoming, category, updatedAt: stamp });
    next.questions = result.questions;
    report = { section, category, ...result, questions: undefined };
  } else if (section === 'flashcards') {
    const result = mergeFlashcards({ kit, incoming, updatedAt: stamp });
    next.flashcards = result.flashcards;
    report = { section, ...result, flashcards: undefined };
  } else if (section === 'company_brief') {
    const result = mergeCompanyBrief({ kit, incoming, updatedAt: stamp });
    next.company_brief = result.company_brief;
    report = { section, ...result, company_brief: undefined };
  } else {
    // schedule: nothing to merge in, only to recompute — a caller regenerating the
    // schedule is asking for a fresh allocation over the questions it already has.
    report = { section, replaced: [], kept: [] };
  }

  // Rule 4, applied for every section: the question set may have changed, and for the
  // brief it has not — but recomputing an unchanged input is free and removes the need
  // for each branch to remember whether it matters.
  next = recomputeDerived(next, { updatedAt: stamp });

  return { kit: next, report };
}
