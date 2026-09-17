/**
 * weakSpots.js — how missed points in scored answers are told to the person, where they
 * practise.
 *
 * Decides: which weak requirements have cards that practice will bring forward, which have
 * none, and the sentence a verdict ends with to say so.
 *
 * Does NOT decide: which requirements are weak (the server, from core's `weakSpots`) or the
 * order cards come in (core's `orderCards`, served as the deck). Nothing here sorts.
 *
 * A WEAK SPOT WITH NO CARD IS SAID DIFFERENTLY. Practice cannot resurface a requirement no
 * flashcard covers, and telling someone "it will come up first" would be a promise the
 * deck cannot keep. For those, the words point to adding a card instead.
 */

const coveringCards = (cards, requirementId) =>
  (Array.isArray(cards) ? cards : []).filter((card) => (card?.requirement_ids ?? []).includes(requirementId));

/**
 * The weak requirements this kit still has, each with the cards that cover it.
 *
 * @returns {Array<{ id: string, text: string, cardIds: string[], hasCard: boolean }>}
 */
export function describeWeakSpots(weakRequirementIds, requirements, cards) {
  const byId = new Map((Array.isArray(requirements) ? requirements : []).map((requirement) => [requirement.id, requirement]));
  return (Array.isArray(weakRequirementIds) ? weakRequirementIds : [])
    .filter((id) => byId.has(id))
    .map((id) => {
      const cardIds = coveringCards(cards, id).map((card) => card.id);
      return { id, text: byId.get(id).text, cardIds, hasCard: cardIds.length > 0 };
    });
}

/**
 * What a verdict's missed requirements mean for practice, in words — or null when nothing
 * was missed.
 */
export function practiceNote(missedRequirementIds, cards) {
  const missed = Array.isArray(missedRequirementIds) ? missedRequirementIds : [];
  if (missed.length === 0) return null;

  const withCards = missed.filter((id) => coveringCards(cards, id).length > 0);
  const withoutCards = missed.filter((id) => !withCards.includes(id));
  const list = (ids) => (ids.length <= 1 ? ids.join('') : `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`);

  const sentences = [];
  if (withCards.length > 0) {
    sentences.push(`Flashcards for ${list(withCards)} will come up first the next time you practise.`);
  }
  if (withoutCards.length > 0) {
    sentences.push(
      `No flashcard covers ${list(withoutCards)} yet, so practice cannot bring ${withoutCards.length === 1 ? 'it' : 'them'} back — add one below.`
    );
  }
  return { text: sentences.join(' '), canPractise: withCards.length > 0 };
}
