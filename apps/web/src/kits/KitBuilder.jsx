/**
 * KitBuilder.jsx — a finished kit, section by section, and editable.
 *
 * Decides: which sections a ready kit shows and in what order — the order the brief
 * lists them: company brief, role breakdown, question bank, flashcards, schedule,
 * coverage — and that ONE editor, and one regeneration at a time, serve all of them.
 *
 * Does NOT decide: what any section contains, how it renders its states, or how an edit
 * is saved. Each section owns its own `SectionState`; `useKitEditor` owns saving;
 * `useRegeneration` owns regenerating.
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
 */

import { useState } from 'react';

import { useToast } from '../ui/ToastProvider.jsx';
import { useKitEditor } from '../hooks/useKitEditor.js';
import { useRegeneration } from '../hooks/useRegeneration.js';
import RegenerateDialog from './RegenerateDialog.jsx';
import BriefSection from './sections/BriefSection.jsx';
import CoverageSection from './sections/CoverageSection.jsx';
import FlashcardsSection from './sections/FlashcardsSection.jsx';
import QuestionsSection from './sections/QuestionsSection.jsx';
import RoleSection from './sections/RoleSection.jsx';
import ScheduleSection from './sections/ScheduleSection.jsx';

export default function KitBuilder({ kitId, kit: serverKit }) {
  const { show } = useToast();
  const editor = useKitEditor(kitId, serverKit, {
    onError: (error) => show(`${error.message} Your last change was undone.`, { tone: 'error' }),
  });
  const regeneration = useRegeneration(kitId, editor, {
    onError: (error) => show(error.message, { tone: 'error' }),
  });
  const [asking, setAsking] = useState(null);

  const kit = editor.kit;
  const regenerate = { regeneration, onRegenerate: setAsking };

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

      <p role="status" className="sr-only">
        {regeneration.announcement}
      </p>
    </div>
  );
}
