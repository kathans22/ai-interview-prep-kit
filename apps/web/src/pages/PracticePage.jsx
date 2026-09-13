/**
 * PracticePage.jsx — practise a kit's flashcards.
 *
 * Decides: what this screen shows for a kit that is not ready, has no flashcards, or can
 * be practised — and that the way back to the kit is always one link away.
 *
 * Does NOT decide: how a card is stepped through (`FlashcardStepper`, `session.js`) or
 * how confidence is recorded. Ratings live beside the kit rather than inside it and take
 * no revision, so practising in one tab can never conflict with a regeneration finishing
 * in another.
 *
 * NO CARDS IS NOT A DEAD END. A kit can have no flashcards — the time governor may drop
 * them, or they were deleted — and the empty state says so and points to the kit, where
 * a card can be added by hand.
 *
 * HISTORY IS A NICETY, PRACTICE IS NOT. The practice log is read alongside the kit so a
 * card can say how it went last time; if that read fails, practising still works and the
 * cards simply say nothing about the past.
 *
 * A RATING THAT IS NOT SAVED IS SAID OUT LOUD, here, once, with the server's reason — and
 * the stepper marks the card so the person can choose again.
 */

import { Link, useParams } from 'react-router-dom';

import { buttonClasses } from '../ui/Button.jsx';
import Card from '../ui/Card.jsx';
import EmptyState from '../ui/EmptyState.jsx';
import SectionState from '../ui/SectionState.jsx';
import { useToast } from '../ui/ToastProvider.jsx';
import { useKit, usePracticeHistory, useRecordPractice } from '../hooks/useKits.js';
import FlashcardStepper from '../practice/FlashcardStepper.jsx';

export default function PracticePage() {
  const { id } = useParams();
  const { kit, status, requestStatus, error, reload } = useKit(id);
  const practiceHistory = usePracticeHistory(id);
  const { record } = useRecordPractice(id);
  const { show } = useToast();

  const kitHref = `/kits/${encodeURIComponent(id)}`;
  const ready = status === 'ready' && Boolean(kit);
  const cards = ready && Array.isArray(kit.flashcards) ? kit.flashcards : [];
  const history = new Map(practiceHistory.cards.map((summary) => [summary.id, summary]));

  const rateCard = (cardId, confidence) =>
    record({ cardId, confidence }).catch((thrown) => {
      show(`Your rating for ${cardId} was not saved. ${thrown.message}`, { tone: 'error' });
      throw thrown;
    });

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Practice</h1>
        <Link to={kitHref} className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
          Back to the kit
        </Link>
      </div>
      {ready && kit.role?.title ? <p className="mt-1 text-sm text-slate-600">{kit.role.title}</p> : null}

      <div className="mt-6">
        <SectionState
          status={requestStatus}
          error={error}
          onRetry={reload}
          loadingLabel="Loading the flashcards…"
          hasContent={Boolean(status)}
          isEmpty={ready && cards.length === 0}
          empty={
            <EmptyState
              title="No flashcards to practise"
              description="This kit has no flashcards — the build may have skipped them to stay inside its time budget, or they were deleted. You can add one by hand on the kit page."
              action={
                <Link to={kitHref} className={buttonClasses()}>
                  Go to the kit
                </Link>
              }
            />
          }
        >
          {ready ? (
            <FlashcardStepper
              key={id}
              cards={cards}
              requirements={kit.role?.requirements ?? []}
              history={history}
              onRate={rateCard}
            />
          ) : (
            <Card title="This kit is not ready to practise yet" titleAs="h2">
              <p className="text-sm text-slate-700">
                Its flashcards are written while the kit builds. Once the build finishes, they can be practised here.
              </p>
              <Link to={kitHref} className={buttonClasses({ variant: 'secondary', className: 'mt-4' })}>
                See the build
              </Link>
            </Card>
          )}
        </SectionState>
      </div>
    </section>
  );
}
