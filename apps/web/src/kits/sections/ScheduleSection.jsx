/**
 * ScheduleSection.jsx — the study plan, day by day.
 *
 * Decides: how days and their questions are laid out.
 *
 * Does NOT decide: which question goes on which day, or how long a day is. The allocator
 * decides both on the server and recomputes them whenever the question set changes, so
 * this section only ever shows the server's answer.
 */

import Card from '../../ui/Card.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import SectionState from '../../ui/SectionState.jsx';
import { deriveSectionState, describeSchedule, formatMinutes } from '../kitView.js';

export default function ScheduleSection({ kit }) {
  const schedule = kit?.schedule;
  const present = Boolean(schedule) && Array.isArray(schedule.days);
  const view = describeSchedule(schedule, kit?.questions);
  const state = deriveSectionState({ present, isEmpty: present && schedule.days.length === 0 });

  return (
    <Card title="Schedule" titleAs="h2">
      <SectionState
        status={state.status}
        error={state.error}
        isEmpty={state.isEmpty}
        loadingLabel="Rebuilding the schedule…"
        empty={<EmptyState title="No schedule" description="There are no days in this kit's schedule." />}
      >
        <p className="text-sm text-slate-600">
          {view.days.length} {view.days.length === 1 ? 'day' : 'days'} of {view.daysAvailable} available ·{' '}
          {formatMinutes(view.totalMinutes)} in total
        </p>

        <ol className="mt-3 space-y-3">
          {view.days.map((day) => (
            <li key={day.day} className="rounded-md border border-slate-200 p-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="text-sm font-semibold text-slate-900">Day {day.day}</h3>
                <span className="text-sm text-slate-600">{formatMinutes(day.minutes)}</span>
                {day.kindLabel ? <span className="text-xs text-slate-500">{day.kindLabel}</span> : null}
                {day.pinned ? (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                    Arranged by you
                  </span>
                ) : null}
              </div>
              {day.focus ? <p className="mt-0.5 break-words text-sm text-slate-700">{day.focus}</p> : null}

              {day.questions.length > 0 ? (
                <ol className="mt-2 list-inside list-decimal space-y-0.5 text-sm text-slate-800">
                  {day.questions.map(({ id, question }) => (
                    <li key={id} className="break-words">
                      {question ? (
                        <>
                          <span className="font-mono text-xs text-slate-500">{id}</span> {question.prompt}
                        </>
                      ) : (
                        <span className="text-red-800">A question ({id}) that is no longer in this kit</span>
                      )}
                    </li>
                  ))}
                </ol>
              ) : null}
            </li>
          ))}
        </ol>
      </SectionState>
    </Card>
  );
}
