/**
 * kitView.js — a finished kit, arranged for reading.
 *
 * Decides: how a kit's sections are grouped, ordered and put into words on screen —
 * questions by category in the contract's order, schedule days with their questions
 * resolved, coverage gaps as sentences, and what each item's provenance badge says.
 *
 * Does NOT decide: anything about the kit itself. No validation, no coverage computation,
 * no scheduling — those run on the server in `packages/core` and arrive inside the kit.
 * This module only arranges what arrived. If the kit says a requirement is uncovered,
 * this module says so in a sentence; it never decides whether it is.
 *
 * THE CATEGORY, KIND AND PRIORITY NAMES ARE MIRRORED, NOT INVENTED. They are the frozen
 * contract's enums, spelled exactly — British "behavioural", hyphenated "system-design"
 * and "company-fit". The client does not import `@aipk/core` (invariant 36), so the
 * strings are copied here, and a test imports the real enums and asserts they match: a
 * drift fails in the test suite rather than as a question silently filed under nothing.
 *
 * ALL FOUR QUESTION GROUPS ARE ALWAYS RETURNED, INCLUDING EMPTY ONES. An empty category
 * is still a place a person can add a question by hand or regenerate into, and hiding it
 * would make "there are no company-fit questions" invisible — the kind of gap this
 * screen exists to show rather than tidy away.
 */

export const QUESTION_CATEGORY_ORDER = Object.freeze(['technical', 'behavioural', 'system-design', 'company-fit']);

export const CATEGORY_LABELS = Object.freeze({
  technical: 'Technical',
  behavioural: 'Behavioural',
  'system-design': 'System design',
  'company-fit': 'Company fit',
});

export const KIND_LABELS = Object.freeze({
  technical: 'Technical',
  behavioural: 'Behavioural',
  domain: 'Domain',
});

export const PRIORITY_LABELS = Object.freeze({
  must: 'Must have',
  nice: 'Nice to have',
});

/** Difficulty is an integer 1–3 in the contract; a word makes it scannable. */
export const DIFFICULTY_LABELS = Object.freeze({ 1: 'Warm-up', 2: 'Core', 3: 'Stretch' });

/** Schedule day kinds, as the allocator marks them. */
export const DAY_KIND_LABELS = Object.freeze({
  new: 'New material',
  review: 'Review',
  empty: 'Nothing scheduled',
});

/**
 * A section that is absent from a kit which otherwise loaded.
 *
 * Shaped like the client's error type so `ErrorState` renders it the same way — code in
 * small print, a sentence a person can read — and carrying no `status`, so no retry is
 * offered: re-reading the kit would return the same kit.
 */
export const SECTION_MISSING = Object.freeze({
  code: 'SECTION_MISSING',
  message: 'This section is missing from the kit, so there is nothing to show here. The rest of the kit is unaffected.',
});

/** Group questions by category, in contract order, always returning all four groups. */
export function groupQuestions(questions) {
  const list = Array.isArray(questions) ? questions : [];

  const groups = QUESTION_CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    questions: list.filter((question) => question?.category === category),
  }));

  // A category outside the enum cannot pass the server's validation, so this should
  // never fire. If it does, those questions are shown under their own name rather than
  // silently dropped — losing a question on screen is worse than an ugly heading.
  const unknown = [
    ...new Set(list.map((question) => question?.category).filter((c) => c && !QUESTION_CATEGORY_ORDER.includes(c))),
  ];
  for (const category of unknown) {
    groups.push({ category, label: category, questions: list.filter((question) => question?.category === category) });
  }

  return groups;
}

/** Requirements by id, for resolving the ids questions and coverage refer to. */
export function indexRequirements(requirements) {
  return new Map((Array.isArray(requirements) ? requirements : []).map((requirement) => [requirement.id, requirement]));
}

/**
 * The provenance badges an item carries.
 *
 * `generated` shows nothing on purpose. Every item starts generated, so a badge on each
 * would be noise on twenty-two rows — and its absence is what makes "Edited" and "Added
 * by you" stand out, which matters because those are the items a regeneration will NOT
 * overwrite.
 */
export function provenanceBadges(item) {
  const badges = [];
  if (item?.origin === 'edited') badges.push({ key: 'edited', text: 'Edited' });
  if (item?.origin === 'manual') badges.push({ key: 'manual', text: 'Added by you' });
  if (item?.pinned === true) badges.push({ key: 'pinned', text: 'Pinned' });
  return badges;
}

