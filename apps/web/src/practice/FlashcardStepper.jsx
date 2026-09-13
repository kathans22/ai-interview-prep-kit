/**
 * FlashcardStepper.jsx — one flashcard at a time, answer hidden until asked for.
 *
 * Decides: how a single card is laid out, that its answer is not on the page — not merely
 * invisible — until revealed, and where focus goes when it is.
 *
 * Does NOT decide: the order of the cards (the caller passes them in the order to walk),
 * or what moving and revealing do (`session.js`).
 *
 * THE ANSWER IS ABSENT, NOT HIDDEN. A `hidden` attribute or a collapsed disclosure still
 * puts the answer in the document, where a screen reader reading the card reads it out —
 * before the person has tried to recall it. It is rendered only once revealed.
 *
 * FOCUS MOVES TO THE ANSWER WHEN IT APPEARS. The reveal button goes away as the answer
 * arrives; leaving focus there would drop it to the page body, and a screen reader user
 * would not hear the answer they asked for.
 *
 * MOVING KEEPS FOCUS ON THE CONTROL, and the new position is announced. Pressing Next
 * twelve times should not mean finding Next twelve times. Previous and Next are
 * `aria-disabled` at the ends rather than `disabled`, which would throw focus away at
 * exactly the card where the person stops.
 */

import { useEffect, useRef, useState } from 'react';

import { buttonClasses } from '../ui/Button.jsx';
import { indexRequirements } from '../kits/kitView.js';
import { createSession, currentCardId, describePosition, isFirst, isLast, next, previous, reveal } from './session.js';

export default function FlashcardStepper({ cards, requirements }) {
  const [session, setSession] = useState(() => createSession(cards.map((card) => card.id)));
  const answerRef = useRef(null);
  const byRequirement = indexRequirements(requirements);

  const card = cards.find((entry) => entry.id === currentCardId(session)) ?? null;
  const position = describePosition(session);

  useEffect(() => {
    if (session.revealed) answerRef.current?.focus();
  }, [session.revealed]);

  if (!card) return null;

  const helpsWith = (card.requirement_ids ?? []).map((id) => byRequirement.get(id)?.text ?? id);
  const control = (label, blocked, onPress, variant = 'secondary') => (
    <button
      type="button"
      aria-disabled={blocked || undefined}
      onClick={() => {
        if (!blocked) onPress();
      }}
      className={buttonClasses({ variant, className: blocked ? 'cursor-not-allowed opacity-50' : '' })}
    >
      {label}
    </button>
  );

  return (
    <article aria-labelledby="practice-card-position" className="rounded-lg border border-slate-200 bg-white">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <h2 id="practice-card-position" className="text-sm font-semibold text-slate-900">
          {position}
        </h2>
        <span className="font-mono text-xs text-slate-500">{card.id}</span>
      </header>

      <div className="px-4 py-5">
        <p className="whitespace-pre-line break-words text-lg font-medium text-slate-900">{card.front}</p>
        {helpsWith.length > 0 ? (
          <p className="mt-2 break-words text-xs text-slate-500">Helps with: {helpsWith.join(' · ')}</p>
        ) : null}

        <div className="mt-5">
          {session.revealed ? (
            <div
              ref={answerRef}
              tabIndex={-1}
              data-practice-answer=""
              aria-label="Answer"
              className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3"
            >
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Answer</p>
              <p className="mt-1 whitespace-pre-line break-words text-slate-800">{card.back}</p>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setSession(reveal)}
              className={buttonClasses({ className: 'w-full sm:w-auto' })}
            >
              Show the answer
            </button>
          )}
        </div>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-3">
        {control('Previous', isFirst(session), () => setSession(previous))}
        {control('Next', isLast(session), () => setSession(next))}
      </footer>

      {/* Where the session is, for anyone who cannot see the heading change. */}
      <p role="status" className="sr-only">
        {position}
      </p>
    </article>
  );
}
