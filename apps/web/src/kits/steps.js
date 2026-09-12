/**
 * steps.js — the build's steps as a reader sees them.
 *
 * Decides: the order steps are listed in, their English names, the four states a row can
 * be in, and the sentence shown when a step was skipped or degraded.
 *
 * Does NOT decide: what any step does, when it runs, or what it emits. The ids and the
 * reason codes here are copied from `packages/core/orchestrator/steps.js` and from the
 * retrieval and generation modules that produce them — read out of those files, not
 * invented. A code that arrives without a translation still reads as words, because the
 * fallback humanises it rather than printing it raw.
 *
 * FOURTEEN ROWS, NOT NINE. The brief names nine steps. The orchestrator emits fourteen,
 * and the five it does not name are exactly the ones whose absence would hide a
 * degradation: `hiring-process` is what makes crawling worth doing, `gap-fill` is the
 * second coverage pass, `flashcards` is one of only two things the time governor may
 * drop, and `assemble`/`validate` are where a kit is accepted or rejected. Showing all
 * fourteen is a superset of what was asked and makes "the flashcards were skipped to
 * stay inside the time budget" visible instead of silent.
 *
 * THE SERVER HAS NO "PENDING". Its statuses are `started`, `done`, `degraded`, `skipped`
 * and `failed`. `pending` is the absence of any event for a step, which is why this
 * module derives state from the whole progress log rather than reading a field.
 *
 * DEGRADED IS NOT FAILED. A step that ran and produced less than it might have is shown
 * as done, with a note saying what was lost. Rendering it as a failure would make an
 * honest partial result — the thing this pipeline is designed to produce — look like a
 * broken build.
 */

/** Every step, in the order the orchestrator sequences them. */
export const STEP_ORDER = Object.freeze([
  'requirements',
  'role-profile',
  'crawl',
  'hiring-page',
  'public-discussion',
  'company-brief',
  'hiring-process',
  'questions',
  'coverage',
  'gap-fill',
  'flashcards',
  'schedule',
  'assemble',
  'validate',
]);

/** What each step is called on screen. The brief's own wording where it gave any. */
export const STEP_LABELS = Object.freeze({
  requirements: 'Extracting requirements',
  'role-profile': 'Reading the role',
  crawl: 'Crawling the company site',
  'hiring-page': 'Finding the hiring page',
  'public-discussion': 'Searching public discussion',
  'company-brief': 'Writing the company brief',
  'hiring-process': 'Reading their interview process',
  questions: 'Generating questions',
  coverage: 'Coverage pass',
  'gap-fill': 'Filling coverage gaps',
  flashcards: 'Making flashcards',
  schedule: 'Building the schedule',
  assemble: 'Assembling the kit',
  validate: 'Checking the kit',
  // Pushed by the resume route rather than the orchestrator, so it is not in STEP_ORDER
  // and appears only when a kit was actually resumed.
  resume: 'Resuming',
});

/**
 * Emitted markers that are not steps, and are not rendered.
 *
 * The job runner wraps the whole build in its own `build` started/done/failed/closed
 * events. They are real and they are not steps: `build` duplicates the kit's own status,
 * adds a redundant "Build — Done" row beside the fourteen that mean something, and —
 * because it starts first and ends last — makes the summary line read "Build…" for the
 * entire run instead of naming the step actually running. Its failure code is already
 * shown, with the kit's recorded error, on its own card.
 *
 * `resume` is deliberately NOT hidden: it is the one marker that says this build is a
 * continuation rather than a fresh one, which changes what the user should expect it to
 * cost.
 */
const HIDDEN_STEPS = Object.freeze(new Set(['build']));

/** The four states a row can be in, as the brief names them. */
export const STEP_STATES = Object.freeze({
  pending: 'pending',
  running: 'running',
  done: 'done',
  skipped: 'skipped',
  failed: 'failed',
});

