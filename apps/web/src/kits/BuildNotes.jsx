/**
 * BuildNotes.jsx — what the build gave up, in the kit's own words.
 *
 * Decides: how the kit's degradation record is shown — its run notes, any requirements
 * dropped for lack of evidence, and whether the posting was too thin to work from.
 *
 * Does NOT decide: what went wrong. The orchestrator records all three as extra fields on
 * the kit (`run_notes`, `dropped_requirements`, `thin_jd`), which the contract permits,
 * precisely so a reader holding only the kit can see what was skipped and why.
 *
 * THIS IS CF-041. Those fields existed from Stage 7 and nothing rendered them, so the
 * honest record of a degraded build lived only in JSON. A dropped requirement matters
 * most of the three: it is something the posting may genuinely ask for that the kit has
 * no questions about, because the model's quoted evidence could not be found in the
 * posting — and a candidate should know to check it themselves.
 */

import { humaniseCode } from './steps.js';

/**
 * Drop reasons in words. Only the codes seen in the pipeline are mapped — the default the
 * assembler writes, and the one for a requirement quoted with no evidence at all.
 * Anything else is humanised rather than printed as a code.
 */
const DROP_REASONS = Object.freeze({
  EVIDENCE_UNSUPPORTED: 'The line it was quoted from could not be found in the posting.',
  EVIDENCE_MISSING: 'No line from the posting was quoted to support it.',
});

export default function BuildNotes({ kit }) {
  const notes = Array.isArray(kit?.run_notes) ? kit.run_notes.filter(Boolean) : [];
  const dropped = Array.isArray(kit?.dropped_requirements) ? kit.dropped_requirements : [];
  const thin = kit?.thin_jd === true;

  if (notes.length === 0 && dropped.length === 0 && !thin) {
    return <p className="text-sm text-slate-600">The build recorded nothing it had to give up.</p>;
  }

  return (
    <div className="space-y-4">
      {thin ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          The posting was short, so there was little to extract requirements from. Treat this kit as a starting point.
        </p>
      ) : null}

      {dropped.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Requirements left out ({dropped.length})
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            These may still matter for the role — they were dropped because the evidence for them did not hold up, not
            because they are unimportant.
          </p>
          <ul className="mt-2 space-y-2">
            {dropped.map((drop, index) => (
              // Dropped requirements carry no id: they were removed before ids were final.
              // eslint-disable-next-line react/no-array-index-key
              <li key={index} className="break-words border-s-2 border-amber-300 ps-3 text-sm">
                <p className="text-slate-900">{drop.text || 'An unnamed requirement'}</p>
                <p className="text-xs text-slate-600">{DROP_REASONS[drop.reason] ?? humaniseCode(drop.reason)}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {notes.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Notes from the build</h3>
          <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-slate-700">
            {notes.map((note, index) => (
              // Notes are plain strings in the order the build wrote them.
              // eslint-disable-next-line react/no-array-index-key
              <li key={index} className="break-words">
                {note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
