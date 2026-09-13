/**
 * summary.js — what a finished practice session covered, and what it did not.
 *
 * Decides: which cards count as covered (their answer was revealed), which were not seen,
 * how the ratings given break down, and which of the kit's requirements the session left
 * untouched — distinguishing a requirement the session skipped from one no flashcard
 * covers at all.
 *
 * Does NOT decide: the order of the next session (the server's) or how the summary looks.
 *
 * "UNTOUCHED" IS ABOUT THIS SESSION, AND SAYS WHY. A requirement is touched when a card
 * that helps with it was seen. An untouched requirement is reported with the reason that
 * matters for what to do next: its cards were not reached (practise longer), or no card
 * covers it at all (practising cannot fix that — add a card on the kit page).
 *
 * EVERYTHING KEEPS THE KIT'S OWN IDs, because the prose asks which requirement IDS remain
 * untouched, and an id is what a person can find again on the kit page.
 */

import { RATINGS, ratingFor } from './ratings.js';
import { ratingOf, seenIds } from './session.js';

/**
 * @param {object} input
 * @param {object} input.session  the finished session (`session.js`)
 * @param {Array<{ id, front, requirement_ids }>} input.cards  the cards the session walked
 * @param {Array<{ id, text }>} input.requirements  the kit's requirements
 */
export function summariseSession({ session, cards, requirements }) {
  const byId = new Map((Array.isArray(cards) ? cards : []).map((card) => [card.id, card]));
  const seen = new Set(seenIds(session));

  const covered = session.order
    .filter((id) => seen.has(id) && byId.has(id))
    .map((id) => {
      const rating = ratingOf(session, id);
      return {
        id,
        front: byId.get(id).front,
        rating: rating ? ratingFor(rating.value)?.label ?? null : null,
        // Only a save that FAILED is reported as not saved. A rating still on its way when
        // the session was finished is not a failure, and calling it one would send the
        // person back to re-rate a card whose rating is about to land.
        saved: !rating ? null : rating.status === 'failed' ? false : rating.status === 'saved' ? true : null,
      };
    });

  const notSeen = session.order.filter((id) => !seen.has(id) && byId.has(id)).map((id) => ({ id, front: byId.get(id).front }));

  const counts = RATINGS.map((rating) => ({
    label: rating.label,
    count: session.order.filter((id) => seen.has(id) && ratingOf(session, id)?.value === rating.value).length,
  }));

  const touchedRequirementIds = new Set(covered.flatMap((card) => byId.get(card.id).requirement_ids ?? []));
  const coveredByAnyCard = new Set([...byId.values()].flatMap((card) => card.requirement_ids ?? []));

  const requirementRows = (Array.isArray(requirements) ? requirements : []).map((requirement) => ({
    id: requirement.id,
    text: requirement.text,
    touched: touchedRequirementIds.has(requirement.id),
    hasCard: coveredByAnyCard.has(requirement.id),
  }));

  return {
    total: session.order.length,
    covered,
    notSeen,
    counts,
    unrated: covered.filter((card) => card.rating === null).length,
    requirements: requirementRows,
    untouchedRequirementIds: requirementRows.filter((row) => !row.touched).map((row) => row.id),
  };
}
