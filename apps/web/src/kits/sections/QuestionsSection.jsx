/**
 * QuestionsSection.jsx — the question bank, grouped by category.
 *
 * Decides: how questions are grouped and laid out, and that every category is shown —
 * including an empty one.
 *
 * Does NOT decide: which category a question belongs in or how hard it is. Those come
 * from generation and from the person editing, and `groupQuestions` only arranges them.
 *
 * THE ANSWER OUTLINE IS BEHIND A DISCLOSURE. Twenty-odd questions each with a paragraph
 * of outline is a wall at 360px; the prompts are what someone scans to decide what to
 * study, and the outline is one tap away. A native `<details>` is used because it is
 * keyboard-operable and announced correctly without any code of our own.
 */

import Card from '../../ui/Card.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import SectionState from '../../ui/SectionState.jsx';
import { DIFFICULTY_LABELS, deriveSectionState, groupQuestions, indexRequirements } from '../kitView.js';
import ProvenanceBadges from './ProvenanceBadges.jsx';

export default function QuestionsSection({ kit }) {
  const questions = kit?.questions;
  const present = Array.isArray(questions);
  const groups = groupQuestions(questions);
  const requirements = indexRequirements(kit?.role?.requirements);
  const state = deriveSectionState({ present, isEmpty: present && questions.length === 0 });

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

                      <p className="mt-1 whitespace-pre-line break-words text-sm font-medium text-slate-900">
                        {question.prompt}
                      </p>

                      {(question.requirement_ids ?? []).length > 0 ? (
                        <p className="mt-1 break-words text-xs text-slate-500">
                          For:{' '}
                          {question.requirement_ids
                            .map((id) => requirements.get(id)?.text ?? id)
                            .join(' · ')}
                        </p>
                      ) : null}

                      {question.answer_outline ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-sm text-slate-700">What a strong answer covers</summary>
                          <p className="mt-1 whitespace-pre-line break-words text-sm text-slate-700">
                            {question.answer_outline}
                          </p>
                        </details>
                      ) : null}
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
