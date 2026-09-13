/**
 * RegenerationSummary.jsx — what the last regeneration of a section did.
 *
 * Decides: that the summary sits in the section it describes, in words, until it is
 * dismissed — beside the highlighted items it refers to.
 *
 * Does NOT decide: the words (`summariseRegeneration`) or which items are highlighted.
 *
 * NOT A LIVE REGION ITSELF. Content inserted together with a new live region is often not
 * announced at all; the builder keeps one region mounted for the whole page and speaks
 * the same sentence there.
 */

import { buttonClasses } from '../ui/Button.jsx';
import { describeTarget } from './regeneration.js';

export default function RegenerationSummary({ result, onDismiss, children, className = '' }) {
  if (!result) return null;
  const { title } = describeTarget(result.target);

  return (
    <div className={`rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-950 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 break-words" data-regeneration-summary={result.target.section}>
          <span className="font-medium">Regenerated.</span> {result.text}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {children}
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
