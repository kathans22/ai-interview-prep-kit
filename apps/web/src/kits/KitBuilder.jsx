/**
 * KitBuilder.jsx — a finished kit, section by section.
 *
 * Decides: which sections a ready kit shows and in what order — the order the brief
 * lists them: company brief, role breakdown, question bank, flashcards, schedule,
 * coverage.
 *
 * Does NOT decide: what any section contains or how it renders its states. Each section
 * owns its own `SectionState`, so a section that is missing, empty or busy shows that
 * locally while the others keep rendering — which is the whole point of per-section
 * states rather than one spinner for the page.
 */

import BriefSection from './sections/BriefSection.jsx';
import CoverageSection from './sections/CoverageSection.jsx';
import FlashcardsSection from './sections/FlashcardsSection.jsx';
import QuestionsSection from './sections/QuestionsSection.jsx';
import RoleSection from './sections/RoleSection.jsx';
import ScheduleSection from './sections/ScheduleSection.jsx';

export default function KitBuilder({ kit }) {
  return (
    <div className="space-y-6">
      <BriefSection kit={kit} />
      <RoleSection kit={kit} />
      <QuestionsSection kit={kit} />
      <FlashcardsSection kit={kit} />
      <ScheduleSection kit={kit} />
      <CoverageSection kit={kit} />
    </div>
  );
}