/**
 * Reason codes in plain words.
 *
 * Every key is a real code emitted by core — from `HIRING_PAGE_REASONS`,
 * `SEARCH_REASONS`, `summariseCompany`, `extractHiringProcess`, the checkpoint loader,
 * the time governor and the budget. The codes that mean SUCCESS map to `null`: there is
 * nothing to explain when a step simply worked, and printing
 * "GROUNDED_IN_RETRIEVED_PAGES" beside a green tick is noise.
 */
export const REASON_WORDS = Object.freeze({
  // --- skips -------------------------------------------------------------
  RESUMED_FROM_CHECKPOINT: 'Already finished before the interruption, so it was not run again.',
  TIME_GOVERNOR: 'Skipped to stay inside this kit’s time budget.',
  BUDGET_EXHAUSTED: 'Skipped — this kit had used up its allowance of model calls.',
  MAX_PASSES_REACHED: 'Stopped after the last coverage pass; further passes tend to repeat themselves.',

  // --- hiring page -------------------------------------------------------
  HIRING_PAGE_FOUND: null,
  NO_HIRING_PAGE_FOUND: 'No hiring page found on this site.',
  NO_HIRING_PAGE_CANDIDATES: 'Nothing on this site looked like a hiring or careers page.',
  HIRING_PAGE_ACCEPTED_WITHOUT_CONFIRMATION: 'A likely hiring page was used without confirming it first.',
  HIRING_PAGE_CONFIRMATION_UNAVAILABLE: 'Could not confirm which page describes their hiring.',

  // --- hiring process ----------------------------------------------------
  PROCESS_EXTRACTED: null,
  NO_HIRING_PAGE: 'There was no hiring page to read their process from.',
  PAGE_DESCRIBES_NO_PROCESS: 'Their hiring page does not describe an interview process.',

  // --- company brief -----------------------------------------------------
  GROUNDED_IN_RETRIEVED_PAGES: null,
  NO_PAGES_RETRIEVED: 'No company pages could be read, so no brief was written rather than one invented.',
  PAGES_TOO_THIN: 'The company pages had too little text to summarise.',
  MODEL_COULD_NOT_GROUND: 'Nothing on their site supported a summary, so none was written.',

  // --- public discussion -------------------------------------------------
  PUBLIC_DISCUSSION_FOUND: null,
  NO_PUBLIC_DISCUSSION_FOUND: 'Searched, and found no public discussion of their interviews.',
  SEARCH_PROVIDER_NOT_CONFIGURED: 'No search provider is set up, so the search is recorded as empty rather than skipped.',
  SEARCH_PROVIDER_FAILED: 'The search provider did not answer.',
  SEARCH_NOT_ATTEMPTED: 'The search was not attempted.',

  // --- checkpoints -------------------------------------------------------
  CHECKPOINT_RESTORED: null,
  CHECKPOINT_ABSENT: 'There was no saved checkpoint, so this built from the start.',
  CHECKPOINT_VERSION_MISMATCH: 'The saved checkpoint was from an older version and was not reused.',
  CHECKPOINT_INPUT_MISMATCH: 'The saved checkpoint belonged to a different posting and was not reused.',
});

/** Failure codes in plain words. Keys are the coded errors core raises. */
export const FAILURE_WORDS = Object.freeze({
  LLM_RATE_LIMITED: 'The model hit its rate limit.',
  LLM_UNAVAILABLE: 'The model was unavailable.',
  LLM_CONTENT_BLOCKED: 'The model declined to answer for this content.',
  LLM_INVALID_OUTPUT: 'The model’s answer could not be read.',
  LLM_REQUEST_FAILED: 'The request to the model failed.',
  LLM_NOT_CONFIGURED: 'No model is configured on the server.',
  GENERATION_INVALID_OUTPUT: 'The result did not have the expected shape.',
  GENERATION_BAD_INPUT: 'There was not enough to work from.',
  GENERATION_UNAVAILABLE: 'The generation service was unavailable.',
  BUDGET_EXHAUSTED: 'This kit had used up its allowance of model calls.',
  COMPANY_UNREACHABLE: 'The company site could not be reached.',
});

