/**
 * FlashcardsSection.jsx — the flashcards, front first, editable, addable and deletable.
 *
 * Decides: how cards are laid out, that the back is hidden until asked for, that both
 * faces can be edited in place, where a new card is written, and how one is removed.
 *
 * Does NOT decide: what a card says, or how an edit, an add or a delete is saved.
 *
 * THE BACK IS HIDDEN BECAUSE THAT IS WHAT A FLASHCARD IS. Showing both faces at once
 * turns recall into reading. The front is NOT the disclosure's summary: an Edit button
 * inside a `<summary>` is an interactive control nested inside another, which screen
 * readers announce inconsistently and which toggles the card when you meant to edit it.
 *
 * THE ADD BUTTON LIVES IN THE SECTION HEADER, so it stays reachable when the section is
 * empty. An empty deck is a real outcome — the time governor may drop flashcards — and
 * the empty state must not hide the one control that fixes it. It is also where focus
 * goes when an undo window closes under a focused Undo button.
 *
 * A CARD BEING ADDED IS READ-ONLY UNTIL IT IS SAVED, for the same reason as a question:
 * its temporary id means nothing to the server.
 *
 * DELETING ASKS FIRST, THEN CAN STILL BE TAKEN BACK for a few seconds, exactly as a
 * question does — see `QuestionsSection.jsx`.
 */

import { useEffect, useRef, useState } from 'react';

import { buttonClasses } from '../../ui/Button.jsx';
import Card from '../../ui/Card.jsx';
import ConfirmDialog from '../../ui/ConfirmDialog.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import SectionState from '../../ui/SectionState.jsx';
import AddFlashcardForm from '../AddFlashcardForm.jsx';
import DeletedPlaceholder from '../DeletedPlaceholder.jsx';
import EditableText from '../EditableText.jsx';
import { deriveSectionState } from '../kitView.js';
import ProvenanceBadges from './ProvenanceBadges.jsx';

const deleteOp = (id) => ({ type: 'delete-flashcard', id });

export default function FlashcardsSection({ kit, editor }) {
  const cards = kit?.flashcards;
  const present = Array.isArray(cards);
  const visibleCount = present ? cards.filter((card) => !card.pendingDelete).length : 0;
  const state = deriveSectionState({ present, isEmpty: present && cards.length === 0 });

  const [adding, setAdding] = useState(false);
  const addButton = useRef(null);
  const focusAddButton = () => requestAnimationFrame(() => addButton.current?.focus());

  const [confirming, setConfirming] = useState(null);
  const [justDeleted, setJustDeleted] = useState(null);
  const deleteButtons = useRef({});

  const justDeletedUndoable = justDeleted ? editor.statusOf(deleteOp(justDeleted)) === 'queued' : false;
  const justDeletedExists = justDeleted ? (cards ?? []).some((card) => card.id === justDeleted) : false;
  useEffect(() => {
    if (!justDeleted || justDeletedUndoable) return;
    if (!document.activeElement || document.activeElement === document.body) focusAddButton();
    if (!justDeletedExists) setJustDeleted(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justDeleted, justDeletedUndoable, justDeletedExists]);

  async function submitCard(op) {
    await editor.add(op);
    setAdding(false);
    focusAddButton();
  }

  function confirmDelete() {
    if (!confirming) return;
    editor.remove(deleteOp(confirming.id));
    setJustDeleted(confirming.id);
    setConfirming(null);
  }

  function undoDelete(card) {
    if (!editor.undoRemove(deleteOp(card.id))) return;
    setJustDeleted(null);
    requestAnimationFrame(() => deleteButtons.current[card.id]?.focus());
  }

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
    <Card
      title={`Flashcards${present ? ` (${visibleCount})` : ''}`}
      titleAs="h2"
      actions={
        adding ? null : (
          <button
            ref={addButton}
            type="button"
            onClick={() => setAdding(true)}
            className={buttonClasses({ variant: 'secondary', size: 'sm' })}
          >
            Add a flashcard
          </button>
        )
      }
    >
      {adding ? (
        <AddFlashcardForm
          requirements={kit?.role?.requirements ?? []}
          onSubmit={submitCard}
          onCancel={() => {
            setAdding(false);
            focusAddButton();
          }}
        />
      ) : null}

      <SectionState
        status={state.status}
        error={state.error}
        isEmpty={state.isEmpty}
        loadingLabel="Regenerating the flashcards…"
        empty={
          <EmptyState
            title="No flashcards"
            description="None were made for this kit — flashcards are one of the two things the build may skip to stay inside its time budget. Add one with the button above."
          />
        }
      >
        <ul className="grid gap-3 sm:grid-cols-2">
          {cards?.map((card) => {
            if (card.pendingDelete) {
              return (
                <li key={card.id}>
                  <DeletedPlaceholder
                    id={card.id}
                    noun="flashcard"
                    undoable={editor.statusOf(deleteOp(card.id)) === 'queued'}
                    onUndo={() => undoDelete(card)}
                    autoFocus={justDeleted === card.id}
                    className="h-full"
                  />
                </li>
              );
            }

            if (card.pendingAdd) {
              return (
                <li key={card.id} className="rounded-md border border-dashed border-slate-300 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span>Adding…</span>
                    <ProvenanceBadges item={card} />
                  </div>
                  <p className="mt-1 whitespace-pre-line break-words text-sm font-medium text-slate-700">{card.front}</p>
                </li>
              );
            }

            return (
              <li key={card.id} className="rounded-md border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="font-mono">{card.id}</span>
                  <ProvenanceBadges item={card} />
                  <button
                    ref={(node) => {
                      deleteButtons.current[card.id] = node;
                    }}
                    type="button"
                    onClick={() => setConfirming(card)}
                    aria-label={`Delete ${card.id}`}
                    className={buttonClasses({ variant: 'ghost', size: 'sm', className: 'ml-auto' })}
                  >
                    Delete
                  </button>
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
            );
          })}
        </ul>
      </SectionState>

      <ConfirmDialog
        open={Boolean(confirming)}
        onClose={() => setConfirming(null)}
        onConfirm={confirmDelete}
        title="Delete this flashcard?"
        description="You can undo it for a few seconds afterwards."
        confirmLabel="Delete the flashcard"
      >
        <p className="whitespace-pre-line break-words">{confirming?.front || 'A flashcard with no front yet.'}</p>
      </ConfirmDialog>
    </Card>
  );
}
