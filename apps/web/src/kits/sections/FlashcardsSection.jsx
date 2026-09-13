/**
 * FlashcardsSection.jsx — the flashcards, front first.
 *
 * Decides: how cards are laid out, and that the back is hidden until asked for.
 *
 * Does NOT decide: what a card says. That is generation, or the person editing it.
 *
 * THE BACK IS HIDDEN BECAUSE THAT IS WHAT A FLASHCARD IS. Showing both faces at once
 * turns recall into reading. A native `<details>` does the reveal, so it is operable
 * from the keyboard and announced as expandable without any code of our own.
 *
 * An empty flashcard section is a real outcome, not an error: the time governor is
 * allowed to drop flashcards under pressure, and the empty state says so.
 */

import Card from '../../ui/Card.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import SectionState from '../../ui/SectionState.jsx';
import { deriveSectionState } from '../kitView.js';
import ProvenanceBadges from './ProvenanceBadges.jsx';

export default function FlashcardsSection({ kit }) {
  const cards = kit?.flashcards;
  const present = Array.isArray(cards);
  const state = deriveSectionState({ present, isEmpty: present && cards.length === 0 });

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
              <details className="mt-1">
                <summary className="cursor-pointer whitespace-pre-line break-words text-sm font-medium text-slate-900">
                  {card.front}
                </summary>
                <p className="mt-2 whitespace-pre-line break-words border-t border-slate-100 pt-2 text-sm text-slate-700">
                  {card.back}
                </p>
              </details>
            </li>
          ))}
        </ul>
      </SectionState>
    </Card>
  );
}
