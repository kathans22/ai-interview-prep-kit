/**
 * PinToggle.jsx — "keep this when the section is regenerated".
 *
 * Decides: that a pin is a toggle button — `aria-pressed` carries the state — and what
 * its hint says about the item it is on.
 *
 * Does NOT decide: what pinning protects against. `isReplaceable` in core is the one
 * rule; the hint only describes it.
 *
 * THE NAME AND THE VISIBLE WORD NEVER CHANGE. A toggle whose label flips between "Pin"
 * and "Unpin" is announced as two different controls and leaves a screen reader user
 * unsure whether "Unpin, pressed" means it is pinned or not. The word is always "Pin",
 * the pressed state says whether it is on, and the item's "Pinned" badge says it at a
 * glance for everyone.
 *
 * ON EVERY QUESTION AND FLASHCARD, not only generated ones. On a generated item the pin
 * is what stands between it and the next regeneration. An edited or hand-written item is
 * kept anyway, and the hint says exactly that rather than implying the pin does more —
 * but the person can still record that they want it kept.
 */

import { buttonClasses } from '../ui/Button.jsx';

function hintFor(item) {
  if (item?.pinned === true) return 'Pinned: kept when this section is regenerated.';
  if (item?.origin === 'edited' || item?.origin === 'manual') {
    return 'Already kept when this section is regenerated, because you changed or wrote it.';
  }
  return 'Pin to keep this when the section is regenerated.';
}

export default function PinToggle({ item, onToggle }) {
  const pinned = item?.pinned === true;

  return (
    <button
      type="button"
      aria-pressed={pinned}
      aria-label={`Pin, ${item.id}`}
      title={hintFor(item)}
      onClick={() => onToggle(!pinned)}
      className={buttonClasses({
        variant: 'ghost',
        size: 'sm',
        className: 'aria-pressed:bg-amber-100 aria-pressed:text-amber-900',
      })}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M5 1.75h6l-1 4 3 3H3l3-3-1-4zM8 8.75v5.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      Pin
    </button>
  );
}
