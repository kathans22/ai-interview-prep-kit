/**
 * QuestionsSection.jsx — the question bank, grouped by category, editable in place.
 *
 * Decides: how questions are grouped and laid out, that every category is shown —
 * including an empty one — and which parts of a question can be edited, added or deleted
 * here.
 *
 * Does NOT decide: which category a question belongs in, how hard it is, or how an edit
 * is saved. Grouping is `groupQuestions`; saving is the editor passed in.
 *
 * EVERY CATEGORY IS ALWAYS RENDERED, WITH ITS OWN ADD BUTTON. A section-wide empty state
 * would replace the groups — and with them the only way to add a question to an empty
 * kit. So there is no section-level empty state here; each empty group says so and
 * offers to add.
 *
 * A QUESTION BEING ADDED IS READ-ONLY UNTIL IT IS SAVED. Until the server confirms it,
 * it has only a temporary id, and an edit aimed at that id would reach the server as an
 * id it has never heard of. The row says "Adding…" rather than offering controls that
 * would fail.
 *
 * DELETING ASKS FIRST, THEN CAN STILL BE TAKEN BACK. The dialog catches the slip of a
 * finger; the undo window catches the second thought. A deleted question leaves a
 * placeholder in its place for the window, and focus moves onto its Undo button.
 *
 * FOCUS NEVER DROPS TO THE TOP OF THE PAGE. It returns to the Add button when the form
 * closes, to the Delete button after an undo, and — when the undo window closes under a
 * focused Undo button — to the category's Add button, which is always there.
 *
 * THE ANSWER OUTLINE IS BEHIND A DISCLOSURE. Twenty-odd questions each with a paragraph
 * of outline is a wall at 360px. A native `<details>` is keyboard-operable and announced
 * correctly without any code of our own. It is shown even when the outline is empty, so
 * an empty one can be written.
 */

import { useEffect, useRef, useState } from 'react';

import { buttonClasses } from '../../ui/Button.jsx';
import Card from '../../ui/Card.jsx';
import ConfirmDialog from '../../ui/ConfirmDialog.jsx';
import SectionState from '../../ui/SectionState.jsx';
import AddQuestionForm from '../AddQuestionForm.jsx';
import DeletedPlaceholder from '../DeletedPlaceholder.jsx';
import EditableText from '../EditableText.jsx';
import { DIFFICULTY_LABELS, deriveSectionState, groupQuestions, indexRequirements } from '../kitView.js';
import ProvenanceBadges from './ProvenanceBadges.jsx';

/** The field operation for one question field, without its value. */
const fieldOp = (id, field) => ({ type: 'edit-question', id, field });
const deleteOp = (id) => ({ type: 'delete-question', id });

const countVisible = (list) => list.filter((question) => !question.pendingDelete).length;

