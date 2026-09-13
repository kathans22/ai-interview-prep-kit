/**
 * QuestionsSection.jsx — the question bank, grouped by category, editable in place.
 *
 * Decides: how questions are grouped and laid out, that every category is shown —
 * including an empty one — and which parts of a question can be edited, added, deleted
 * or rearranged here.
 *
 * Does NOT decide: which category a question belongs in, how hard it is, or how an edit
 * is saved. Grouping is `groupQuestions`; what a drop means is `planMove`; saving is the
 * editor passed in.
 *
 * EVERY CATEGORY IS ALWAYS RENDERED, WITH ITS OWN ADD BUTTON. A section-wide empty state
 * would replace the groups — and with them the only way to add a question to an empty
 * kit, and the only place to drop one. So there is no section-level empty state here;
 * each empty group says so, offers to add, and accepts a dragged question.
 *
 * A QUESTION BEING ADDED IS READ-ONLY UNTIL IT IS SAVED. Until the server confirms it,
 * it has only a temporary id, and an edit aimed at that id would reach the server as an
 * id it has never heard of. The row says "Adding…" rather than offering controls that
 * would fail, and it has no drag handle.
 *
 * DELETING ASKS FIRST, THEN CAN STILL BE TAKEN BACK. The dialog catches the slip of a
 * finger; the undo window catches the second thought. A deleted question leaves a
 * placeholder in its place for the window, and focus moves onto its Undo button.
 *
 * DRAGGING SHOWS WHERE IT WILL LAND BEFORE IT LANDS. A line is drawn at the drop point,
 * and only where the drop would change something — a line under the question's own
 * position would promise a move that does nothing.
 *
 * EVERY DRAG HAS A KEYBOARD EQUIVALENT, and the drag handle is therefore hidden from
 * assistive technology rather than offered as a control it cannot operate. Move up and
 * Move down step within the category; Change category opens the list of the others.
 * Both produce exactly the operations a drag would. After a move, focus stays on the
 * control that made it — even when the row has jumped to another category — and a
 * polite announcement says where the question now is, because the jump itself is silent.
 *
 * AN UNAVAILABLE MOVE IS `aria-disabled`, NOT `disabled`. A disabled button cannot hold
 * focus, so pressing Move up until the question reaches the top would throw focus to the
 * page body on the last press.
 *
 * EACH CATEGORY REGENERATES ON ITS OWN, and while it does only that category waits: its
 * list is replaced by progress and stops being a drop target, and every other category
 * stays editable. Afterwards the replaced and new questions are outlined, and a summary
 * under the heading says what was replaced, kept, added and removed.
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
import Spinner from '../../ui/Spinner.jsx';
import AddQuestionForm from '../AddQuestionForm.jsx';
import CategoryMenu from '../CategoryMenu.jsx';
import DeletedPlaceholder from '../DeletedPlaceholder.jsx';
import EditableText from '../EditableText.jsx';
import PinToggle from '../PinToggle.jsx';
import RegenerateButton from '../RegenerateButton.jsx';
import RegenerationSummary from '../RegenerationSummary.jsx';
import { describeTarget } from '../regeneration.js';
import {
  CATEGORY_LABELS,
  DIFFICULTY_LABELS,
  QUESTION_CATEGORY_ORDER,
  deriveSectionState,
  groupQuestions,
  indexRequirements,
} from '../kitView.js';
import { planMove, planStep, positionAfter } from '../reorder.js';
import { useQuestionDrag } from '../useQuestionDrag.js';
import ProvenanceBadges from './ProvenanceBadges.jsx';

/** The field operation for one question field, without its value. */
const fieldOp = (id, field) => ({ type: 'edit-question', id, field });
const deleteOp = (id) => ({ type: 'delete-question', id });

const countVisible = (list) => list.filter((question) => !question.pendingDelete).length;

/** The line drawn where a dragged question would land. */
function DropLine({ className = '' }) {
  return <div data-drop-indicator="" aria-hidden="true" className={`h-0.5 rounded bg-sky-600 ${className}`} />;
}

