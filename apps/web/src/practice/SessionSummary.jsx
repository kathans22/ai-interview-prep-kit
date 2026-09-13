/**
 * SessionSummary.jsx — the end of a practice session: what was covered, what was not,
 * and which requirements are still untouched.
 *
 * Decides: the layout of a summary and the two ways out of it — another session, or back
 * to the kit.
 *
 * Does NOT decide: what counts as covered or untouched (`summary.js`), or the order of the
 * next session (the server's, read again when it starts).
 *
 * FOCUS MOVES TO THE SUMMARY'S HEADING when it appears. The card and its controls have
 * just gone; without this, focus drops to the page body and a screen reader user is not
 * told the session ended.
 *
 * THE NEXT SESSION IS THE PRIMARY ACTION, because practising again is what the summary is
 * for — and because the new session is where the weakest cards come back first.
 */

import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';

import { buttonClasses } from '../ui/Button.jsx';

const list = 'mt-2 space-y-1 text-sm text-slate-700';

export default function SessionSummary({ summary, kitHref, onStartNew, starting = false }) {
  const headingRef = useRef(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const coveredCount = summary.covered.length;

  return (
    <article aria-labelledby="practice-summary-heading" className="rounded-lg border border-slate-200 bg-white" data-practice-summary="">
      <header className="border-b border-slate-200 px-4 py-3">
        <h2 ref={headingRef} id="practice-summary-heading" tabIndex={-1} className="text-base font-semibold text-slate-900">
          Session summary
        </h2>
        <p className="mt-1 text-sm text-slate-600" data-summary-headline="">
          Covered {coveredCount} of {summary.total} {summary.total === 1 ? 'card' : 'cards'}
          {coveredCount > 0 ? ` — ${summary.counts.map((entry) => `${entry.label} ${entry.count}`).join(', ')}` : ''}
          {summary.unrated > 0 ? `, ${summary.unrated} seen without a rating` : ''}.
        </p>
      </header>

      <div className="space-y-5 px-4 py-4">
        <section aria-labelledby="summary-covered">
          <h3 id="summary-covered" className="text-sm font-semibold text-slate-900">
            Covered ({coveredCount})
          </h3>
          {coveredCount === 0 ? (
            <p className="mt-1 text-sm text-slate-500">No answers were revealed in this session.</p>
          ) : (
            <ul className={list} data-summary-covered="">
              {summary.covered.map((card) => (
                <li key={card.id} className="break-words">
                  <span className="font-mono text-xs text-slate-500">{card.id}</span> {card.front}
                  <span className="text-slate-500">
                    {' — '}
                    {card.rating ?? 'seen, not rated'}
                    {card.rating && card.saved === false ? ' (not saved)' : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="summary-not-seen">
          <h3 id="summary-not-seen" className="text-sm font-semibold text-slate-900">
            Not seen ({summary.notSeen.length})
          </h3>
          {summary.notSeen.length === 0 ? (
            <p className="mt-1 text-sm text-slate-500">Every card's answer was seen.</p>
          ) : (
            <ul className={list} data-summary-not-seen="">
              {summary.notSeen.map((card) => (
                <li key={card.id} className="break-words">
                  <span className="font-mono text-xs text-slate-500">{card.id}</span> {card.front}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="summary-requirements">
          <h3 id="summary-requirements" className="text-sm font-semibold text-slate-900">
            Requirements still untouched ({summary.untouchedRequirementIds.length} of {summary.requirements.length})
          </h3>
          {summary.untouchedRequirementIds.length === 0 ? (
            <p className="mt-1 text-sm text-slate-500">Every requirement had at least one card seen.</p>
          ) : (
            <ul className={list} data-summary-untouched="">
              {summary.requirements
                .filter((row) => !row.touched)
                .map((row) => (
                  <li key={row.id} className="break-words" data-requirement-id={row.id}>
                    <span className="font-mono text-xs text-slate-500">{row.id}</span> {row.text}
                    <span className="text-slate-500">
                      {' — '}
                      {row.hasCard ? 'its cards were not reached' : 'no flashcard covers this; add one on the kit page'}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </section>
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-3">
        <button
          type="button"
          onClick={onStartNew}
          disabled={starting}
          className={buttonClasses()}
        >
          {starting ? 'Ordering your cards…' : 'Start a new session'}
        </button>
        <Link to={kitHref} className={buttonClasses({ variant: 'ghost' })}>
          Back to the kit
        </Link>
      </footer>
    </article>
  );
}
