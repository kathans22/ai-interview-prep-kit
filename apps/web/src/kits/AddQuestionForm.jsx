/**
 * AddQuestionForm.jsx — write a question of your own into one category.
 *
 * Decides: what a person fills in to add a question, and that nothing is sent until the
 * question itself has been written.
 *
 * Does NOT decide: the new question's id, its provenance, or whether the kit accepts it.
 * The server assigns the id, marks the question `manual` — the brief requires it, and it
 * is what protects the question from every later regeneration — and validates the kit.
 *
 * THE REQUIREMENT LINK IS OPTIONAL, AND SAYS WHAT CHOOSING NONE MEANS. Coverage is exact
 * set membership on requirement ids, so an unlinked question counts toward no
 * requirement. That is a legitimate choice — a person may want a question the posting
 * never asked for — but it should be a choice, so the empty option names its consequence.
 *
 * ON FAILURE THE FORM STAYS OPEN WITH EVERYTHING TYPED STILL IN IT. The editor already
 * reports the failure in a toast; closing the form as well would throw away the question
 * someone just wrote, and the toast would be the only trace it existed.
 */

import { useState } from 'react';

import Button from '../ui/Button.jsx';
import Input from '../ui/Input.jsx';
import { DIFFICULTY_LABELS, PRIORITY_LABELS } from './kitView.js';

export default function AddQuestionForm({ category, categoryLabel, requirements = [], onSubmit, onCancel }) {
  const [prompt, setPrompt] = useState('');
  const [outline, setOutline] = useState('');
  const [requirementId, setRequirementId] = useState('');
  const [difficulty, setDifficulty] = useState('2');
  const [pending, setPending] = useState(false);

  const written = prompt.trim().length > 0;
  const noun = categoryLabel.toLowerCase();

  async function handleSubmit(event) {
    event.preventDefault();
    if (!written || pending) return;

    setPending(true);
    try {
      await onSubmit({
        type: 'add-question',
        category,
        prompt: prompt.trim(),
        answer_outline: outline.trim(),
        difficulty: Number(difficulty),
        requirement_ids: requirementId ? [requirementId] : [],
      });
    } catch {
      // Reported by the editor's toast. Stay open, keep the text: see the header.
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={`Add a ${noun} question`}
      className="mt-2 space-y-3 rounded-md border border-dashed border-slate-300 p-3"
    >
      <Input
        textarea
        label="Question"
        // Focus belongs in the form the person just opened.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        hint={`A ${noun} question in your own words. It will be marked as added by you, and no regeneration will replace it.`}
      />

      <Input
        textarea
        label="What a strong answer covers (optional)"
        value={outline}
        onChange={(event) => setOutline(event.target.value)}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${category}-requirement`} className="block text-sm font-medium text-slate-900">
            Requirement it tests
          </label>
          <select
            id={`${category}-requirement`}
            value={requirementId}
            onChange={(event) => setRequirementId(event.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-2 text-sm text-slate-900"
          >
            <option value="">None — it will not count towards coverage</option>
            {requirements.map((requirement) => (
              <option key={requirement.id} value={requirement.id}>
                {requirement.id} — {requirement.text} ({PRIORITY_LABELS[requirement.priority] ?? requirement.priority})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={`${category}-difficulty`} className="block text-sm font-medium text-slate-900">
            Difficulty
          </label>
          <select
            id={`${category}-difficulty`}
            value={difficulty}
            onChange={(event) => setDifficulty(event.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-2 text-sm text-slate-900"
          >
            {[1, 2, 3].map((level) => (
              <option key={level} value={String(level)}>
                {DIFFICULTY_LABELS[level]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* The reason the button cannot be pressed, beside the button that cannot be pressed. */}
      <p id={`${category}-add-reason`} className="text-xs text-slate-500">
        {written ? ' ' : 'Write the question to add it.'}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!written || pending} aria-describedby={`${category}-add-reason`}>
          {pending ? 'Adding…' : 'Add question'}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
