/**
 * KitPage.jsx — one kit: its build, and what came of it.
 *
 * Decides: which of the three things this screen shows — a build in progress, a finished
 * kit, or a failure — and nothing about their contents.
 *
 * Does NOT decide: what a step means (`steps.js`), how progress arrives
 * (`useProgress`), or what a kit looks like once it is ready. The kit's own content is a
 * later stage's; this screen currently confirms it exists and points at it.
 *
 * A BUILD IS NOT A SPINNER. It takes minutes and up to twelve model calls, and parts of
 * it can degrade or be skipped while the rest succeeds. A single spinner would throw all
 * of that away and leave the user unable to tell a slow crawl from a dead server — so
 * the step list is the primary content of this screen while a kit is building.
 *
 * TWO KINDS OF FAILURE, KEPT APART. A failed REQUEST (the kit could not be read) is not
 * a failed BUILD (the kit exists and could not be produced). The first is `SectionState`
 * around the fetch; the second is the kit's own recorded error. Showing one as the other
 * would tell someone to retry a request that worked fine.
 */

import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';

import Card from '../ui/Card.jsx';
import SectionState from '../ui/SectionState.jsx';
import { useKit } from '../hooks/useKits.js';
import { STREAM_STATES, useProgress } from '../hooks/useProgress.js';
import ProgressSteps from '../kits/ProgressSteps.jsx';
import { deriveSteps, summarise } from '../kits/steps.js';

const FINISHED = new Set(['ready', 'failed']);

export default function KitPage() {
  const { id } = useParams();
  const { status, progress, buildError, input, requestStatus, error, reload } = useKit(id);

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
  // does. Preferring the stream unconditionally leaves a finished build reading "12 of
  // 15 steps done" forever, with every row resolved above it.
  const liveStatus = FINISHED.has(status) ? status : (stream.status ?? status);
  const steps = deriveSteps(stream.progress);

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Kit</h1>
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
        // Once the kit has been read once, a re-read must not replace the step list
        // with a spinner — the user is watching it.
        hasContent={Boolean(status)}
      >
        <div className="mt-6 space-y-6">
          <Card title={summarise(steps, liveStatus)} titleAs="h2">
            <ProgressSteps steps={steps} busy={!FINISHED.has(liveStatus)} />
          </Card>

          {/* The build's own failure, distinct from a request failure. The actions that
              belong beside it arrive with the kit list unit. */}
          {liveStatus === 'failed' && buildError ? (
            <Card title="This kit could not be built" titleAs="h2">
              <p className="text-sm text-slate-700">{buildError.message}</p>
              <p className="mt-2 font-mono text-xs text-slate-500">{buildError.code}</p>
            </Card>
          ) : null}

          {liveStatus === 'ready' ? (
            <Card title="The kit is ready" titleAs="h2">
              <p className="text-sm text-slate-700">
                Requirements, questions, flashcards and a day-by-day schedule were produced. Any step above
                marked partial or skipped is explained on its own row — the kit is complete, with those gaps
                recorded rather than hidden.
              </p>
            </Card>
          ) : null}
        </div>
      </SectionState>
    </section>
  );
}