export default function QuestionsSection({ kit, editor }) {
  const questions = kit?.questions;
  const present = Array.isArray(questions);
  const groups = groupQuestions(questions);
  const requirements = indexRequirements(kit?.role?.requirements);
  const state = deriveSectionState({ present });

  const [adding, setAdding] = useState(null);
  const addButtons = useRef({});
  const focusAddButton = (category) => requestAnimationFrame(() => addButtons.current[category]?.focus());

  const [confirming, setConfirming] = useState(null);
  const [justDeleted, setJustDeleted] = useState(null);
  const deleteButtons = useRef({});

  // When the undo window closes, the Undo button goes. If it had focus, the browser drops
  // focus to the page body; put it somewhere stable instead. Once the question is really
  // gone, there is nothing left to track.
  const justDeletedUndoable = justDeleted ? editor.statusOf(deleteOp(justDeleted.id)) === 'queued' : false;
  const justDeletedExists = justDeleted ? (questions ?? []).some((q) => q.id === justDeleted.id) : false;
  useEffect(() => {
    if (!justDeleted || justDeletedUndoable) return;
    if (!document.activeElement || document.activeElement === document.body) focusAddButton(justDeleted.category);
    if (!justDeletedExists) setJustDeleted(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justDeleted, justDeletedUndoable, justDeletedExists]);

  async function submitQuestion(op) {
    // Rejects on failure, which leaves the form open with the text still in it.
    await editor.add(op);
    setAdding(null);
    focusAddButton(op.category);
  }

  function confirmDelete() {
    if (!confirming) return;
    editor.remove(deleteOp(confirming.id));
    setJustDeleted({ id: confirming.id, category: confirming.category });
    setConfirming(null);
  }

  function undoDelete(question) {
    if (!editor.undoRemove(deleteOp(question.id))) return;
    setJustDeleted(null);
    requestAnimationFrame(() => deleteButtons.current[question.id]?.focus());
  }

  /** Props that make one question field editable through the shared editor. */
  const editable = (question, field, label) => {
    const op = fieldOp(question.id, field);
    return {
      value: question[field] ?? '',
      label: `${label} for ${question.id}`,
      status: editor.statusOf(op),
      onChange: (value) => editor.edit({ ...op, value }),
      onRevert: (original) => editor.revert(op, original),
    };
  };

  return (
    <Card title={`Question bank${present ? ` (${countVisible(questions)})` : ''}`} titleAs="h2">
      <SectionState status={state.status} error={state.error}>
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.category} aria-labelledby={`questions-${group.category}`}>
              <h3 id={`questions-${group.category}`} className="text-sm font-semibold text-slate-900">
                {group.label} <span className="font-normal text-slate-500">({countVisible(group.questions)})</span>
              </h3>

              {group.questions.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">No {group.label.toLowerCase()} questions yet.</p>
              ) : (
                <ol className="mt-2 space-y-2">
                  {group.questions.map((question) => {
                    if (question.pendingDelete) {
                      return (
                        <li key={question.id}>
                          <DeletedPlaceholder
                            id={question.id}
                            noun="question"
                            undoable={editor.statusOf(deleteOp(question.id)) === 'queued'}
                            onUndo={() => undoDelete(question)}
                            autoFocus={justDeleted?.id === question.id}
                          />
                        </li>
                      );
                    }

                    if (question.pendingAdd) {
                      return (
                        <li key={question.id} className="rounded-md border border-dashed border-slate-300 p-3">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            <span>Adding…</span>
                            <ProvenanceBadges item={question} />
                          </div>
                          <p className="mt-1 whitespace-pre-line break-words text-sm font-medium text-slate-700">
                            {question.prompt}
                          </p>
                        </li>
                      );
                    }

                    return (
                      <li key={question.id} className="rounded-md border border-slate-200 p-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <span className="font-mono">{question.id}</span>
                          <span>{DIFFICULTY_LABELS[question.difficulty] ?? `Difficulty ${question.difficulty}`}</span>
                          <ProvenanceBadges item={question} />
                          <button
                            ref={(node) => {
                              deleteButtons.current[question.id] = node;
                            }}
                            type="button"
                            onClick={() => setConfirming(question)}
                            aria-label={`Delete ${question.id}`}
                            className={buttonClasses({ variant: 'ghost', size: 'sm', className: 'ml-auto' })}
                          >
                            Delete
                          </button>
                        </div>

                        <EditableText className="mt-1" rows={3} {...editable(question, 'prompt', 'prompt')}>
                          <p className="whitespace-pre-line break-words text-sm font-medium text-slate-900">
                            {question.prompt || <span className="font-normal text-slate-500">No prompt yet.</span>}
                          </p>
                        </EditableText>

                        {(question.requirement_ids ?? []).length > 0 ? (
                          <p className="mt-1 break-words text-xs text-slate-500">
                            For:{' '}
                            {question.requirement_ids
                              .map((id) => requirements.get(id)?.text ?? id)
                              .join(' · ')}
                          </p>
                        ) : null}

                        <details className="mt-2">
                          <summary className="cursor-pointer text-sm text-slate-700">What a strong answer covers</summary>
                          <EditableText className="mt-1" rows={5} {...editable(question, 'answer_outline', 'answer outline')}>
                            <p className="whitespace-pre-line break-words text-sm text-slate-700">
                              {question.answer_outline || <span className="text-slate-500">No outline yet.</span>}
                            </p>
                          </EditableText>
                        </details>
                      </li>
                    );
                  })}
                </ol>
              )}

              {adding === group.category ? (
                <AddQuestionForm
                  category={group.category}
                  categoryLabel={group.label}
                  requirements={kit?.role?.requirements ?? []}
                  onSubmit={submitQuestion}
                  onCancel={() => {
                    setAdding(null);
                    focusAddButton(group.category);
                  }}
                />
              ) : (
                <button
                  ref={(node) => {
                    addButtons.current[group.category] = node;
                  }}
                  type="button"
                  onClick={() => setAdding(group.category)}
                  className={buttonClasses({ variant: 'secondary', size: 'sm', className: 'mt-2' })}
                >
                  Add a {group.label.toLowerCase()} question
                </button>
              )}
            </section>
          ))}
        </div>
      </SectionState>

      <ConfirmDialog
        open={Boolean(confirming)}
        onClose={() => setConfirming(null)}
        onConfirm={confirmDelete}
        title="Delete this question?"
        description="You can undo it for a few seconds afterwards."
        confirmLabel="Delete the question"
      >
        <p className="whitespace-pre-line break-words">{confirming?.prompt || 'A question with no prompt yet.'}</p>
      </ConfirmDialog>
    </Card>
  );
}
