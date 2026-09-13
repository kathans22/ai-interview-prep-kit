/**
 * RegenerateButton.jsx — the control that asks to regenerate one section.
 *
 * Decides: the control's name — which says exactly what it regenerates, because several
 * sit on one page — and that it is unavailable while any regeneration runs.
 *
 * Does NOT decide: what happens next. It asks; the builder shows what will be replaced
 * and kept before anything runs.
 *
 * ITS WORD NEVER CHANGES WHILE IT RUNS. The section itself shows the progress. A button
 * whose text became "Regenerating…" would no longer match its accessible name, and a
 * voice-control user saying "click Regenerate" would find nothing.
 *
 * `aria-disabled`, NOT `disabled`, while another regeneration runs, so focus stays on it
 * when the dialog closes and the reason is still discoverable.
 */

import { buttonClasses } from '../ui/Button.jsx';
import { describeTarget } from './regeneration.js';

export default function RegenerateButton({ target, regeneration, onRegenerate, className = '' }) {
  const { action } = describeTarget(target);
  const blocked = Boolean(regeneration?.running);

  return (
    <button
      type="button"
      aria-label={action}
      aria-disabled={blocked || undefined}
      title={blocked ? 'A regeneration is already running.' : undefined}
      onClick={() => {
        if (!blocked) onRegenerate?.(target);
      }}
      className={buttonClasses({
        variant: 'secondary',
        size: 'sm',
        className: `${blocked ? 'cursor-not-allowed opacity-60' : ''} ${className}`,
      })}
    >
      {target.section === 'schedule' ? 'Rebuild' : 'Regenerate'}
    </button>
  );
}
