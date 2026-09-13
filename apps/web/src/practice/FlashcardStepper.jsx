/**
 * FlashcardStepper.jsx — one flashcard at a time, answer hidden until asked for, then rated.
 *
 * Decides: how a single card is laid out, that its answer is not on the page — not merely
 * invisible — until revealed, that confidence can only be given once the answer has been
 * seen, and where focus goes at each step.
 *
 * Does NOT decide: the order of the cards (the caller passes them in the order to walk),
 * what moving, revealing and rating do (`session.js`), or how a rating reaches the server
 * (`onRate`, which the page wires to the practice hook and which reports its own failure).
 *
 * THE ANSWER IS ABSENT, NOT HIDDEN. A `hidden` attribute or a collapsed disclosure still
 * puts the answer in the document, where a screen reader reading the card reads it out —
 * before the person has tried to recall it. It is rendered only once revealed.
 *
 * RATING COMES AFTER THE ANSWER, NEVER BEFORE. "How well did you know it?" can only be
 * answered honestly by someone who has compared their recall with the answer, so the
 * four choices appear with the answer and not before it.
 *
 * FOCUS FOLLOWS THE WORK. It moves onto the answer when it appears (the reveal button
 * goes away, and leaving focus there would drop it to the page body), and after a rating
 * onto the next card's "Show the answer" — the next thing to do. Previous and Next keep
 * focus and are `aria-disabled` at the ends rather than `disabled`, which would throw
 * focus away at exactly the card where the person stops.
 *
 * A RATING NEVER WAITS FOR THE NETWORK, AND NEVER FAILS QUIETLY. It is drawn and the
 * session moves on at once; the card then says whether it was saved, and a failed one says
 * so on the card as well as in the page's toast, and can simply be chosen again.
 *
 * KEYBOARD FIRST. Space reveals, 1–4 rate, the arrows move — each doing exactly what its
 * button does, through the same functions, so a key press and a click can never disagree.
 * What each key must NOT do is `shortcuts.js`. The shortcuts are listed on screen, not
 * left to be discovered, and each control carries `aria-keyshortcuts` so assistive
 * technology can announce them too.
 */

import { useEffect, useRef, useState } from 'react';

import { buttonClasses } from '../ui/Button.jsx';
import { indexRequirements } from '../kits/kitView.js';
import { RATINGS, ratingFor } from './ratings.js';
import { SHORTCUTS, shortcutFor } from './shortcuts.js';
import {
  createSession,
  currentCardId,
  describePosition,
  isFirst,
  isLast,
  next,
  previous,
  rateAndAdvance,
  ratingOf,
  reveal,
  settleRating,
} from './session.js';

function describeSessionRating(rating) {
  if (!rating) return null;
  const label = ratingFor(rating.value)?.label ?? String(rating.value);
  if (rating.status === 'saving') return `Saving "${label}"…`;
  if (rating.status === 'failed') return `"${label}" was not saved. Choose again to retry.`;
  return `Saved as "${label}".`;
}

function describePast(past) {
  if (!past) return null;
  const label = ratingFor(past.latest)?.label ?? String(past.latest);
  return `Last practised: ${label} · ${past.attempts} ${past.attempts === 1 ? 'time' : 'times'}`;
}