/** Six dots: the conventional "this can be dragged" mark. */
function GripIcon() {
  return (
    <svg viewBox="0 0 12 16" width="12" height="16" fill="currentColor" aria-hidden="true">
      {[3, 8, 13].flatMap((cy) => [3, 9].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.5" />))}
    </svg>
  );
}

export default function QuestionsSection({ kit, editor, regeneration, onRegenerate, onUndo }) {
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

  const [announcement, setAnnouncement] = useState('');
  const moveControls = useRef({});
  const moveControlRef = (id, control) => (node) => {
    moveControls.current[`${id}:${control}`] = node;
  };

  /**
   * Apply a move, say where the question ended up, and — for a keyboard move — put focus
   * back on the control that made it, which may now be in another category's list.
   */
  function move(ops, id, control = null) {
    if (ops.length === 0) return;
    const where = positionAfter(questions, ops, id);
    editor.arrange(ops);
    if (where) {
      const label = CATEGORY_LABELS[where.category] ?? where.category;
      setAnnouncement(`${id} moved to position ${where.position} of ${where.total} in ${label}.`);
    }
    if (control) requestAnimationFrame(() => moveControls.current[`${id}:${control}`]?.focus());
  }

  const drag = useQuestionDrag({
    onDrop: (drop) => move(planMove(questions, drop), drop.id),
  });
  // Where the line goes — and whether there is a line at all.
  const dropTarget =
    drag.draggingId && drag.target && planMove(questions, { id: drag.draggingId, ...drag.target }).length > 0
      ? drag.target
      : null;

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

  const lineBefore = (category, id) =>
    dropTarget?.category === category && dropTarget.beforeId === id ? (
      <DropLine className="absolute inset-x-0 -top-[5px]" />
    ) : null;

  return (
    <Card title={`Question bank${present ? ` (${countVisible(questions)})` : ''}`} titleAs="h2">
      <SectionState status={state.status} error={state.error}>
        {/* Sections are padded rather than spaced, so the categories touch and a drag
            passing from one to the next never crosses a gap that is no target at all. */}
        <div className="-my-3">
          {groups.map((group) => {
            const target = { section: 'questions', category: group.category };
            const busy = regeneration?.isRunning(target) ?? false;
            const result = busy ? null : regeneration?.resultFor(target) ?? null;
            const regenerable =
              QUESTION_CATEGORY_ORDER.includes(group.category) &&
              group.questions.some((question) => !question.pendingAdd && !question.pendingDelete);

            return (
            <section
              key={group.category}
              aria-labelledby={`questions-${group.category}`}
              aria-busy={busy || undefined}
              // A category that is regenerating is not a place to drop a question.
              data-drop-category={busy ? undefined : group.category}
              className="py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id={`questions-${group.category}`} className="text-sm font-semibold text-slate-900">
                  {group.label} <span className="font-normal text-slate-500">({countVisible(group.questions)})</span>
                </h3>
                {regenerable || busy ? (
                  <RegenerateButton target={target} regeneration={regeneration} onRegenerate={onRegenerate} />
                ) : null}
              </div>

              <RegenerationSummary
                className="mt-2"
                result={result}
                onDismiss={() => regeneration.dismiss(target)}
                onUndo={regeneration?.canUndo(target) ? () => onUndo(target) : null}
              />

              {busy ? (
                <div className="py-6">
                  <Spinner label={regeneration?.busyLabel(target) ?? describeTarget(target).running} />
                </div>
              ) : (
              <>
              {group.questions.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">No {group.label.toLowerCase()} questions yet.</p>
              ) : (
                <ol className="mt-2 space-y-2">
                  {group.questions.map((question) => {
                    if (question.pendingDelete) {
                      return (
                        <li key={question.id} data-question-id={question.id} className="relative">
                          {lineBefore(group.category, question.id)}
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
                        <li
                          key={question.id}
                          data-question-id={question.id}
                          className="relative rounded-md border border-dashed border-slate-300 p-3"
                        >
                          {lineBefore(group.category, question.id)}
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

                    const isDragging = drag.draggingId === question.id;
                    const regenerated = result?.changed.has(question.id) ?? false;

                    return (
                      <li
                        key={question.id}
                        data-question-id={question.id}
                        data-regenerated={regenerated ? '' : undefined}
                        className={`relative rounded-md border p-3 ${
                          isDragging
                            ? 'border-sky-600 bg-sky-50 opacity-60'
                            : regenerated
                              ? 'border-emerald-400 ring-1 ring-emerald-400'
                              : 'border-slate-200'
                        }`}
                      >
                        {lineBefore(group.category, question.id)}
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <span
                            aria-hidden="true"
                            data-drag-handle={question.id}
                            title="Drag to move"
                            className="-my-1 -ml-1 inline-flex h-8 w-8 cursor-grab touch-none select-none items-center justify-center rounded text-slate-400 hover:bg-slate-100 active:cursor-grabbing"
                            {...drag.handleProps(question.id)}
                          >
                            <GripIcon />
                          </span>
                          <span className="font-mono">{question.id}</span>
                          <span>{DIFFICULTY_LABELS[question.difficulty] ?? `Difficulty ${question.difficulty}`}</span>
                          <ProvenanceBadges item={question} />
                          {regenerated ? (
                            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-900">
                              {result.added.has(question.id) ? 'New' : 'Regenerated'}
                            </span>
                          ) : null}
                          <span className="ml-auto inline-flex items-center gap-1">
                            <PinToggle
                              item={question}
                              onToggle={(pinned) => editor.edit({ type: 'pin', id: question.id, pinned })}
                            />
                            <button
                              ref={(node) => {
                                deleteButtons.current[question.id] = node;
                              }}
                              type="button"
                              onClick={() => setConfirming(question)}
                              aria-label={`Delete ${question.id}`}
                              className={buttonClasses({ variant: 'ghost', size: 'sm' })}
                            >
                              Delete
                            </button>
                          </span>
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

                        <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-slate-100 pt-2">
                          {['up', 'down'].map((direction) => {
                            const ops = planStep(questions, question.id, direction);
                            const unavailable = ops.length === 0;
                            const text = direction === 'up' ? 'Move up' : 'Move down';
                            return (
                              <button
                                key={direction}
                                ref={moveControlRef(question.id, direction)}
                                type="button"
                                aria-label={`${text}, ${question.id}`}
                                aria-disabled={unavailable || undefined}
                                onClick={() => move(ops, question.id, direction)}
                                className={buttonClasses({
                                  variant: 'ghost',
                                  size: 'sm',
                                  className: unavailable ? 'cursor-not-allowed opacity-50' : '',
                                })}
                              >
                                {text}
                              </button>
                            );
                          })}
                          <CategoryMenu
                            id={question.id}
                            options={QUESTION_CATEGORY_ORDER.filter((category) => category !== question.category).map(
                              (category) => ({ category, label: CATEGORY_LABELS[category] })
                            )}
                            buttonRef={moveControlRef(question.id, 'category')}
                            onChoose={(category) =>
                              move(planMove(questions, { id: question.id, category, beforeId: null }), question.id, 'category')
                            }
                          />
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}

              {dropTarget?.category === group.category && dropTarget.beforeId === null ? (
                <DropLine className="mt-2" />
              ) : null}

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
              </>
              )}
            </section>
            );
          })}
        </div>
      </SectionState>

      {/* Where a moved question landed, for anyone who cannot see the row jump. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>

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