/**
 * Turn an untranslated code into something readable.
 *
 * The map above is built from the codes core emits today. A new one added later must not
 * surface as `SOME_NEW_CODE` — the brief is explicit that a reason is shown in plain
 * words, not as a code — so the fallback lower-cases it and drops the underscores. It
 * reads a little flat, and it reads.
 */
export function humaniseCode(code) {
  if (typeof code !== 'string' || code === '') return null;
  const words = code.toLowerCase().replace(/_/g, ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

/** The sentence for a progress entry, or null when there is nothing worth saying. */
export function describeEntry(entry) {
  const detail = entry?.detail ?? {};

  if (typeof detail.reason === 'string') {
    // A mapped success reason is deliberately null — nothing to explain.
    if (detail.reason in REASON_WORDS) return REASON_WORDS[detail.reason];
    return humaniseCode(detail.reason);
  }

  if (typeof detail.code === 'string') {
    if (detail.code in FAILURE_WORDS) return FAILURE_WORDS[detail.code];
    return humaniseCode(detail.code);
  }

  return null;
}

/**
 * Statuses that end a step, and the order they beat each other in.
 *
 * `started` is the only non-terminal status, and it must never be a step's final word
 * once a terminal entry for that step exists. That is not hypothetical: the server
 * replays its whole persisted log on every connection, so a replayed `started` frame can
 * reach the client AFTER the `done` it precedes, and a row decided purely by arrival
 * order then slides backwards from Done to Running while its own note still reads "No
 * hiring page found on this site". Ranking the statuses makes the row's state a property
 * of the log rather than of the order frames happened to arrive in.
 *
 * Among terminal statuses the later timestamp wins, which is what lets `coverage` move
 * from pass 1 to pass 2.
 */
const STATUS_RANK = Object.freeze({ started: 0, done: 1, degraded: 1, skipped: 1, failed: 1 });

/** The entry that decides a step's state: most advanced, then most recent. */
function decisiveEntry(history) {
  return history.reduce((best, entry) => {
    if (!best) return entry;

    const bestRank = STATUS_RANK[best.status] ?? 0;
    const entryRank = STATUS_RANK[entry.status] ?? 0;
    if (entryRank !== bestRank) return entryRank > bestRank ? entry : best;

    // Same rank: the later one wins. A missing timestamp never displaces a stamped
    // entry, because it cannot be shown to be later.
    if (!entry.at) return best;
    if (!best.at) return entry;
    return entry.at >= best.at ? entry : best;
  }, null);
}

/** Map a server status onto one of the four display states. */
function stateFor(status) {
  switch (status) {
    case 'started':
      return STEP_STATES.running;
    case 'done':
    case 'degraded':
      return STEP_STATES.done;
    case 'skipped':
      return STEP_STATES.skipped;
    case 'failed':
      return STEP_STATES.failed;
    default:
      return STEP_STATES.pending;
  }
}

/**
 * Build the rows to render from the persisted progress log.
 *
 * The log is append-only and a step can appear several times — `coverage` once per pass,
 * and any step twice as `started` then `done`. The DECISIVE entry sets the state (see
 * `decisiveEntry`: most advanced status, then most recent), and every entry contributes
 * its note, which is how "no hiring page found on this site" survives the step later
 * reporting done.
 *
 * @param {{step: string, status: string, detail?: object, at?: string}[]} progress
 * @returns {{id: string, label: string, state: string, partial: boolean, note: string|null, notes: string[], at: string|null, pass: number|null}[]}
 */
export function deriveSteps(progress = []) {
  const entries = Array.isArray(progress) ? progress : [];

  /** @type {Map<string, object[]>} */
  const byStep = new Map();
  for (const entry of entries) {
    if (!entry?.step) continue;
    if (!byStep.has(entry.step)) byStep.set(entry.step, []);
    byStep.get(entry.step).push(entry);
  }

  // Anything emitted that is not a known step still gets a row, appended in the order
  // it first appeared. Dropping it would hide `resume`, which is the one marker saying
  // this build is a continuation rather than a fresh one.
  const extras = [...byStep.keys()].filter((step) => !STEP_ORDER.includes(step) && !HIDDEN_STEPS.has(step));

  return [...STEP_ORDER, ...extras].map((id) => {
    const history = byStep.get(id) ?? [];
    const last = decisiveEntry(history);

    const notes = history.map((entry) => describeEntry(entry)).filter(Boolean);

    // The highest pass number seen, for the one step whose name carries it.
    const pass = history.reduce((highest, entry) => {
      const value = entry?.detail?.pass;
      return Number.isInteger(value) && value > highest ? value : highest;
    }, 0);

    const base = STEP_LABELS[id] ?? humaniseCode(id)?.replace(/\.$/, '') ?? id;

    return {
      id,
      label: id === 'coverage' && pass > 0 ? `${base} ${pass}` : base,
      state: stateFor(last?.status),
      // A step that ran and produced less than it might have. Shown as done WITH a note,
      // never as a failure — an honest partial result is what this pipeline exists to
      // produce under pressure.
      partial: history.some((entry) => entry.status === 'degraded'),
      note: notes[notes.length - 1] ?? null,
      notes,
      at: last?.at ?? null,
      pass: pass > 0 ? pass : null,
    };
  });
}

/** How each state is said aloud. Separate from the visual word only where it needs to be. */
const SPOKEN_STATE = Object.freeze({
  [STEP_STATES.pending]: 'waiting',
  [STEP_STATES.running]: 'running',
  [STEP_STATES.done]: 'done',
  [STEP_STATES.skipped]: 'skipped',
  [STEP_STATES.failed]: 'failed',
});

/**
 * One row as a complete spoken sentence.
 *
 * WHY A WHOLE SENTENCE RATHER THAN THE VISIBLE PARTS. The step list is a polite live
 * region, so a screen reader announces the nodes that CHANGED. When a row moves from
 * waiting to running the only changed text is the state word, and the announcement is
 * therefore "running" — with nothing saying which of fourteen steps is running, which is
 * worse than silence because the user now has to go and look.
 *
 * Giving each row a single sentence means the whole sentence is what changes, so the
 * announcement is "Crawling the company site: running." The visual row is marked
 * `aria-hidden` so the same information is not read twice in different shapes.
 *
 * The note is included because it is the substance: "Finding the hiring page: done.
 * Partial result. No hiring page found on this site." is the entire point of the row,
 * and a sighted reader gets it from the line underneath.
 */
export function announce(step) {
  const state = SPOKEN_STATE[step.state] ?? SPOKEN_STATE[STEP_STATES.pending];

  const parts = [`${step.label}: ${state}.`];

  // Said before the reason, because "partial" is the fact and the reason is the detail.
  if (step.partial && step.state === STEP_STATES.done) parts.push('Partial result.');
  if (step.note) parts.push(step.note);

  return parts.join(' ');
}

/** A one-line summary of where the build is, for the region that announces it. */
export function summarise(steps, kitStatus) {
  const done = steps.filter((step) => step.state === STEP_STATES.done).length;
  const running = steps.find((step) => step.state === STEP_STATES.running);
  const failed = steps.filter((step) => step.state === STEP_STATES.failed).length;
  const skipped = steps.filter((step) => step.state === STEP_STATES.skipped).length;

  if (kitStatus === 'ready') {
    const caveats = [
      failed > 0 ? `${failed} step${failed === 1 ? '' : 's'} failed` : null,
      skipped > 0 ? `${skipped} skipped` : null,
    ].filter(Boolean);

    // A kit can be ready AND have lost steps along the way. Saying only "finished"
    // would hide exactly the degradation the notes below it explain.
    return caveats.length > 0 ? `Kit finished — ${caveats.join(', ')}.` : 'Kit finished.';
  }

  if (kitStatus === 'failed') return 'This kit could not be built.';
  if (running) return `${running.label}…`;
  if (kitStatus === 'queued') return 'Queued, waiting to start.';

  return `${done} of ${steps.length} steps done.`;
}
