/**
 * KitPage.jsx — one kit: its build, and then the kit itself.
 *
 * Decides: which of three things this screen shows — a build in progress, a failure, or a
 * finished kit laid out section by section — and nothing about their contents.
 *
 * Does NOT decide: what a step means (`steps.js`), how progress arrives (`useProgress`),
 * or how a section renders (`KitBuilder` and its sections, each with its own
 * `SectionState`).
 *
 * A BUILD IS NOT A SPINNER. It takes minutes and up to twelve model calls, and parts of
 * it can degrade or be skipped while the rest succeeds. While it runs, the step list is
 * the screen. Once it is done, the KIT is the screen — and the build's history moves into
 * a disclosure rather than disappearing, because "what did it skip, and why" is still a
 * question someone reading the kit will ask.
 *
 * TWO KINDS OF FAILURE, KEPT APART. A failed REQUEST (the kit could not be read) is not
 * a failed BUILD (the kit exists and could not be produced). The first is `SectionState`
 * around the fetch; the second is the kit's own recorded error. Showing one as the other
 * would tell someone to retry a request that worked fine.
 *
 * THE PAGE-LEVEL STATE ANSWERS ONE QUESTION: what is this kit? Until the kit's status is
 * known the page cannot tell a build from a finished kit, so that single question gets a
 * single loading state. Everything after it is per section.
 */

import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';

import Button, { buttonClasses } from '../ui/Button.jsx';
import Card from '../ui/Card.jsx';
import SectionState from '../ui/SectionState.jsx';
import { useToast } from '../ui/ToastProvider.jsx';
import { useKit, useResumeKit } from '../hooks/useKits.js';
import { STREAM_STATES, describeConnection, useProgress } from '../hooks/useProgress.js';
import BuildNotes from '../kits/BuildNotes.jsx';
import KitBuilder from '../kits/KitBuilder.jsx';
import ProgressSteps from '../kits/ProgressSteps.jsx';
import { describeKit, describeResume } from '../kits/kitStatus.js';
import { deriveSteps, summarise } from '../kits/steps.js';

const FINISHED = new Set(['ready', 'failed']);

