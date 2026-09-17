/**
 * AnswerPractice.jsx — "Answer it, and get scored", under one question in the bank.
 *
 * Decides: that the answer form sits behind a disclosure, that it is not built until the
 * disclosure is first opened, and that once built it stays — closing the disclosure must
 * not throw away an answer someone typed.
 *
 * Does NOT decide: anything about the form or the verdict (`AnswerScorePanel`).
 *
 * BUILT ON FIRST OPEN, NOT ON RENDER. A bank of twenty-odd questions would otherwise build
 * twenty-odd forms nobody opened, each holding its own request state.
 */

import { useState } from 'react';

import AnswerScorePanel from './AnswerScorePanel.jsx';

export default function AnswerPractice({ kitId, question, onBeforeScore }) {
  const [opened, setOpened] = useState(false);

  return (
    <details
      className="mt-2"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary className="cursor-pointer text-sm text-slate-700">Answer it, and get scored</summary>
      {opened ? <AnswerScorePanel kitId={kitId} question={question} onBeforeScore={onBeforeScore} /> : null}
    </details>
  );
}
