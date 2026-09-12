/**
 * ProgressSteps.jsx — the build, one row per step.
 *
 * Decides: how a step's state is shown.
 *
 * Does NOT decide: the steps, their order, or what their reasons mean — all of that is
 * `steps.js`, so this file contains no vocabulary of its own.
 *
 * STATE IS A WORD, NOT A COLOUR. Every row carries the state in text ("Running",
 * "Skipped", "Failed"). A list that distinguishes them by colour alone is unusable to
 * anyone who cannot separate those hues, and unreadable in a screenshot printed in
 * grey — and this list is the screen where "which part went wrong" has to be obvious.
 * The symbol beside it is `aria-hidden`, because it duplicates the word rather than
 * adding to it.
 *
 * A SKIPPED OR DEGRADED STEP EXPLAINS ITSELF IN PLACE. The reason sits on the row it
 * belongs to, not in a summary elsewhere: "No hiring page found on this site" means
 * something next to "Finding the hiring page" and very little at the bottom of a page.
 *
 * AN ORDERED LIST, because these steps happen in an order and that order is information.
 */

import { STEP_STATES } from './steps.js';

const PRESENTATION = Object.freeze({
  [STEP_STATES.pending]: { word: 'Waiting', symbol: '·', className: 'text-slate-400' },
  [STEP_STATES.running]: { word: 'Running', symbol: '▶', className: 'text-slate-900 font-medium' },
  [STEP_STATES.done]: { word: 'Done', symbol: '✓', className: 'text-green-800' },
  [STEP_STATES.skipped]: { word: 'Skipped', symbol: '–', className: 'text-amber-800' },
  [STEP_STATES.failed]: { word: 'Failed', symbol: '✕', className: 'text-red-800' },
});

export default function ProgressSteps({ steps }) {
  return (
    <ol className="divide-y divide-slate-100">
      {steps.map((step) => {
        const look = PRESENTATION[step.state] ?? PRESENTATION[STEP_STATES.pending];

        return (
          <li key={step.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
            <span aria-hidden="true" className={`w-3 shrink-0 text-center ${look.className}`}>
              {look.symbol}
            </span>

            <span className={step.state === STEP_STATES.pending ? 'text-slate-500' : 'text-slate-900'}>
              {step.label}
            </span>

            <span className={`text-xs uppercase tracking-wide ${look.className}`}>{look.word}</span>

            {/* "Partial" is its own word rather than a third colour of Done: the step
                worked and produced less than it might have, and the note says what. */}
            {step.partial && step.state === STEP_STATES.done ? (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">Partial</span>
            ) : null}

            {step.note ? <span className="basis-full text-sm text-slate-600 ps-6">{step.note}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
