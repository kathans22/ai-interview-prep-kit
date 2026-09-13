/**
 * ProvenanceBadges.jsx — "Edited", "Added by you", "Pinned".
 *
 * Decides: how provenance looks, identically, on every kind of item.
 *
 * Does NOT decide: which badges an item has. That is `provenanceBadges` in `kitView.js`,
 * so a question, a flashcard and a brief field can never disagree about what "edited"
 * means on screen.
 *
 * These badges matter more than decoration: they mark exactly the items a regeneration
 * will leave alone. A person deciding whether to press "regenerate" needs to see, at a
 * glance, which of their changes are protected.
 */

import { provenanceBadges } from '../kitView.js';

const TONES = Object.freeze({
  edited: 'bg-sky-100 text-sky-900',
  manual: 'bg-violet-100 text-violet-900',
  pinned: 'bg-amber-100 text-amber-900',
});

export default function ProvenanceBadges({ item }) {
  const badges = provenanceBadges(item);
  if (badges.length === 0) return null;

  return (
    <span className="inline-flex flex-wrap gap-1">
      {badges.map((badge) => (
        <span key={badge.key} className={`rounded px-1.5 py-0.5 text-xs font-medium ${TONES[badge.key]}`}>
          {badge.text}
        </span>
      ))}
    </span>
  );
}
