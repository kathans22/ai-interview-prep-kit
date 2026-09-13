/**
 * PracticePage.jsx — practise a kit's flashcards, one session after another.
 *
 * Decides: what this screen shows for a kit that is not ready, has no flashcards, or can
 * be practised; that a session walks the cards in the server's order, fixed when the
 * session starts; and that finishing a session shows its summary, from which the next
 * session starts.
 *
 * Does NOT decide: the order itself (`orderCards` in core, served with the practice
 * history), how a card is stepped through (`FlashcardStepper`, `session.js`), or what a
 * summary counts (`summary.js`). Ratings live beside the kit rather than inside it and
 * take no revision, so practising in one tab can never conflict with a regeneration
 * finishing in another.
 *
 * THE ORDER IS READ ONCE PER SESSION. The practice history is re-read as ratings are
 * made, and a deck that re-sorted itself mid-session would move the card the person is
 * looking at. So the order is taken when a session starts — the first read, or the fresh
 * read that "Start a new session" makes, which is what brings this session's "again" cards
 * back to the front.
 *
 * IF THE ORDER CANNOT BE READ, PRACTICE STILL WORKS, in the kit's own order, and the page
 * says so. The order is an improvement on practising, not a precondition for it.
 *
 * NO CARDS IS NOT A DEAD END. A kit can have no flashcards — the time governor may drop
 * them, or they were deleted — and the empty state says so and points to the kit, where
 * a card can be added by hand.
 *
 * A RATING THAT IS NOT SAVED IS SAID OUT LOUD, here, once, with the server's reason — and
 * the stepper marks the card so the person can choose again.
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { buttonClasses } from '../ui/Button.jsx';
import Card from '../ui/Card.jsx';
import EmptyState from '../ui/EmptyState.jsx';
import SectionState from '../ui/SectionState.jsx';
import Spinner from '../ui/Spinner.jsx';
import { useToast } from '../ui/ToastProvider.jsx';
import { ASYNC_STATES } from '../hooks/useAsync.js';
import { useKit, usePracticeHistory, useRecordPractice } from '../hooks/useKits.js';
import FlashcardStepper from '../practice/FlashcardStepper.jsx';
import SessionSummary from '../practice/SessionSummary.jsx';
import { describeWeakSpots } from '../practice/weakSpots.js';
import { summariseSession } from '../practice/summary.js';

/** The cards in `order` first, then any the order did not mention, in the kit's order. */
function arrange(cards, order) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const first = (order ?? []).map((id) => byId.get(id)).filter(Boolean);
  const named = new Set(first.map((card) => card.id));
  return [...first, ...cards.filter((card) => !named.has(card.id))];
}

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
  const weakSpots = describeWeakSpots(practiceHistory.weakRequirements, kit?.role?.requirements ?? [], cards);

  // One session at a time: its round (which remounts the stepper), its order, and — once
  // finished — its summary.
  const [round, setRound] = useState(0);
  const [order, setOrder] = useState(null);
  const [orderUnavailable, setOrderUnavailable] = useState(false);
  const [finished, setFinished] = useState(null);
  const [starting, setStarting] = useState(false);

  // The first session's order, as soon as the first read of the history settles either way.
  useEffect(() => {
    if (order !== null) return;
    if (practiceHistory.status === ASYNC_STATES.ready) setOrder(practiceHistory.deck.map((card) => card.id));
    if (practiceHistory.status === ASYNC_STATES.error) {
      setOrderUnavailable(true);
      setOrder([]);
    }
  }, [order, practiceHistory.status, practiceHistory.deck]);

  const rateCard = (cardId, confidence) =>
    record({ cardId, confidence }).catch((thrown) => {
      show(`Your rating for ${cardId} was not saved. ${thrown.message}`, { tone: 'error' });
      throw thrown;
    });

  async function startNewSession() {
    setStarting(true);
    try {
      const fresh = await practiceHistory.reload();
      setOrder((fresh?.deck ?? []).map((card) => card.id));
      setOrderUnavailable(false);
    } catch (thrown) {
      show(`Could not read your latest ratings, so this session keeps the kit's order. ${thrown.message}`, { tone: 'error' });
      setOrder([]);
      setOrderUnavailable(true);
    } finally {
      setStarting(false);
      setFinished(null);
      setRound((current) => current + 1);
    }
  }

  const sessionCards = arrange(cards, order);

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Practice</h1>
        <Link to={kitHref} className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
          Back to the kit
        </Link>
      </div>
      {ready && kit.role?.title ? <p className="mt-1 text-sm text-slate-600">{kit.role.title}</p> : null}

      {ready && weakSpots.length > 0 ? (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-weak-spots="">
          <p className="font-medium">Weak spots from your scored answers</p>
          <p className="mt-0.5">
            Cards covering {weakSpots.map((spot) => spot.text).join(' · ')} are pulled forward in this deck,
            because a scored answer missed them.
            {weakSpots.some((spot) => !spot.hasCard)
              ? ' A weak spot with no card cannot be practised — add one on the kit page.'
              : ''}
          </p>
        </div>
      ) : null}

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
          {!ready ? (
            <Card title="This kit is not ready to practise yet" titleAs="h2">
              <p className="text-sm text-slate-700">
                Its flashcards are written while the kit builds. Once the build finishes, they can be practised here.
              </p>
              <Link to={kitHref} className={buttonClasses({ variant: 'secondary', className: 'mt-4' })}>
                See the build
              </Link>
            </Card>
          ) : finished ? (
            <SessionSummary
              summary={summariseSession({ session: finished, cards: sessionCards, requirements: kit.role?.requirements ?? [] })}
              kitHref={kitHref}
              onStartNew={startNewSession}
              starting={starting}
            />
          ) : order === null ? (
            <div className="py-8">
              <Spinner label="Ordering your cards…" />
            </div>
          ) : (
            <>
              {orderUnavailable ? (
                <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  Your practice history could not be read, so the cards are in the kit's own order this session.
                </p>
              ) : null}
              <FlashcardStepper
                key={`${id}:${round}`}
                cards={sessionCards}
                requirements={kit.role?.requirements ?? []}
                history={history}
                onRate={rateCard}
                onFinish={setFinished}
                autoFocus={round > 0}
              />
            </>
          )}
        </SectionState>
      </div>
    </section>
  );
}
