/**
 * AddFlashcardForm.jsx — write a flashcard of your own.
 *
 * Decides: what a person fills in to add a card, and that both faces must be written.
 *
 * Does NOT decide: the card's id, its provenance, or whether the kit accepts it. The
 * server assigns the id, marks the card `manual` and validates the kit.
 *
 * BOTH FACES ARE REQUIRED HERE, although the server would accept an empty one. A card with
 * a question and no answer is not a flashcard, and the moment to catch that is while the
 * person is still writing it, not after it sits in the deck doing nothing.
 *
 * ON FAILURE THE FORM STAYS OPEN WITH BOTH FACES STILL IN IT, for the same reason as the
 * question form: the toast reports the failure, and the card someone wrote must not
 * vanish with it.
 */

import { useState } from 'react';

import Button from '../ui/Button.jsx';
import Input from '../ui/Input.jsx';
import { PRIORITY_LABELS } from './kitView.js';

export default function AddFlashcardForm({ requirements = [], onSubmit, onCancel }) {
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [requirementId, setRequirementId] = useState('');
  const [pending, setPending] = useState(false);

  const missing = [];
  if (!front.trim()) missing.push('the front');
  if (!back.trim()) missing.push('the back');
  const ready = missing.length === 0;

  async function handleSubmit(event) {
    event.preventDefault();
    if (!ready || pending) return;

    setPending(true);
    try {
      await onSubmit({
        type: 'add-flashcard',
        front: front.trim(),
        back: back.trim(),
        requirement_ids: requirementId ? [requirementId] : [],
      });
    } catch {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="Add a flashcard"
      className="mb-3 space-y-3 rounded-md border border-dashed border-slate-300 p-3"
    >
      <Input
        textarea
        label="Front"
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        value={front}
        onChange={(event) => setFront(event.target.value)}
        hint="The prompt you want to recall from."
      />
      <Input textarea label="Back" value={back} onChange={(event) => setBack(event.target.value)} />

      <div>
        <label htmlFor="flashcard-requirement" className="block text-sm font-medium text-slate-900">
          Requirement it helps with
        </label>
        <select
          id="flashcard-requirement"
          value={requirementId}
          onChange={(event) => setRequirementId(event.target.value)}
          className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-2 text-sm text-slate-900"
        >
          <option value="">None</option>
          {requirements.map((requirement) => (
            <option key={requirement.id} value={requirement.id}>
              {requirement.id} — {requirement.text} ({PRIORITY_LABELS[requirement.priority] ?? requirement.priority})
            </option>
          ))}
        </select>
      </div>

      <p id="flashcard-add-reason" className="text-xs text-slate-500">
        {ready ? ' ' : `Write ${missing.join(' and ')} to add the card.`}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!ready || pending} aria-describedby="flashcard-add-reason">
          {pending ? 'Adding…' : 'Add flashcard'}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
