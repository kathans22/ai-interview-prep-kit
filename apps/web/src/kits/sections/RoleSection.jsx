/**
 * RoleSection.jsx — the role, broken into what it asks for.
 *
 * Decides: how the role's title, responsibilities and requirements are laid out, and
 * that each requirement shows the line of the posting it was taken from.
 *
 * Does NOT decide: what counts as a requirement or its priority. Extraction decides that
 * on the server, and `verifyEvidence` drops any requirement whose evidence is not
 * literally in the posting — so the quoted line shown here is proof, not decoration.
 */

import Card from '../../ui/Card.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import SectionState from '../../ui/SectionState.jsx';
import { KIND_LABELS, PRIORITY_LABELS, deriveSectionState } from '../kitView.js';

export default function RoleSection({ kit }) {
  const role = kit?.role;
  const present = Boolean(role) && typeof role === 'object';
  const requirements = Array.isArray(role?.requirements) ? role.requirements : [];
  const responsibilities = Array.isArray(role?.responsibilities) ? role.responsibilities : [];
  const state = deriveSectionState({ present, isEmpty: present && requirements.length === 0 });

  return (
    <Card title="Role breakdown" titleAs="h2">
      <SectionState
        status={state.status}
        error={state.error}
        isEmpty={state.isEmpty}
        empty={
          <EmptyState
            title="No requirements were extracted"
            description="Nothing in the posting read as a requirement, so there is nothing to build questions around."
          />
        }
      >
        <div className="space-y-1">
          <p className="break-words text-base font-medium text-slate-900">{role?.title || 'Untitled role'}</p>
          {role?.seniority ? <p className="text-sm capitalize text-slate-600">{role.seniority}</p> : null}
        </div>

        {responsibilities.length > 0 ? (
          <div className="mt-4">
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Responsibilities</h3>
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm text-slate-800">
              {responsibilities.map((item, index) => (
                // Responsibilities are plain strings with no ids; position is their identity.
                // eslint-disable-next-line react/no-array-index-key
                <li key={index} className="break-words">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Requirements ({requirements.length})
          </h3>
          <ul className="mt-2 space-y-3">
            {requirements.map((requirement) => (
              <li key={requirement.id} className="border-s-2 border-slate-200 ps-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono text-slate-500">{requirement.id}</span>
                  <span
                    className={
                      requirement.priority === 'must'
                        ? 'rounded bg-slate-900 px-1.5 py-0.5 font-medium text-white'
                        : 'rounded bg-slate-100 px-1.5 py-0.5 text-slate-700'
                    }
                  >
                    {PRIORITY_LABELS[requirement.priority] ?? requirement.priority}
                  </span>
                  <span className="text-slate-600">{KIND_LABELS[requirement.kind] ?? requirement.kind}</span>
                </div>
                <p className="mt-1 break-words text-sm text-slate-900">{requirement.text}</p>
                {requirement.evidence ? (
                  <p className="mt-0.5 break-words text-xs text-slate-500">
                    From the posting: <q>{requirement.evidence}</q>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </SectionState>
    </Card>
  );
}
