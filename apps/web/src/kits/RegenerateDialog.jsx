/**
 * RegenerateDialog.jsx — before a regeneration runs, what it will replace and keep.
 *
 * Decides: that nothing is regenerated without first saying, item by item, what will be
 * kept and why, and how many will be replaced.
 *
 * Does NOT decide: the rule (`willBeReplaced`, a tested mirror of core's), or whether the
 * regeneration succeeds.
 *
 * WHY ASK AT ALL. A regeneration spends quota and overwrites generated content. The
 * person pressing it may not remember which of twenty questions they edited last week;
 * the list of what is kept is the reassurance that makes pressing it safe, and the count
 * of what is replaced is the cost.
 */

import ConfirmDialog from '../ui/ConfirmDialog.jsx';
import { describeTarget, previewRegeneration } from './regeneration.js';

const NOTHING_REPLACED = Object.freeze({
  questions: 'Nothing will be replaced — every question here is edited, added by you or pinned. New questions may still be added.',
  company_brief: 'Nothing will be rewritten — both fields are yours.',
  schedule: 'Every day was arranged by you, so the rebuild keeps them all.',
});

const NOTHING_KEPT = Object.freeze({
  questions: 'None — no question here has been edited, added by you or pinned.',
  company_brief: 'None — neither field has been edited.',
  schedule: 'None — no day has been arranged by hand.',
});

export default function RegenerateDialog({ kit, target, onClose, onConfirm }) {
  const open = Boolean(target);
  const section = target?.section;
  const isSchedule = section === 'schedule';
  const { title, action } = describeTarget(target);
  const preview = open ? previewRegeneration(kit, target) : { replaced: [], kept: [] };

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      variant="primary"
      title={`${isSchedule ? 'Rebuild' : 'Regenerate'} ${title}?`}
      description={
        isSchedule
          ? 'The days are recomputed from the questions you have now. No model calls are made.'
          : 'This asks the model again, which uses part of today’s generation quota.'
      }
      confirmLabel={action}
    >
      <div className="space-y-3">
        <section>
          <h3 className="font-medium text-slate-900">
            {isSchedule ? 'Will be rebuilt' : 'Will be replaced'} ({preview.replaced.length})
          </h3>
          <p className="mt-1 break-words">
            {preview.replaced.length === 0
              ? NOTHING_REPLACED[section]
              : preview.replaced.map((entry) => entry.label).join(', ')}
          </p>
        </section>

        <section>
          <h3 className="font-medium text-slate-900">Will be kept ({preview.kept.length})</h3>
          {preview.kept.length === 0 ? (
            <p className="mt-1">{NOTHING_KEPT[section]}</p>
          ) : (
            <ul className="mt-1 space-y-0.5" data-regeneration-kept="">
              {preview.kept.map((entry) => (
                <li key={entry.id} className="break-words">
                  <span className="font-mono">{entry.label}</span> — {entry.because.join(', ')}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </ConfirmDialog>
  );
}
