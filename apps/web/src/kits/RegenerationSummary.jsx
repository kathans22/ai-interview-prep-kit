/**
 * RegenerationSummary.jsx — what the last regeneration of a section did, and the way back.
 *
 * Decides: that the summary sits in the section it describes, in words, beside the items
 * it highlights, until it is dismissed or undone; and that Undo sits in it only while the
 * regeneration can still be undone.
 *
 * Does NOT decide: the words (`summariseRegeneration`), which items are highlighted, or
 * whether an undo needs confirming first — the builder asks when it would discard later
 * work.
 *
 * NOT A LIVE REGION ITSELF. Content inserted together with a new live region is often not
 * announced at all; the builder keeps one region mounted for the whole page and speaks
 * the same sentence there.
 */

import { buttonClasses } from '../ui/Button.jsx';
import { describeTarget } from './regeneration.js';

export default function RegenerationSummary({ result, onDismiss, onUndo = null, className = '' }) {
  if (!result) return null;
  const { title, undo } = describeTarget(result.target);

  return (
    <div className={`rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-950 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 break-words" data-regeneration-summary={result.target.section}>
          <span className="font-medium">Regenerated.</span> {result.text}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {onUndo ? (
            <button
              type="button"
              onClick={onUndo}
              aria-label={undo}
              className={buttonClasses({ variant: 'secondary', size: 'sm' })}
            >
              Undo
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            aria-label={`Dismiss the summary for ${title}`}
            className={buttonClasses({ variant: 'ghost', size: 'sm' })}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
