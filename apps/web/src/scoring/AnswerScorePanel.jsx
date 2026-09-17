/**
 * AnswerScorePanel.jsx — type an answer to one question, and read how it scored.
 *
 * Decides: the form, when it may send, what the person sees while it scores, and how the
 * verdict is laid out — hit, missed, not judged, and one improvement.
 *
 * Does NOT decide: the verdict, or what it is judged against (core's `scoreAnswer`, through
 * the server), nor how a length reason is worded (`feedback.js`).
 *
 * PENDING EDITS ARE SAVED FIRST. The server scores against the saved question; an outline
 * edited a moment ago and still waiting to be sent would otherwise be scored against its old
 * wording while the new one is on screen. `onBeforeScore` is the editor's settle.
 *
 * THE ANSWER IS KEPT. After a verdict or a failure, the text stays in the box, so improving
 * it and trying again is one edit rather than retyping.
 *
 * THE BUTTON SAYS WHY IT WILL NOT SEND, and is `aria-disabled` rather than `disabled`, so it
 * keeps focus and the reason stays reachable.
 *
 * FOCUS MOVES TO THE VERDICT when it arrives: it replaces nothing on screen, so without that a
 * screen reader user would not know it had appeared.
 *
 * A MISS SAYS WHAT HAPPENS NEXT. Missed requirements pull their flashcards to the front of
 * practice, and the verdict says so and links there — or, when no card covers what was
 * missed, says that practice cannot bring it back. That sentence is the loop from the
 * question bank, through the requirement ids, to practice.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { buttonClasses } from '../ui/Button.jsx';
import { useScoreAnswer } from '../hooks/useKits.js';
import { ANSWER_MAX_CHARS, checkAnswer, describeVerdict } from './feedback.js';
import { practiceNote } from './weakSpots.js';

function PointList({ points, tone }) {
  return (
    <ul className="mt-1 space-y-1 text-sm text-slate-800">
      {points.map((point) => (
        <li key={point.key} className="break-words">
          <span className={`mr-1 rounded px-1.5 py-0.5 font-mono text-xs ${tone}`}>{point.tag}</span>
          {point.text}
          {point.reason ? <span className="text-slate-500"> — {point.reason}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export default function AnswerScorePanel({ kitId, question, cards = [], onBeforeScore }) {
  const ids = useId();
  const [answer, setAnswer] = useState('');
  const [saveError, setSaveError] = useState(null);
  const { score, data, error, isLoading } = useScoreAnswer(kitId);
  const verdictRef = useRef(null);

  const check = checkAnswer(answer);
  const blocked = !check.ok || isLoading;
  const verdict = data?.result ? describeVerdict(data.result) : null;
  const note = data?.result ? practiceNote(data.result.missedRequirementIds, cards) : null;

  useEffect(() => {
    if (data?.result) verdictRef.current?.focus();
  }, [data]);

  async function submit(event) {
    event.preventDefault();
    if (blocked) return;
    setSaveError(null);
    try {
      await onBeforeScore?.();
    } catch (thrown) {
      setSaveError(thrown);
      return;
    }
    // A failure is rendered from the hook's own `error`; the rejection is already handled.
    score(question.id, answer).catch(() => {});
  }

  const failure = saveError ?? error;

  return (
    <div className="mt-2 space-y-3" data-answer-panel={question.id}>
      <form onSubmit={submit} aria-busy={isLoading || undefined} className="space-y-2">
        <label htmlFor={`${ids}-answer`} className="block text-sm font-medium text-slate-900">
          Your answer
        </label>
        <textarea
          id={`${ids}-answer`}
          rows={6}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          aria-describedby={`${ids}-count ${ids}-reason ${ids}-scope`}
          className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
        />
        <p id={`${ids}-count`} className="text-xs text-slate-500">
          {check.length} / {ANSWER_MAX_CHARS} characters
        </p>
        <p id={`${ids}-reason`} className="text-xs text-slate-600">
          {check.ok ? '' : check.reason}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            aria-disabled={blocked || undefined}
            className={buttonClasses({ size: 'sm', className: blocked ? 'cursor-not-allowed opacity-60' : '' })}
          >
            {isLoading ? 'Scoring…' : 'Score my answer'}
          </button>
        </div>
        <p id={`${ids}-scope`} className="text-xs text-slate-500">
          Scored only against this question&apos;s outline and the requirements it covers. Each score uses part of
          today&apos;s model quota.
        </p>
      </form>

      {failure ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          {saveError ? `Your unsaved change could not be saved, so nothing was scored. ${saveError.message}` : failure.message}
        </p>
      ) : null}

      {verdict && !isLoading ? (
        <section
          ref={verdictRef}
          tabIndex={-1}
          aria-labelledby={`${ids}-verdict`}
          data-answer-verdict=""
          className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3"
        >
          <h4 id={`${ids}-verdict`} className="text-sm font-semibold text-slate-900">
            Scored: {verdict.headline}
          </h4>

          {verdict.hits.length > 0 ? (
            <div className="mt-2" data-verdict-hits="">
              <p className="text-xs font-medium uppercase tracking-wide text-emerald-800">Hit</p>
              <PointList points={verdict.hits} tone="bg-emerald-100 text-emerald-900" />
            </div>
          ) : null}

          {verdict.misses.length > 0 ? (
            <div className="mt-2" data-verdict-misses="">
              <p className="text-xs font-medium uppercase tracking-wide text-amber-800">Missed</p>
              <PointList points={verdict.misses} tone="bg-amber-100 text-amber-900" />
            </div>
          ) : null}

          {verdict.unjudged.length > 0 ? (
            <p className="mt-2 text-xs text-slate-600">
              Not judged: {verdict.unjudged.map((requirement) => requirement.id).join(', ')} — the scorer gave no verdict,
              so they count as neither hit nor missed.
            </p>
          ) : null}

          <div className="mt-3 rounded-md border border-sky-200 bg-white px-3 py-2" data-verdict-improvement="">
            <p className="text-xs font-medium uppercase tracking-wide text-sky-800">One improvement</p>
            <p className="mt-0.5 break-words text-sm text-slate-900">{verdict.improvement}</p>
          </div>

          {note ? (
            <div className="mt-3 flex flex-wrap items-center gap-2" data-verdict-practice="">
              <p className="min-w-0 break-words text-sm text-slate-700">{note.text}</p>
              {note.canPractise ? (
                <Link
                  to={`/kits/${encodeURIComponent(kitId)}/practice`}
                  className={buttonClasses({ variant: 'secondary', size: 'sm' })}
                >
                  Practise the flashcards
                </Link>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
