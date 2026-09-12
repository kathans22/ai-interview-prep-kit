/**
 * KitsPage.jsx — every kit this account has, newest first.
 *
 * Decides: how a kit reads as a row, and what each row offers next.
 *
 * Does NOT decide: what state a kit is in (`kitStatus.js`) or what the server will do
 * about it. Ordering is the server's too — `GET /api/kits` returns newest first, and
 * re-sorting here would be a second opinion about the same question.
 *
 * FAILURES ARE ROWS. The listing deliberately shows failed and interrupted kits rather
 * than hiding them behind a filter: a user looking for the kit they started an hour ago
 * needs to find out that it stopped, and from where. A list that showed only the healthy
 * ones would answer "where did my kit go?" with silence.
 *
 * EVERY ROW HAS ONE OBVIOUS NEXT THING. Ready opens, building watches, interrupted and
 * failed continue. A row with a red badge and nothing to press is a dead end that leaves
 * the reader to work out whether anything can be done.
 *
 * THE EMPTY STATE EXPLAINS RATHER THAN DECORATES. A new account has no kits, which is
 * not a problem to report — it is the moment to say what this thing does and where to
 * start. It is also indistinguishable from a failed load unless it says so, which is why
 * `SectionState` checks error before empty.
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import Button, { buttonClasses } from '../ui/Button.jsx';
import Card from '../ui/Card.jsx';
import ConfirmDialog from '../ui/ConfirmDialog.jsx';
import EmptyState from '../ui/EmptyState.jsx';
import SectionState from '../ui/SectionState.jsx';
import { useToast } from '../ui/ToastProvider.jsx';
import { useDeleteKit, useKitList, useResumeKit } from '../hooks/useKits.js';
import { describeKit, describeResume } from '../kits/kitStatus.js';

const TONES = Object.freeze({
  ok: 'bg-green-100 text-green-900',
  busy: 'bg-slate-100 text-slate-700',
  warn: 'bg-amber-100 text-amber-900',
  bad: 'bg-red-100 text-red-900',
});

export default function KitsPage() {
  const { kits, status, error, reload, isLoading } = useKitList();
  const { resume, isLoading: resuming } = useResumeKit();
  const { remove, isLoading: deleting } = useDeleteKit();
  const { show } = useToast();
  const navigate = useNavigate();

  /** The kit a confirmation is open for, or null. Deleting is not undoable. */
  const [pendingDelete, setPendingDelete] = useState(null);

  async function handleResume(id) {
    const response = await resume(id).catch((thrown) => {
      show(thrown.message, { tone: 'error' });
      return null;
    });
    if (!response) return;

    // What actually happened, because resuming from a checkpoint and rebuilding from
    // scratch cost very different amounts of a small daily quota.
    show(describeResume(response), { tone: 'info' });
    navigate(`/kits/${encodeURIComponent(id)}`);
  }

  async function handleDelete() {
    const id = pendingDelete?.id;
    if (!id) return;

    const done = await remove(id).catch((thrown) => {
      show(thrown.message, { tone: 'error' });
      return null;
    });

    // The dialog stays open on failure so the error and the thing it refers to are in
    // the same place.
    if (!done) return;
    setPendingDelete(null);
    show('Kit deleted.', { tone: 'success' });
    reload().catch(() => {});
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Your kits</h1>
        <Link to="/kits/new" className={buttonClasses({ size: 'sm' })}>
          New kit
        </Link>
      </div>

      <div className="mt-6">
        <SectionState
          status={status}
          error={error}
          onRetry={reload}
          loadingLabel="Loading your kits…"
          isEmpty={kits.length === 0}
          hasContent={kits.length > 0}
          empty={
            <EmptyState
              title="No kits yet"
              description="Paste a job description and the company's website, and this builds you researched requirements, questions tied to them, flashcards and a day-by-day schedule. One posting takes a few minutes."
              action={
                <Link to="/kits/new" className={buttonClasses()}>
                  Build your first kit
                </Link>
              }
            />
          }
        >
          <ul className="space-y-3">
            {kits.map((kit) => {
              const described = describeKit(kit);

              return (
                <li key={kit.id}>
                  <Card>
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          {/* The state as a word in a badge, and the badge colour is
                              decoration on top of the word rather than instead of it. */}
                          <span
                            className={`rounded px-1.5 py-0.5 text-xs font-medium ${TONES[described.tone] ?? TONES.busy}`}
                          >
                            {described.label}
                          </span>
                          <span className="truncate text-sm font-medium text-slate-900">
                            {kit.company_url || 'No company site given'}
                          </span>
                        </div>

                        <p className="mt-1 text-xs text-slate-500">
                          {kit.days ? `${kit.days} day${kit.days === 1 ? '' : 's'} to prepare` : 'Schedule length not set'}
                          {kit.questionCount > 0 ? ` · ${kit.questionCount} questions` : ''}
                          {kit.jdChars ? ` · ${kit.jdChars.toLocaleString()} characters of description` : ''}
                        </p>

                        {described.detail ? (
                          <p className="mt-2 max-w-prose text-sm text-slate-700">{described.detail}</p>
                        ) : null}
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {described.primary.kind === 'resume' ? (
                          <Button size="sm" onClick={() => handleResume(kit.id)} disabled={resuming}>
                            {resuming ? 'Starting…' : described.primary.label}
                          </Button>
                        ) : (
                          <Link to={`/kits/${encodeURIComponent(kit.id)}`} className={buttonClasses({ size: 'sm' })}>
                            {described.primary.label}
                          </Link>
                        )}

                        {/* A failed kit can also be abandoned. Offered here rather than
                            only on the detail page, because that is where someone
                            clearing up will be. */}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setPendingDelete(kit)}
                          aria-label={`Delete the kit for ${kit.company_url || 'an unnamed company'}`}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>

          {isLoading ? <p className="mt-3 text-xs text-slate-500">Refreshing…</p> : null}
        </SectionState>
      </div>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={handleDelete}
        pending={deleting}
        title="Delete this kit?"
        description="The kit, its progress and its practice history go with it. This cannot be undone."
        confirmLabel="Delete the kit"
      >
        <p>
          {pendingDelete?.company_url
            ? `The kit for ${pendingDelete.company_url}.`
            : 'A kit built from a posting with no company site.'}
        </p>
      </ConfirmDialog>
    </section>
  );
}
