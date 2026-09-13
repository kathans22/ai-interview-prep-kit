/**
 * weakSpots.js — the requirements a scored answer missed, for the practice screen.
 *
 * Decides: how the requirements the scoring loop found weak are described on screen.
 *
 * Does NOT decide: what the deck order is (the server's `orderCards` decides, fed the
 * same weak ids this module describes — this module's output is a description of that
 * order, not an instruction), or which requirements are weak (the server's practice
 * read carries `weakRequirements`; the ids are not recomputed here, so the banner can
 * never disagree with the deck about what was pulled forward).
 *
 * THE TEXTS COME FROM THE KIT, so a requirement renamed or reworded by a regeneration
 * is described by what the kit says now, while the id stays the key the score was
 * recorded against. Whether a weak spot can be practised comes from the FLASHCARDS —
 * a requirement the kit still names but no card covers needs a card added on the kit
 * page, not another practice session.
 */

/**
 * The weak spots as the practice screen names them: id, the requirement's text as the
 * kit holds it now, and whether any flashcard covers it at all.
 */
export function describeWeakSpots(weakIds, requirements, flashcards) {
  const ids = Array.isArray(weakIds) ? weakIds.filter(Boolean) : [];
  if (ids.length === 0) return [];

  const byId = new Map((Array.isArray(requirements) ? requirements : []).map((item) => [item?.id, item]));
  const covered = new Set(
    (Array.isArray(flashcards) ? flashcards : []).flatMap((card) =>
      Array.isArray(card?.requirement_ids) ? card.requirement_ids : []
    )
  );
  return ids.map((id) => ({
    id,
    text: byId.get(id)?.text ?? id,
    hasCard: covered.has(id),
  }));
}
