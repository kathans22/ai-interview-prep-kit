/**
 * provenance.js — where each piece of a kit came from, and whether it may be replaced.
 *
 * Decides: the provenance vocabulary — `origin`, `pinned`, `updatedAt` — and the single
 * rule that reads them: may a regeneration overwrite this item?
 *
 * Does NOT decide: how a merge is performed (merge.js), or how provenance is stored
 * (the Mongoose model). It defines the meaning; others apply it.
 *
 * THIS LIVES IN CORE, NOT IN THE MODEL, BECAUSE THE RULE IS NOT A STORAGE CONCERN.
 * "Does a regeneration replace this?" is the question the whole edit/regenerate feature
 * turns on, and it has exactly one correct answer that both the merge function and the
 * HTTP layer must agree on. Put it in the schema and the merge function would have to
 * re-derive it; re-derived rules drift.
 *
 * THE THREE ORIGINS, AND WHY EDITED AND MANUAL ARE DISTINCT:
 *   generated  the model wrote it and nobody has touched it. Replaceable.
 *   edited     the model wrote it and a person changed it. NEVER replaced — the edit is
 *              the most valuable content in the kit, because it is the only part a human
 *              spent attention on.
 *   manual     a person wrote it from nothing. Never replaced, and distinguished from
 *              `edited` because the two are different provenance claims: one says "the
 *              model's work, corrected", the other "not the model's work at all". A
 *              reviewer asking "how much of this did the AI write?" needs them separate,
 *              and collapsing them would make that question unanswerable.
 *
 * PINNED IS ORTHOGONAL. A user can pin a generated item they like without editing it, and
 * pinning survives regeneration exactly as an edit does. Two independent reasons to
 * protect an item, not one flag doing double duty: "I wrote this" and "keep this".
 *
 * Pure: no I/O, no mutation of its inputs.
 */

/** Where an item came from. */
export const ORIGINS = Object.freeze({
  GENERATED: 'generated',
  EDITED: 'edited',
  MANUAL: 'manual',
});

export const ORIGIN_VALUES = Object.freeze(Object.values(ORIGINS));

/** The provenance fields every question, flashcard, brief field and schedule day carries. */
export const PROVENANCE_KEYS = Object.freeze(['origin', 'pinned', 'updatedAt']);

/**
 * Stamp provenance onto an item, without disturbing provenance it already has.
 *
 * @param {object} item
 * @param {object} [options]
 * @param {string} [options.origin] defaults to `generated`
 * @param {boolean} [options.pinned]
 * @param {string} [options.updatedAt] ISO timestamp; defaults to now
 * @returns {object} a new object — the input is never mutated
 */
export function withProvenance(item, { origin, pinned, updatedAt } = {}) {
  const source = item && typeof item === 'object' ? item : {};

  return {
    ...source,
    origin: normaliseOrigin(origin ?? source.origin ?? ORIGINS.GENERATED),
    pinned: typeof pinned === 'boolean' ? pinned : source.pinned === true,
    updatedAt: updatedAt ?? source.updatedAt ?? new Date().toISOString(),
  };
}

/** Stamp a whole array, preserving each item's existing provenance. */
export function withProvenanceAll(items, options = {}) {
  return (Array.isArray(items) ? items : []).map((item) => withProvenance(item, options));
}

/** An unknown origin is treated as generated — the replaceable, least-destructive reading. */
export function normaliseOrigin(origin) {
  const value = String(origin ?? '').trim().toLowerCase();
  return ORIGIN_VALUES.includes(value) ? value : ORIGINS.GENERATED;
}

/**
 * THE RULE. May a regeneration replace this item?
 *
 * Only when a person has neither written it nor asked to keep it. Everything else
 * survives. This is the one function that answers the question, so a change of policy is
 * a change in one place.
 *
 * An item with no provenance at all is treated as generated and therefore replaceable:
 * it predates provenance, which means no human has claimed it.
 *
 * @param {object} item
 * @returns {boolean}
 */