export default function KitPage() {
  const { id } = useParams();
  const { kit, status, progress, buildError, input, hasCheckpoint, requestStatus, error, reload } = useKit(id);

  // The stream runs alongside the fetch. Whichever lands first does not discard the
  // other — the hook merges by entry identity.
  const stream = useProgress(id, {
    initial: progress,
    initialStatus: status,
    enabled: Boolean(id) && !FINISHED.has(status),
  });

  // THE STREAM NEVER SAYS WHAT THE KIT BECAME. The server sends `state` exactly once,
  // when the connection opens; afterwards it forwards progress and then closes. So the
  // close is the only "this build is over" signal, and it carries no status — without
  // re-reading the kit, a finished build would sit on screen with every row resolved and
  // the page still claiming to be working. Once per kit, guarded, because a reload that
  // triggered its own reload would poll the API forever.
  const refreshed = useRef(null);
  useEffect(() => {
    if (stream.connection !== STREAM_STATES.closed) return;
    if (refreshed.current === id) return;
    refreshed.current = id;
    reload().catch(() => {});
  }, [stream.connection, id, reload]);

  // WHICH STATUS IS AUTHORITATIVE DEPENDS ON WHETHER THE BUILD IS OVER. The stream's
  // status comes from a single `state` frame sent when the connection opens, so it is
  // fresher than the snapshot early on — and permanently stale afterwards. Once the kit
  // record itself reports a terminal status, that record wins; before then the stream
  // does.
  const liveStatus = FINISHED.has(status) ? status : (stream.status ?? status);
  const steps = deriveSteps(stream.progress);
  const connectionNotice = describeConnection(stream.connection);
  const described = describeKit({ status: liveStatus, error: buildError });

  const { resume, isLoading: resuming } = useResumeKit();
  const { show } = useToast();

  async function handleResume({ fresh = false } = {}) {
    const response = await resume(id, { fresh }).catch((thrown) => {
      show(thrown.message, { tone: 'error' });
      return null;
    });
    if (!response) return;

    show(describeResume(response), { tone: 'info' });
    // The kit is queued again, so this page must forget that it already refreshed for
    // the previous run — otherwise the new build's completion would never be picked up.
    refreshed.current = null;
    reload().catch(() => {});
  }

  const ready = liveStatus === 'ready' && Boolean(kit);

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
        {ready && kit.role?.title ? kit.role.title : 'Kit'}
      </h1>
      {input?.company_url ? (
        <p className="mt-1 truncate text-sm text-slate-600">{input.company_url}</p>
      ) : (
        <p className="mt-1 text-sm text-slate-600">Built from the posting alone — no company site was given.</p>
      )}

      <SectionState
        status={requestStatus}
        error={error}
        onRetry={reload}
        loadingLabel="Loading this kit…"
        // Once the kit has been read once, a re-read must not replace what is on screen
        // with a spinner — the user is reading or editing it.
        hasContent={Boolean(status)}
      >
        <div className="mt-6 space-y-6">
          {/* How progress is arriving, but only when that is not the happy path. Not a
              live region — the step list is the one on this screen. */}
          {connectionNotice && !FINISHED.has(liveStatus) ? (
            <p
              className={
                connectionNotice.tone === 'warn'
                  ? 'rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900'
                  : 'rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700'
              }
            >
              {connectionNotice.text}
            </p>
          ) : null}

          {ready ? (
            <>
              <KitBuilder kit={kit} />

              {/* The build's history, kept rather than discarded: what it skipped and why
                  is still a question someone reading the finished kit will ask. */}
              <details className="rounded-lg border border-slate-200 bg-white">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-900">
                  How this kit was built — {summarise(steps, liveStatus)}
                </summary>
                <div className="space-y-5 border-t border-slate-200 px-4 py-4">
                  <BuildNotes kit={kit} />
                  <ProgressSteps steps={steps} busy={false} />
                </div>
              </details>
            </>
          ) : (
            <Card title={summarise(steps, liveStatus)} titleAs="h2">
              <ProgressSteps steps={steps} busy={!FINISHED.has(liveStatus)} />
            </Card>
          )}

          {/* The build's own failure, distinct from a request failure — and never a dead
              end. An interrupted build and a genuinely failed one get different words. */}
          {liveStatus === 'failed' ? (
            <Card title={described.view === 'interrupted' ? 'This build was interrupted' : 'This kit could not be built'} titleAs="h2">
              <p className="text-sm text-slate-700">{described.detail}</p>
              {buildError?.code ? <p className="mt-2 font-mono text-xs text-slate-500">{buildError.code}</p> : null}

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {/* Two genuinely different actions, offered only when there is a
                    checkpoint to choose between (D-151). */}
                {hasCheckpoint ? (
                  <>
                    <Button onClick={() => handleResume({ fresh: false })} disabled={resuming}>
                      {resuming ? 'Starting…' : 'Continue from the checkpoint'}
                    </Button>
                    <Button variant="secondary" onClick={() => handleResume({ fresh: true })} disabled={resuming}>
                      Start this kit over
                    </Button>
                  </>
                ) : (
                  <Button onClick={() => handleResume({ fresh: false })} disabled={resuming}>
                    {resuming ? 'Starting…' : described.primary.label}
                  </Button>
                )}

                <Link to="/kits/new" className={buttonClasses({ variant: 'ghost' })}>
                  Build a different posting
                </Link>
              </div>

              <p className="mt-3 text-xs text-slate-500">
                {hasCheckpoint
                  ? 'Continuing skips the steps that already finished, so it spends less of the daily model quota. Starting over discards that saved progress.'
                  : 'No checkpoint was saved for this kit, so this builds again from the start.'}
              </p>
            </Card>
          ) : null}
        </div>
      </SectionState>
    </section>
  );
}
