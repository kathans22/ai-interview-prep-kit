/**
 * AnswerScorePanel.jsx — type an answer to this question, and see how it scores.
 *
 * Decides: that the input is a textarea behind the person's own click (scoring costs
 * quota, so it must never fire because a page rendered), that the verdict leads with the
 * score and says what it was made of, and that a failure keeps the typed answer.
 *
 * Does NOT decide: what the answer is judged against (the server scores ONLY this
 * question's answer outline and the text of the requirements it covers — that is the
 * whole point), what the score does to the practice order (the practice log decides,
 * via the entry this panel's submission records), or how an edit to the question itself
 * is saved (that is the editor's, and this panel touches no revision).
 *
 * THE VERDICT NAMES THE WEAK SPOTS. The server returns which requirement ids sit behind
 * the missed points, and the panel says what those will do: come back first in the next
 * practice session. That is the loop the feature exists to close, and the person is told
 * rather than left to guess why the panel mentions practice.
 *
 * ONE PANEL PER QUESTION, OPENED ON DEMAND. Twenty-odd always-open textareas are a wall
 * at 360px, the same reason the answer outline sits behind a disclosure.
 */

import { useState } from 'react';
import { useParams } from 'react-router-dom';

import { buttonClasses } from '../../ui/Button.jsx';
import Spinner from '../../ui/Spinner.jsx';
import { useScoreAnswer } from '../../hooks/useKits.js';
import {
  canSubmit,
  createAnswerScorer,
  describeResult,
  isScoring,
  scoringFailed,
  scoringStarted,
  scoringSucceeded,
  setDraft,
} from '../../practice/answerScoring.js';

export default function AnswerScorePanel({ question }) {
  const { id: kitId } = useParams();
  const { score, isLoading } = useScoreAnswer(kitId);
  const [state, setState] = useState(() => createAnswerScorer());
  const [open, setOpen] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (!canSubmit(state)) return;

    const scoring = scoringStarted(state);
    setState(scoring);
    try {
      const result = await score({ questionId: question.id, answer: scoring.answer });
      setState((current) => scoringSucceeded(current, result));
    } catch (error) {
      setState((current) => scoringFailed(current, error));
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClasses({ variant: 'secondary', size: 'sm', className: 'mt-2' })}
      >
        Score your answer
      </button>
    );
  }

  const result = state.result;

  return (
    <form onSubmit={submit} className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      <label htmlFor={`answer-${question.id}`} className="block text-sm font-medium text-slate-700">
        Your answer to {question.id}
      </label>
      <textarea
        id={`answer-${question.id}`}
        value={state.answer}
        onChange={(event) => setState((current) => setDraft(current, event.target.value))}
        rows={4}
        className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-1 focus:ring-sky-600"
        placeholder="Type how you would answer this in the interview…"
      />

      <div className="mt-2 flex items-center gap-2">
        <button type="submit" disabled={!canSubmit(state)} className={buttonClasses({ size: 'sm' })}>
          {isScoring(state) ? 'Scoring…' : 'Score my answer'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setState(createAnswerScorer());
          }}
          className={buttonClasses({ variant: 'ghost', size: 'sm' })}
        >
          Close
        </button>
        {isScoring(state) || isLoading ? <Spinner label="Scoring your answer…" /> : null}
      </div>

      <p className="mt-1 text-xs text-slate-500">
        Scored only against this question's answer outline and the requirements it covers. A score costs one
        model call.
      </p>

      {state.status === 'failed' ? (
        <p role="alert" className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-sm text-amber-900">
          {state.error?.message ?? 'The answer could not be scored.'} Your answer is still here — try again.
        </p>
      ) : null}

      {state.status === 'scored' && result ? (
        <div className="mt-3 rounded-md border border-slate-200 bg-white p-3" data-scored={question.id}>
          <p className="text-sm font-semibold text-slate-900">{describeResult(result)}</p>

          {result.hits.length > 0 ? (
            <div className="mt-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-emerald-700">What was hit</h4>
              <ul className="mt-1 space-y-1">
                {result.hits.map((hit) => (
                  <li key={hit.point} className="break-words text-sm text-slate-700">
                    <span aria-hidden="true" className="mr-1 font-semibold text-emerald-700">✓</span>
                    <span className="font-medium">{hit.point}</span> — {hit.explanation}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {result.misses.length > 0 ? (
            <div className="mt-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-rose-700">What was missed</h4>
              <ul className="mt-1 space-y-1">
                {result.misses.map((miss) => (
                  <li key={miss.point} className="break-words text-sm text-slate-700">
                    <span aria-hidden="true" className="mr-1 font-semibold text-rose-700">✗</span>
                    <span className="font-medium">{miss.point}</span> — {miss.explanation}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="mt-2 break-words text-sm text-slate-700">
            <span className="font-medium">One improvement:</span> {result.improvement}
          </p>

          {result.weakRequirementIds.length > 0 ? (
            <p className="mt-2 text-xs text-slate-600">
              These weak spots will come back first in your next practice session.
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