export function isReplaceable(item) {
  if (!item || typeof item !== 'object') return true;
  if (item.pinned === true) return false;
  return normaliseOrigin(item.origin) === ORIGINS.GENERATED;
}

/** The inverse, named for readability at call sites that protect rather than replace. */
export function isProtected(item) {
  return !isReplaceable(item);
}

/**
 * Mark an item as edited by a person.
 *
 * `origin` becomes `edited` only if it was `generated`: a `manual` item that someone
 * edits again is still `manual`, because the claim "a person wrote this from nothing"
 * does not stop being true when they revise it.
 */
export function markEdited(item, { updatedAt } = {}) {
  const current = normaliseOrigin(item?.origin);
  return {
    ...item,
    origin: current === ORIGINS.MANUAL ? ORIGINS.MANUAL : ORIGINS.EDITED,
    pinned: item?.pinned === true,
    updatedAt: updatedAt ?? new Date().toISOString(),
  };
}

/** Mark an item as hand-written. */
export function markManual(item, { updatedAt } = {}) {
  return { ...item, origin: ORIGINS.MANUAL, pinned: item?.pinned === true, updatedAt: updatedAt ?? new Date().toISOString() };
}

/** Pin or unpin, touching nothing else. */
export function setPinned(item, pinned, { updatedAt } = {}) {
  return { ...item, pinned: pinned === true, updatedAt: updatedAt ?? new Date().toISOString() };
}

/**
 * The brief's fields are strings by contract, so their provenance lives beside them.
 *
 * `company_brief.summary` must stay a string — `validateKit` requires it — so it cannot
 * carry `origin` on itself the way a question object can. A parallel `provenance` map
 * keeps the contract intact while still recording who wrote each field, which is what
 * makes "regenerate the brief but keep my edited summary" expressible.
 */
export const BRIEF_FIELDS = Object.freeze(['summary', 'what_they_do']);

/** Provenance for the brief's string fields, defaulting to generated. */
export function briefProvenance(existing = {}, options = {}) {
  const map = {};
  for (const field of BRIEF_FIELDS) {
    map[field] = withProvenance(existing?.[field] ?? {}, options);
  }
  return map;
}

/**
 * Stamp a freshly built kit so every item has provenance from the start.
 *
 * Doing this at assembly rather than on first edit means there is never a kit whose
 * items have no `origin` — so `isReplaceable` never has to guess, and a merge arriving at
 * an unstamped item cannot mistake a person's work for the model's.
 *
 * @param {object} kit mutated in place, because it was just built here and is not shared
 * @param {{ updatedAt?: string }} [options]
 * @returns {object} the same kit
 */
export function stampKit(kit, { updatedAt } = {}) {
  if (!kit || typeof kit !== 'object') return kit;
  const stampOptions = { origin: ORIGINS.GENERATED, pinned: false, updatedAt };

  kit.questions = withProvenanceAll(kit.questions, stampOptions);
  kit.flashcards = withProvenanceAll(kit.flashcards, stampOptions);

  if (kit.schedule && Array.isArray(kit.schedule.days)) {
    kit.schedule.days = withProvenanceAll(kit.schedule.days, stampOptions);
  }

  if (kit.company_brief && typeof kit.company_brief === 'object') {
    kit.company_brief.provenance = briefProvenance(kit.company_brief.provenance, stampOptions);
  }

  return kit;
}

/**
 * Count provenance across a kit, so "how much of this did the model write?" has an
 * answer a reviewer can read off rather than estimate.
 *
 * @param {object} kit
 */
export function provenanceSummary(kit) {
  const tally = { generated: 0, edited: 0, manual: 0, pinned: 0, total: 0 };

  const count = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      tally.total += 1;
      tally[normaliseOrigin(item?.origin)] += 1;
      if (item?.pinned === true) tally.pinned += 1;
    }
  };

  count(kit?.questions);
  count(kit?.flashcards);
  count(kit?.schedule?.days);

  return tally;
}
