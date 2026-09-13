/**
 * KitBuilder.jsx — a finished kit, section by section, and editable.
 *
 * Decides: which sections a ready kit shows and in what order — the order the brief
 * lists them: company brief, role breakdown, question bank, flashcards, schedule,
 * coverage — and that ONE editor, and one regeneration at a time, serve all of them.
 *
 * Does NOT decide: what any section contains, how it renders its states, or how an edit
 * is saved. Each section owns its own `SectionState`; `useKitEditor` owns saving;
 * `useRegeneration` owns regenerating and undoing.
 *
 * ONE EDITOR FOR THE WHOLE KIT, NOT ONE PER SECTION. Every edit to a kit moves the same
 * revision. Two editors saving independently would each carry a revision the other is
 * about to invalidate, and the second save would come back 409 for no reason a person
 * caused. A single queue serialises every section's edits into one sequence of requests,
 * and a regeneration runs as that queue's exclusive operation for the same reason.
 *
 * A FAILED SAVE IS SAID OUT LOUD. The change is rolled back — the brief asks for exactly
 * that — and the toast says both what the server said and that the change was undone, so
 * text vanishing from a field is never a mystery.
 *
 * ONE DIALOG, ONE LIVE REGION, for every section's regeneration. The dialog reads the kit
 * as shown, so its list of what is kept includes an edit made a second ago; the region is
 * mounted for the life of the page, so what a regeneration did is actually announced.
 *
 * UNDO ASKS ONLY WHEN IT WOULD DISCARD SOMETHING. With nothing changed since the
 * regeneration, Undo acts at once, as an undo should. When something has — anywhere the
 * server's snapshot covers, which for questions is every category — the dialog names what
 * would go before anything is sent.
 *
 * FOCUS MOVES TO THE SECTION'S REGENERATE BUTTON before an undo starts. The Undo button
 * lives in the summary, and the summary disappears when the undo succeeds; moving focus
 * first means it never drops to the top of the page.
 */

import { useState } from 'react';

import ConfirmDialog from '../ui/ConfirmDialog.jsx';
import { useToast } from '../ui/ToastProvider.jsx';
import { useKitEditor } from '../hooks/useKitEditor.js';
import { useRegeneration } from '../hooks/useRegeneration.js';
import { describeRebase } from './editQueue.js';
import RegenerateDialog from './RegenerateDialog.jsx';
import { describeTarget } from './regeneration.js';
import BriefSection from './sections/BriefSection.jsx';
import CoverageSection from './sections/CoverageSection.jsx';
import FlashcardsSection from './sections/FlashcardsSection.jsx';
import QuestionsSection from './sections/QuestionsSection.jsx';
import RoleSection from './sections/RoleSection.jsx';
import ScheduleSection from './sections/ScheduleSection.jsx';

const UNDO_SCOPE = Object.freeze({
  questions:
    'Every question goes back to how it was before the regeneration — in every category, not only this one — so these changes made since are undone too:',
  company_brief: 'The brief goes back to how it was before the regeneration, so these changes made since are undone too:',
  schedule: 'The schedule goes back to how it was before the rebuild, so these changes made since are undone too:',
});

const LISTED = 12;

export default function KitBuilder({ kitId, kit: serverKit }) {
  const { show } = useToast();
  const editor = useKitEditor(kitId, serverKit, {
    onError: (error) => show(`${error.message} Your last change was undone.`, { tone: 'error' }),
    // Quiet on purpose: nothing the person did was lost, and there is nothing to do.
    onRebase: ({ dropped }) => show(describeRebase(dropped), { tone: 'info' }),
  });
  const regeneration = useRegeneration(kitId, editor, {
    onError: (error) => show(error.message, { tone: 'error' }),
  });
  const [asking, setAsking] = useState(null);
  const [undoAsking, setUndoAsking] = useState(null); // { target, changes }

  const kit = editor.kit;

  function performUndo(target) {
    const { action } = describeTarget(target);
    requestAnimationFrame(() => document.querySelector(`button[aria-label="${CSS.escape(action)}"]`)?.focus());
    regeneration.undo(target);
  }

  function requestUndo(target) {
    const changes = regeneration.changesSinceFor(target, kit);
    if (changes.length === 0) performUndo(target);
    else setUndoAsking({ target, changes });
  }

  const regenerate = { regeneration, onRegenerate: setAsking, onUndo: requestUndo };
  const undoTarget = undoAsking?.target ?? null;

  return (
    <div className="space-y-6">
      <BriefSection kit={kit} editor={editor} {...regenerate} />
      <RoleSection kit={kit} />
      <QuestionsSection kit={kit} editor={editor} {...regenerate} />
      <FlashcardsSection kit={kit} editor={editor} />
      <ScheduleSection kit={kit} {...regenerate} />
      <CoverageSection kit={kit} />

      <RegenerateDialog
        kit={kit}
        target={asking}
        onClose={() => setAsking(null)}
        onConfirm={() => {
          const target = asking;
          setAsking(null);
          if (target) regeneration.run(target);
        }}
      />

      <ConfirmDialog
        open={Boolean(undoAsking)}
        onClose={() => setUndoAsking(null)}
        onConfirm={() => {
          const target = undoTarget;
          setUndoAsking(null);
          if (target) performUndo(target);
        }}
        title={`Undo the ${undoTarget?.section === 'schedule' ? 'rebuild' : 'regeneration'} of ${
          undoTarget ? describeTarget(undoTarget).title : 'this section'
        }?`}
        description={UNDO_SCOPE[undoTarget?.section] ?? ''}
        confirmLabel={undoTarget?.section === 'schedule' ? 'Undo the rebuild' : 'Undo the regeneration'}
      >
        <ul className="space-y-0.5" data-undo-discards="">
          {(undoAsking?.changes ?? []).slice(0, LISTED).map((label) => (
            <li key={label} className="break-words font-mono">
              {label}
            </li>
          ))}
        </ul>
        {(undoAsking?.changes.length ?? 0) > LISTED ? (
          <p className="mt-1">and {undoAsking.changes.length - LISTED} more.</p>
        ) : null}
      </ConfirmDialog>

      <p role="status" className="sr-only">
        {regeneration.announcement}
      </p>
    </div>
  );
}