/** "2 h 10 min", "2 h", "50 min". Minutes are integers in the contract. */
export function formatMinutes(minutes) {
  const total = Number.isInteger(minutes) && minutes > 0 ? minutes : 0;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * The coverage panel's content, in plain language.
 *
 * Must-have gaps are listed first, because those are the requirements a candidate is
 * actually tested on. An id that no longer resolves to a requirement is still reported —
 * as exactly that — rather than dropped, because a coverage panel that quietly shows
 * fewer gaps than the kit recorded is the one thing it must never do.
 */
export function describeCoverage(coverage, requirements) {
  const index = indexRequirements(requirements);
  const ids = Array.isArray(coverage?.uncovered_requirement_ids) ? coverage.uncovered_requirement_ids : [];
  const passes = Number.isInteger(coverage?.passes) ? coverage.passes : 0;

  const gaps = ids.map((id) => {
    const requirement = index.get(id);
    if (!requirement) {
      return {
        id,
        text: null,
        priority: null,
        kind: null,
        sentence: `A requirement (${id}) that no longer appears in the role breakdown has no question.`,
      };
    }
    const weight = requirement.priority === 'must' ? 'a must-have' : 'a nice-to-have';
    return {
      id,
      text: requirement.text,
      priority: requirement.priority,
      kind: requirement.kind,
      sentence: `No question covers “${requirement.text}” yet — ${weight}.`,
    };
  });

  // Array.prototype.sort is stable, so gaps keep their recorded order within each group.
  gaps.sort((a, b) => (a.priority === 'must' ? 0 : 1) - (b.priority === 'must' ? 0 : 1));

  const mustGaps = gaps.filter((gap) => gap.priority === 'must').length;

  let summary;
  if (gaps.length === 0) {
    summary = 'Every requirement has at least one question.';
  } else {
    const count = gaps.length === 1 ? '1 requirement has' : `${gaps.length} requirements have`;
    summary =
      mustGaps > 0
        ? `${count} no question yet, ${mustGaps === gaps.length ? (gaps.length === 1 ? 'and it is a must-have' : 'all of them must-haves') : `${mustGaps} of them must-haves`}.`
        : `${count} no question yet, none of them must-haves.`;
  }

  let passesText;
  if (passes === 0) passesText = 'No coverage pass was recorded.';
  else if (passes === 1) passesText = '1 coverage pass was run.';
  else passesText = `${passes} coverage passes were run.`;

  return { passes, passesText, gaps, mustGaps, summary };
}

/** The schedule with every question id resolved to its question. */
export function describeSchedule(schedule, questions) {
  const byId = new Map((Array.isArray(questions) ? questions : []).map((question) => [question.id, question]));
  const days = Array.isArray(schedule?.days) ? schedule.days : [];

  return {
    daysAvailable: Number.isInteger(schedule?.days_available) ? schedule.days_available : days.length,
    totalMinutes: days.reduce((sum, day) => sum + (Number.isInteger(day?.minutes) ? day.minutes : 0), 0),
    days: days.map((day) => ({
      day: day.day,
      focus: day.focus ?? '',
      minutes: day.minutes,
      kindLabel: DAY_KIND_LABELS[day.kind] ?? null,
      pinned: day.pinned === true,
      // A reference that does not resolve is kept and flagged rather than dropped. The
      // server validates references, so this should not happen — and if it does, a
      // visible "missing question" is honest where a silently shorter day is not.
      questions: (day.question_ids ?? []).map((id) => ({ id, question: byId.get(id) ?? null })),
    })),
  };
}

/**
 * The state one section renders in.
 *
 * `present` asks whether the section exists in the kit at all. A kit that loaded but is
 * missing a section gets an error in THAT section only — the rest of the kit still
 * renders — which is the difference between per-section states and a global spinner.
 * `busy` is a section-local operation in flight, such as that section regenerating.
 *
 * @param {{ present: boolean, isEmpty?: boolean, busy?: boolean }} input
 */
export function deriveSectionState({ present, isEmpty = false, busy = false }) {
  if (!present) return { status: 'error', error: SECTION_MISSING, isEmpty: false };
  if (busy) return { status: 'loading', error: null, isEmpty: false };
  return { status: 'ready', error: null, isEmpty: Boolean(isEmpty) };
}
