#!/usr/bin/env node
/**
 * evaluate.js — the frozen batch command.
 *
 * Decides: how the process is invoked, and what it prints.
 *
 * Does NOT decide: anything about a kit. It parses argv, reads the cases file, hands
 * each case to the SAME `buildKit` the HTTP API calls, and writes the envelope. There is
 * no second pipeline here, no reduced step list, no different prompts — the monorepo
 * exists so that claim is structural rather than something a README asserts.
 *
 * THE CONTRACT THIS FILE OWES, verbatim from Block B:
 *
 *   npm run evaluate -- --input <cases.json> --output <kits.json>
 *
 *   { "version": "1.0", "generated_at": "<ISO8601Z>",
 *     "kits": [ { id, status, kit, error } ] }
 *
 * Every one of the five automated scoring criteria is read out of that file. If the
 * envelope is wrong, nothing else scores — which is why the shape is asserted by a
 * contract test rather than checked by eye.
 *
 * STDOUT STAYS CLEAN. Progress, per-case summaries and timing all go to stderr, so
 * `npm run evaluate ... > somewhere` and shell pipelines behave. The only thing that
 * ever reaches stdout is the usage text, and only when usage is what was asked for.
 *
 * ENV COMES FROM `--env-file-if-exists=.env` IN THE ROOT SCRIPT, not from a dotenv
 * dependency. Node has loaded .env files natively since 20.12, the `-if-exists` variant
 * tolerates a clean clone that has not made one yet, and one fewer dependency in the
 * path a grader runs is one fewer thing that can fail to install.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { parseArgs, validateCases, USAGE, EXIT } from './args.js';

/**
 * Run the command.
 *
 * Exported and dependency-injected so the contract test can drive it with a stubbed
 * orchestrator and a fake filesystem, in-process, with no network and no quota spend.
 *
 * @param {string[]} argv
 * @param {object} [io] injected boundaries
 * @returns {Promise<number>} the exit code
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const {
    stdout = process.stdout,
    stderr = process.stderr,
    readInput = (path) => readFile(path, 'utf8'),
    runBatch = null,
  } = io;

  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    stderr.write(`${parsed.message}\n\n`);
    stderr.write(USAGE);
    return parsed.exitCode;
  }

  if (parsed.options.help) {
    // The one thing that legitimately belongs on stdout: the user asked to read it.
    stdout.write(USAGE);
    return EXIT.OK;
  }

  const { input, output } = parsed.options;

  let raw;
  try {
    raw = await readInput(input);
  } catch (error) {
    stderr.write(`Could not read --input "${input}": ${error.message}\n`);
    return EXIT.BAD_ARGUMENTS;
  }

  let parsedCases;
  try {
    parsedCases = JSON.parse(raw);
  } catch (error) {
    stderr.write(`--input "${input}" is not valid JSON: ${error.message}\n`);
    return EXIT.BAD_ARGUMENTS;
  }

  const validated = validateCases(parsedCases);
  if (!validated.ok) {
    stderr.write(`${validated.message}\n`);
    return EXIT.BAD_ARGUMENTS;
  }

  const run = runBatch ?? defaultRunBatch;

  try {
    return await run({ cases: validated.cases, options: parsed.options, stderr });
  } catch (error) {
    // A fault in the harness rather than in a case. Cases handle their own failures and
    // never throw, so reaching here means configuration, disk or a programming error —
    // all of which must exit non-zero rather than leaving a clean-looking run behind.
    if (error?.name !== 'ConfigurationRefused') {
      stderr.write(`The run could not complete: ${error?.message ?? error}\n`);
    }
    return EXIT.RUN_FAILED;
  }
}

/**
 * The real batch runner.
 *
 * Separated from `main` so the contract test can replace it wholesale with a stub, and so
 * `main` stays about argv and files rather than about orchestration.
 *
 * Config is loaded HERE rather than at module top level: importing this file must not
 * exit the process because an API key is missing. A test that only wants `main`'s argument
 * handling would otherwise be unable to import it at all.
 */