export default function FlashcardStepper({ cards, requirements, history, onRate, onFinish, autoFocus = false }) {
  const [session, setSession] = useState(() => createSession(cards.map((card) => card.id)));
  const answerRef = useRef(null);
  const revealRef = useRef(null);
  const focusRevealNext = useRef(false);
  const byRequirement = indexRequirements(requirements);

  const cardId = currentCardId(session);
  const card = cards.find((entry) => entry.id === cardId) ?? null;
  const position = describePosition(session);
  const sessionRating = card ? ratingOf(session, card.id) : null;
  const past = card ? history?.get(card.id) ?? null : null;

  useEffect(() => {
    if (session.revealed) answerRef.current?.focus();
  }, [session.revealed]);

  // A session started from the summary: the summary and its button have gone, so focus
  // goes to the first thing to do in the new session.
  useEffect(() => {
    if (autoFocus) revealRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After a rating moves the session on, the next thing to do is reveal the next card.
  useEffect(() => {
    if (!focusRevealNext.current || session.revealed) return;
    focusRevealNext.current = false;
    revealRef.current?.focus();
  }, [session.index, session.revealed]);

  // One listener for the life of the stepper, reading the latest session and handlers
  // through a ref — re-binding on every render would briefly drop key presses.
  const keyboard = useRef(null);
  keyboard.current = {
    revealed: session.revealed,
    reveal: () => setSession(reveal),
    previous: () => setSession(previous),
    next: () => setSession(next),
    rate: (value) => handleRate(value),
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      const actions = keyboard.current;
      const action = shortcutFor(event, { revealed: actions.revealed });
      if (!action) return;
      // Only a key this screen acts on is claimed; Space would otherwise scroll the page.
      event.preventDefault();
      if (action.type === 'rate') actions.rate(action.value);
      else actions[action.type]();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!card) return null;

  async function handleRate(value) {
    const ratedId = currentCardId(session);
    focusRevealNext.current = !isLast(session);
    setSession((current) => rateAndAdvance(current, value));
    try {
      await onRate(ratedId, value);
      setSession((current) => settleRating(current, ratedId, value, 'saved'));
    } catch {
      // Not swallowed: `onRate` has already told the person, and the card now says the
      // rating was not saved and invites choosing again.
      setSession((current) => settleRating(current, ratedId, value, 'failed'));
    }
  }

  const helpsWith = (card.requirement_ids ?? []).map((id) => byRequirement.get(id)?.text ?? id);
  const control = (label, blocked, onPress, keys) => (
    <button
      type="button"
      aria-keyshortcuts={keys}
      aria-disabled={blocked || undefined}
      onClick={() => {
        if (!blocked) onPress();
      }}
      className={buttonClasses({ variant: 'secondary', className: blocked ? 'cursor-not-allowed opacity-50' : '' })}
    >
      {label}
    </button>
  );

  return (
    <>
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
        {past ? (
          <p className="mt-1 text-xs text-slate-500" data-practice-past="">
            {describePast(past)}
          </p>
        ) : null}

        <div className="mt-5">
          {session.revealed ? (
            <>
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

              <div role="group" aria-labelledby="practice-rate-label" className="mt-4">
                <p id="practice-rate-label" className="text-sm font-medium text-slate-900">
                  How well did you know it?
                </p>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {RATINGS.map((rating) => (
                    <button
                      key={rating.key}
                      type="button"
                      aria-keyshortcuts={String(rating.value)}
                      aria-pressed={sessionRating?.value === rating.value}
                      onClick={() => handleRate(rating.value)}
                      className={buttonClasses({
                        variant: 'secondary',
                        className: 'aria-pressed:border-slate-900 aria-pressed:bg-slate-100',
                      })}
                    >
                      {rating.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <button
              ref={revealRef}
              type="button"
              aria-keyshortcuts="Space"
              onClick={() => setSession(reveal)}
              className={buttonClasses({ className: 'w-full sm:w-auto' })}
            >
              Show the answer
            </button>
          )}

          {sessionRating ? (
            <p
              data-practice-rating-status={sessionRating.status}
              className={`mt-3 text-sm ${sessionRating.status === 'failed' ? 'text-red-800' : 'text-slate-600'}`}
            >
              {describeSessionRating(sessionRating)}
            </p>
          ) : null}
        </div>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-3">
        {control('Previous', isFirst(session), () => setSession(previous), 'ArrowLeft')}
        {/* Finishing is always available: a session is as long as the person has time
            for, and the summary is where the untouched requirements are named. */}
        <button type="button" onClick={() => onFinish?.(session)} className={buttonClasses({ variant: 'ghost' })}>
          Finish session
        </button>
        {control('Next', isLast(session), () => setSession(next), 'ArrowRight')}
      </footer>

      {/* Where the session is, for anyone who cannot see the heading change. */}
      <p role="status" className="sr-only">
        {position}
      </p>
    </article>

    {/* Shown, not hidden behind a "?" — a shortcut nobody knows about is not keyboard-first. */}
    <section
      aria-labelledby="practice-shortcuts-heading"
      data-practice-shortcuts=""
      className="mt-3 rounded-md border border-slate-200 bg-white px-4 py-3"
    >
      <h2 id="practice-shortcuts-heading" className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Keyboard shortcuts
      </h2>
      <dl className="mt-2 space-y-1.5 text-sm text-slate-700">
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.action} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <dt className="flex flex-wrap gap-1">
              {shortcut.keys.map((key) => (
                <kbd
                  key={key}
                  className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 font-mono text-xs text-slate-800"
                >
                  {key}
                </kbd>
              ))}
            </dt>
            <dd className="min-w-0">{shortcut.action}</dd>
          </div>
        ))}
      </dl>
    </section>
    </>
  );
}
