/**
 * batch.js — run the cases, two at a time, and never let one take the others down.
 *
 * Decides: how many cases are in flight, in what order results come back, and what
 * happens when a case fails or the harness itself does.
 *
 * Does NOT decide: what a case does (runCase.js), or where the results go (unit 4).
 *
 * WHY CONCURRENCY 2, AND WHY IT IS NOT A TUNING KNOB UPWARD. Block C fixes it. The
 * limiter is shared, so more cases in flight do not produce more requests per minute —
 * they produce the same requests with more of them queued, plus more sockets, more
 * memory, and a worse failure story. Two is enough to keep the pipeline busy while one
 * case waits on the network, which is the only thing concurrency buys here.
 *
 * ORDER IS PRESERVED REGARDLESS OF COMPLETION ORDER. Results are written into a slot
 * indexed by the case's position, never appended as they finish. The envelope must list
 * entries in the order the input gave them: a grader diffing two runs of the same file
 * should see the same file, and with append-on-completion the order would shuffle
 * according to which company's website was slow that afternoon.
 *
 * ONE CASE FAILING IS DATA, NOT AN OUTCOME. `runCase` already converts a failed build
 * into a `failed` entry, so the normal path never throws. This file adds the second
 * layer: if the harness itself throws — a bug here, an out-of-memory, a dependency
 * misbehaving — that case becomes a failed entry too and the run continues. Losing four
 * good kits because the fifth hit an unhandled path is the single most expensive failure
 * available, because every automated point is read from the file that would not be
 * written.
 *
 * THE RUN HAS NO GLOBAL DEADLINE, DELIBERATELY. Each case carries its own governor. A
 * run-wide timer that cancelled work in flight would throw away calls already paid for
 * out of a twenty-a-day quota — the tokens are spent when the request is sent, not when
 * the answer is read.
 */

import { runCase } from './runCase.js';

/** Block C fixes this. See the header before changing it. */
export const DEFAULT_CONCURRENCY = 2;

/**
 * Run every case, at most `concurrency` at a time.
 *
 * @param {object} options
 * @param {object[]} options.cases validated cases, in input order
 * @param {object} options.context from `createRunContext`
 * @param {number} [options.concurrency]
 * @param {(event: object) => void} [options.onCaseStart]
 * @param {(entry: object) => void} [options.onCaseEnd]
 * @param {(event: object) => void} [options.onProgress] per-step, carrying the case id —
 *   without the id two interleaved cases produce one unreadable stream
 * @param {Function} [options.run] injected for tests; defaults to the real `runCase`
 * @returns {Promise<{entries: object[], elapsedMs: number, ok: number, failed: number}>}
 */
export async function runBatch({
  cases,
  context,
  concurrency = DEFAULT_CONCURRENCY,
  onCaseStart = () => {},
  onCaseEnd = () => {},
  onProgress = () => {},
  run = runCase,
} = {}) {
  const startedAt = Date.now();

  // Indexed slots, not a growing array — see "ORDER IS PRESERVED" above.
  const entries = new Array(cases.length);

  // A shared cursor rather than pre-sliced chunks. Chunking by index would leave one
  // worker holding four slow cases while the other finished early and idled; pulling
  // from a queue keeps both busy until there is genuinely nothing left.
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= cases.length) return;

      const kase = cases[index];
      onCaseStart({ index, total: cases.length, case: kase });

      let entry;
      try {
        // eslint-disable-next-line no-await-in-loop
        entry = await run(kase, context, {
          onProgress: (step, status, detail) => onProgress({ id: kase.id, step, status, detail }),
        });
      } catch (error) {
        // runCase is written not to throw, so arriving here means a fault in our own
        // harness rather than in the build. It still must not end the run — but it is
        // recorded as an unexpected fault rather than disguised as an ordinary failure,
        // because the two need different responses from whoever reads the output.
        entry = {
          id: kase.id,
          status: 'failed',
          kit: null,
          error: {
            code: 'BUILD_FAILED',
            message: `The case runner threw, which it is written not to do: ${
              error?.message ?? error
            }`,
          },
          meta: { elapsedMs: 0, notes: ['harness fault'], budget: null, governor: null },
        };
      }

      entries[index] = entry;
      onCaseEnd(entry);
    }
  }

  // `concurrency` workers, never more than there are cases — spawning five workers for
  // two cases is three promises that resolve immediately and a misleading log line.
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, cases.length)) }, worker);
  await Promise.all(workers);

  const ok = entries.filter((entry) => entry.status === 'ok').length;

  return {
    entries,
    elapsedMs: Date.now() - startedAt,
    ok,
    failed: entries.length - ok,
  };
}