async function defaultRunBatch({ cases, options, stderr }) {
  const { loadConfigOrExit } = await import('../config/env.js');
  const { createRunContext } = await import('./runCase.js');
  const { runBatch: runAll } = await import('./batch.js');

  const config = loadConfigOrExit(process.env, {
    onError: (text) => stderr.write(`${text}\n`),
    onWarn: (text) => stderr.write(`${text}\n`),
    exit: () => {
      throw new ConfigurationRefused();
    },
  });

  const context = createRunContext({ config });
  const concurrency = config.budgets.batchConcurrency;

  stderr.write(
    `Running ${cases.length} case(s), ${concurrency} at a time. ` +
      `Budget ${config.budgets.maxLlmCallsPerKit} calls per kit, ` +
      `${Math.round(config.budgets.caseSoftDeadlineMs / 1000)}s soft deadline each.\n`
  );

  const { entries, elapsedMs } = await runAll({
    cases,
    context,
    concurrency,
    // Interleaved cases share one stream, so every line is prefixed with its case id.
    // Without that the output of two concurrent builds is unreadable and, worse,
    // misattributable — a failure looks like it belongs to whichever case printed last.
    onCaseStart: ({ index, total, case: kase }) =>
      stderr.write(
        `\n[${kase.id}] (${index + 1}/${total}) ${kase.days} day(s) · ` +
          `${kase.company_url || 'no company url'}\n`
      ),
    onCaseEnd: (entry) => stderr.write(`${formatCaseSummary(entry)}\n`),
  });

  stderr.write(`\n${formatRunSummary(entries, elapsedMs)}\n`);

  const { buildEnvelope, writeEnvelope } = await import('./envelope.js');
  const written = await writeEnvelope(options.output, buildEnvelope(entries));
  stderr.write(`Wrote ${written.bytes} bytes to ${written.path}\n`);

  // A run where every case failed exits non-zero: nothing usable was produced and a
  // green exit code would let a broken configuration pass a CI check. A run with SOME
  // failures still exits 0 — the envelope is complete and correct, and it says which
  // cases failed and why. Failing the whole command for one dead company URL would make
  // the exit code useless as a signal about the command itself.
  const ok = entries.filter((entry) => entry.status === 'ok').length;
  return ok === 0 ? EXIT.RUN_FAILED : EXIT.OK;
}

/** Thrown when config validation failed, so a bad .env does not call process.exit mid-run. */
class ConfigurationRefused extends Error {
  constructor() {
    super('Configuration is invalid; see the problems above.');
    this.name = 'ConfigurationRefused';
  }
}

/** One line per case, on stderr, so stdout stays clean. */
export function formatCaseSummary(entry) {
  const seconds = (entry.meta.elapsedMs / 1000).toFixed(1);

  if (entry.status === 'failed') {
    return `  ✗ ${entry.id} failed after ${seconds}s — ${entry.error.code}: ${entry.error.message}`;
  }

  const { meta } = entry;
  const parts = [
    `${meta.requirements} requirements`,
    `${meta.questions} questions`,
    `${meta.days} day schedule`,
    `${meta.pagesUsed} page(s) used`,
    `${meta.budget.spent}/${meta.budget.maxCalls} calls`,
    `${meta.passes} coverage pass(es)`,
  ];

  // An uncovered requirement is the kind of gap that is easy to ship and hard to notice,
  // so it is called out rather than left to be inferred from a count.
  if (meta.uncovered > 0) parts.push(`⚠ ${meta.uncovered} uncovered`);

  // Notes are where degradation becomes visible. Printing the count and not the notes
  // would make a kit built from a dead company site look identical to a complete one.
  const notes = meta.notes.length > 0 ? `\n      notes: ${meta.notes.join('; ')}` : '';

  return `  ✓ ${entry.id} ok in ${seconds}s — ${parts.join(', ')}${notes}`;
}

/** Totals, including the timing the fifteen-minute window is measured against. */
export function formatRunSummary(entries, elapsedMs) {
  const ok = entries.filter((entry) => entry.status === 'ok').length;
  const failed = entries.length - ok;
  const seconds = (elapsedMs / 1000).toFixed(1);
  const calls = entries.reduce((total, entry) => total + (entry.meta?.budget?.spent ?? 0), 0);

  return (
    `${entries.length} case(s): ${ok} ok, ${failed} failed · ${seconds}s total · ` +
    `${calls} model call(s) spent`
  );
}

/**
 * Direct execution.
 *
 * `pathToFileURL`, never a hand-built `file://` + path. On Windows the hand-built form
 * produces `file://C:/Users/.../AI Based Project/...` while `import.meta.url` is
 * `file:///C:/Users/.../AI%20Based%20Project/...` — two slashes against three, and a
 * space against `%20`. They never match, so the command parses nothing, prints nothing
 * and exits 0. A batch command that silently succeeds having done no work is the worst
 * possible failure here, because every automated point is read from a file it never
 * wrote.
 */
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main();
}
