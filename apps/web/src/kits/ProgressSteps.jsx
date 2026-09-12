/**
 * ProgressSteps.jsx — the build, one row per step, announced as it moves.
 *
 * Decides: how a step's state is shown, and how it is spoken.
 *
 * Does NOT decide: the steps, their order, or what their reasons mean — all of that is
 * `steps.js`, so this file contains no vocabulary of its own.
 *
 * STATE IS A WORD, NOT A COLOUR. Every row carries the state in text ("Running",
 * "Skipped", "Failed"). A list that distinguishes them by colour alone is unusable to
 * anyone who cannot separate those hues, and unreadable in a screenshot printed in
 * grey — and this list is the screen where "which part went wrong" has to be obvious.
 *
 * A SKIPPED OR DEGRADED STEP EXPLAINS ITSELF IN PLACE. The reason sits on the row it
 * belongs to, not in a summary elsewhere: "No hiring page found on this site" means
 * something next to "Finding the hiring page" and very little at the bottom of a page.
 *
 * THE LIST IS A POLITE LIVE REGION, AND EACH ROW IS ONE SENTENCE. A build takes minutes;
 * a list that only animates leaves a screen reader user with no idea whether anything is
 * happening. `aria-live="polite"` announces changes without interrupting, which is right
 * for progress — `assertive` would talk over whatever the user is doing, several times a
 * minute, for a build that is going fine.
 *
 * The rows are structured for that region rather than around it. A live region announces
 * the nodes that changed, so the visible parts — symbol, label, state word, note — are
 * marked `aria-hidden` and each row carries one visually-hidden sentence instead.
 * Without that, flipping a row from waiting to running changes only the word "Running",
 * and the announcement is the single word "running" with nothing saying which step it
 * belongs to. With it, the announcement is "Crawling the company site: running."
 *
 * ONE LIVE REGION ON THIS SCREEN, NOT TWO. The summary line above the list says the same
 * thing more briefly, and making it live as well would announce every change twice.
 *
 * `aria-busy` marks the list while the build is still going, so a reader can tell "no
 * announcements yet" from "finished".
 */

import { STEP_STATES, announce } from './steps.js';

const PRESENTATION = Object.freeze({
  [STEP_STATES.pending]: { word: 'Waiting', symbol: '·', className: 'text-slate-400' },
  [STEP_STATES.running]: { word: 'Running', symbol: '▶', className: 'text-slate-900 font-medium' },
  [STEP_STATES.done]: { word: 'Done', symbol: '✓', className: 'text-green-800' },
  [STEP_STATES.skipped]: { word: 'Skipped', symbol: '–', className: 'text-amber-800' },
  [STEP_STATES.failed]: { word: 'Failed', symbol: '✕', className: 'text-red-800' },
});

export default function ProgressSteps({ steps, busy = false }) {
  return (
    <ol
      aria-live="polite"
      aria-busy={busy ? 'true' : undefined}
      className="divide-y divide-slate-100"
    >
      {steps.map((step) => {
        const look = PRESENTATION[step.state] ?? PRESENTATION[STEP_STATES.pending];

        return (
          <li key={step.id} className="py-2">
            {/* Spoken form: one sentence, so a change is announced whole. */}
            <span className="sr-only">{announce(step)}</span>

            {/* Seen form: hidden from assistive technology, because the sentence above
                already says all of it and saying it twice in two shapes is worse than
                saying it once. */}
            <span aria-hidden="true" className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className={`w-3 shrink-0 text-center ${look.className}`}>{look.symbol}</span>

              <span className={step.state === STEP_STATES.pending ? 'text-slate-500' : 'text-slate-900'}>
                {step.label}
              </span>

              <span className={`text-xs uppercase tracking-wide ${look.className}`}>{look.word}</span>

              {/* "Partial" is its own word rather than a third colour of Done: the step
                  worked and produced less than it might have, and the note says what. */}
              {step.partial && step.state === STEP_STATES.done ? (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">Partial</span>
              ) : null}

              {step.note ? <span className="basis-full ps-6 text-sm text-slate-600">{step.note}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
