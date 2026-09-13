/**
 * QuestionsSection.jsx — the question bank, grouped by category, editable in place.
 *
 * Decides: how questions are grouped and laid out, that every category is shown —
 * including an empty one — and which parts of a question can be edited here.
 *
 * Does NOT decide: which category a question belongs in, how hard it is, or how an edit
 * is saved. Grouping is `groupQuestions`; saving is the editor passed in.
 *
 * THE ANSWER OUTLINE IS BEHIND A DISCLOSURE. Twenty-odd questions each with a paragraph
 * of outline is a wall at 360px; the prompts are what someone scans to decide what to
 * study, and the outline is one tap away. A native `<details>` is used because it is
 * keyboard-operable and announced correctly without any code of our own. It is shown
 * even when the outline is empty, so an empty one can be written.
 */

import Card from '../../ui/Card.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import SectionState from '../../ui/SectionState.jsx';
import EditableText from '../EditableText.jsx';
import { DIFFICULTY_LABELS, deriveSectionState, groupQuestions, indexRequirements } from '../kitView.js';
import ProvenanceBadges from './ProvenanceBadges.jsx';

/** The field operation for one question field, without its value. */
const fieldOp = (id, field) => ({ type: 'edit-question', id, field });

export default function QuestionsSection({ kit, editor }) {
  const questions = kit?.questions;
  const present = Array.isArray(questions);
  const groups = groupQuestions(questions);
  const requirements = indexRequirements(kit?.role?.requirements);
  const state = deriveSectionState({ present, isEmpty: present && questions.length === 0 });

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
    <Card title={`Question bank${present ? ` (${questions.length})` : ''}`} titleAs="h2">
      <SectionState
        status={state.status}
        error={state.error}
        isEmpty={state.isEmpty}
        empty={
          <EmptyState
            title="No questions yet"
            description="This kit has no questions. Add one by hand, or regenerate a category."
          />
        }
      >
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.category} aria-labelledby={`questions-${group.category}`}>
              <h3 id={`questions-${group.category}`} className="text-sm font-semibold text-slate-900">
                {group.label} <span className="font-normal text-slate-500">({group.questions.length})</span>
              </h3>

              {group.questions.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">No {group.label.toLowerCase()} questions yet.</p>
              ) : (
                <ol className="mt-2 space-y-2">
                  {group.questions.map((question) => (
                    <li key={question.id} className="rounded-md border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span className="font-mono">{question.id}</span>
                        <span>{DIFFICULTY_LABELS[question.difficulty] ?? `Difficulty ${question.difficulty}`}</span>
                        <ProvenanceBadges item={question} />
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
                  ))}
                </ol>
              )}
            </section>
          ))}
        </div>
      </SectionState>
    </Card>
  );
}
