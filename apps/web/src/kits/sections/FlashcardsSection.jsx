/**
 * FlashcardsSection.jsx — the flashcards, front first, both faces editable.
 *
 * Decides: how cards are laid out, that the back is hidden until asked for, and that both
 * faces can be edited in place.
 *
 * Does NOT decide: what a card says, or how an edit is saved.
 *
 * THE BACK IS HIDDEN BECAUSE THAT IS WHAT A FLASHCARD IS. Showing both faces at once
 * turns recall into reading. The front is NOT the disclosure's summary any more: an Edit
 * button inside a `<summary>` is an interactive control nested inside another, which
 * screen readers announce inconsistently and which toggles the card when you meant to
 * edit it. So the front sits above, and "Show the answer" is the disclosure.
 *
 * An empty flashcard section is a real outcome, not an error: the time governor is
 * allowed to drop flashcards under pressure, and the empty state says so.
 */

import Card from '../../ui/Card.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import SectionState from '../../ui/SectionState.jsx';
import EditableText from '../EditableText.jsx';
import { deriveSectionState } from '../kitView.js';
import ProvenanceBadges from './ProvenanceBadges.jsx';

export default function FlashcardsSection({ kit, editor }) {
  const cards = kit?.flashcards;
  const present = Array.isArray(cards);
  const state = deriveSectionState({ present, isEmpty: present && cards.length === 0 });

  const editable = (card, field, label) => {
    const op = { type: 'edit-flashcard', id: card.id, field };
    return {
      value: card[field] ?? '',
      label: `${label} of ${card.id}`,
      status: editor.statusOf(op),
      onChange: (value) => editor.edit({ ...op, value }),
      onRevert: (original) => editor.revert(op, original),
    };
  };

  return (
    <Card title={`Flashcards${present ? ` (${cards.length})` : ''}`} titleAs="h2">
      <SectionState
        status={state.status}
        error={state.error}
        isEmpty={state.isEmpty}
        loadingLabel="Regenerating the flashcards…"
        empty={
          <EmptyState
            title="No flashcards"
            description="None were made for this kit — flashcards are one of the two things the build may skip to stay inside its time budget. You can add one by hand."
          />
        }
      >
        <ul className="grid gap-3 sm:grid-cols-2">
          {cards?.map((card) => (
            <li key={card.id} className="rounded-md border border-slate-200 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="font-mono">{card.id}</span>
                <ProvenanceBadges item={card} />
              </div>

              <EditableText className="mt-1" rows={2} {...editable(card, 'front', 'front')}>
                <p className="whitespace-pre-line break-words text-sm font-medium text-slate-900">
                  {card.front || <span className="font-normal text-slate-500">No front yet.</span>}
                </p>
              </EditableText>

              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-slate-700">Show the answer</summary>
                <EditableText className="mt-2 border-t border-slate-100 pt-2" rows={3} {...editable(card, 'back', 'back')}>
                  <p className="whitespace-pre-line break-words text-sm text-slate-700">
                    {card.back || <span className="text-slate-500">No answer yet.</span>}
                  </p>
                </EditableText>
              </details>
            </li>
          ))}
        </ul>
      </SectionState>
    </Card>
  );
}
