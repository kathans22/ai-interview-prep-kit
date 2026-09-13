/**
 * CoverageSection.jsx — which requirements have no question, said plainly.
 *
 * Decides: how the coverage result is worded and laid out.
 *
 * Does NOT decide: coverage. It is exact set membership computed on the server — never
 * similarity, never a model's opinion — and this section only reports its result.
 *
 * A REAL GAP IS SHOWN, NOT HIDDEN. The brief says so outright, and it is the right call:
 * a candidate who does not know a must-have is uncovered will not prepare for it. So a
 * gap is a sentence naming the requirement, must-haves first, and the number of coverage
 * passes is stated alongside so the reader knows how hard the build tried to close it.
 */

import Card from '../../ui/Card.jsx';
import SectionState from '../../ui/SectionState.jsx';
import { KIND_LABELS, deriveSectionState, describeCoverage } from '../kitView.js';

export default function CoverageSection({ kit }) {
  const coverage = kit?.coverage;
  const present = Boolean(coverage) && typeof coverage === 'object';
  const view = describeCoverage(coverage, kit?.role?.requirements);
  // Coverage is never "empty": no gaps is a result, and it is the good one.
  const state = deriveSectionState({ present });

  return (
    <Card title="Coverage" titleAs="h2">
      <SectionState status={state.status} error={state.error}>
        <p
          className={
            view.gaps.length === 0
              ? 'text-sm font-medium text-green-800'
              : view.mustGaps > 0
                ? 'text-sm font-medium text-red-800'
                : 'text-sm font-medium text-amber-800'
          }
        >
          {view.summary}
        </p>
        <p className="mt-1 text-sm text-slate-600">{view.passesText}</p>

        {view.gaps.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {view.gaps.map((gap) => (
              <li key={gap.id} className="break-words text-sm text-slate-800">
                <span className="me-2 font-mono text-xs text-slate-500">{gap.id}</span>
                {gap.sentence}
                {gap.kind ? <span className="ms-2 text-xs text-slate-500">{KIND_LABELS[gap.kind] ?? gap.kind}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </SectionState>
    </Card>
  );
}
