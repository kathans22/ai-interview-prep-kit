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

  if (!runBatch) {
    // The runner arrives in the next unit. Until then, say so rather than pretending.
    stderr.write(
      `Parsed ${validated.cases.length} case(s) from ${input}, but the batch runner is not wired yet.\n`
    );
    return EXIT.RUN_FAILED;
  }

  return runBatch({ cases: validated.cases, options: parsed.options, stderr });
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
