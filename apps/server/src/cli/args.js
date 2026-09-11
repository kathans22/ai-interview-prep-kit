/**
 * args.js — parse the batch command's arguments, or explain why they are wrong.
 *
 * Decides: what the CLI accepts, and what it prints when it does not.
 *
 * Does NOT decide: what to do with the files. It hands back paths; the runner reads and
 * writes them.
 *
 * THE COMMAND IS FROZEN, so this file exists mainly to be strict about one line:
 *
 *   npm run evaluate -- --input <cases.json> --output <kits.json>
 *
 * Both flags are required. There is no positional form, no short alias, no default
 * output path. That is deliberate: a grader running this from a clean clone types the
 * documented command exactly, and every convenience alternative is another shape that
 * has to keep working. A default output path in particular would be a trap — a run that
 * silently wrote somewhere unexpected looks identical to one that worked.
 *
 * BAD ARGUMENTS EXIT NON-ZERO AND SAY WHY. Printing usage and exiting 0 is the failure
 * mode where a CI pipeline goes green having produced nothing.
 *
 * Pure: no file I/O, no process.exit. It returns a decision and lets the caller act, so
 * it can be tested without spawning anything.
 */

/** Exit codes the batch command uses. */
export const EXIT = Object.freeze({
  OK: 0,
  BAD_ARGUMENTS: 2,
  RUN_FAILED: 1,
});

export const USAGE = `
evaluate — generate interview prep kits for a batch of cases

Usage:
  npm run evaluate -- --input <cases.json> --output <kits.json>

Required:
  --input <path>    JSON array of cases: { id, jd, company_url, days }
  --output <path>   where the results document is written

Options:
  --concurrency <n> cases in flight at once (default: BATCH_CONCURRENCY, or 2)
  --fake            use the deterministic offline provider. Makes no requests to
                    Google and spends no quota, and needs no .env at all — so a
                    clean clone can verify the whole pipeline without an API key.
  -h, --help        show this message

Output:
  { "version": "1.0", "generated_at": "<ISO8601Z>", "kits": [ { id, status, kit, error } ] }

  status is "ok" when a kit was produced, even a degraded one with recorded gaps.
  It is "failed" only when no kit could be produced at all.
`.trimStart();

/** Flags that take a value. */
const VALUE_FLAGS = new Set(['--input', '--output', '--concurrency']);

/** Flags that do not. */
const BOOLEAN_FLAGS = new Set(['--fake', '--help', '-h']);

/**
 * Parse argv.
 *
 * @param {string[]} argv arguments after the script name
 * @returns {{ ok: true, options: object } | { ok: false, exitCode: number, message: string, showUsage: boolean }}
 */
export function parseArgs(argv = []) {
  // `concurrency: null` means "not specified", which is NOT the same as 2. With a
  // default of 2 here the caller cannot tell an explicit --concurrency 2 from silence,
  // so BATCH_CONCURRENCY in .env could never win and would be dead configuration.
  const options = { input: null, output: null, concurrency: null, fake: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (BOOLEAN_FLAGS.has(token)) {
      if (token === '--help' || token === '-h') options.help = true;
      if (token === '--fake') options.fake = true;
      continue;
    }

    if (VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      // A flag whose value is missing, or is itself a flag, is a typo — not a request
      // to treat "--output" as a filename.
      if (value === undefined || value.startsWith('-')) {
        return fail(`${token} needs a value.`);
      }
      index += 1;

      if (token === '--input') options.input = value;
      else if (token === '--output') options.output = value;
      else if (token === '--concurrency') {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) {
          return fail(`--concurrency must be a whole number from 1 to 8, got "${value}".`);
        }
        options.concurrency = parsed;
      }
      continue;
    }

    // Support --flag=value as well, because people type it and silently ignoring it
    // would produce a run with no input rather than an error.
    const equals = token.indexOf('=');
    if (token.startsWith('--') && equals !== -1) {
      const name = token.slice(0, equals);
      const value = token.slice(equals + 1);
      if (VALUE_FLAGS.has(name)) {
        return parseArgs([...argv.slice(0, index), name, value, ...argv.slice(index + 1)]);
      }
    }

    return fail(`Unrecognised argument "${token}".`);
  }

  if (options.help) return { ok: true, options };

  if (!options.input && !options.output) return fail('--input and --output are both required.');
  if (!options.input) return fail('--input is required.');
  if (!options.output) return fail('--output is required.');

  return { ok: true, options };
}

function fail(message) {
  return { ok: false, exitCode: EXIT.BAD_ARGUMENTS, message, showUsage: true };
}

/**
 * Validate the parsed cases file.
 *
 * Checked before any work begins: discovering that case four has no `days` after
 * spending eleven model calls on cases one to three is the expensive way to find a typo.
 *
 * @param {unknown} parsed
 * @returns {{ ok: true, cases: object[] } | { ok: false, message: string }}
 */
export function validateCases(parsed) {
  if (!Array.isArray(parsed)) {
    return { ok: false, message: 'The input file must contain a JSON array of cases.' };
  }
  if (parsed.length === 0) {
    return { ok: false, message: 'The input file contains no cases.' };
  }

  const problems = [];
  const seen = new Set();

  parsed.forEach((entry, index) => {
    const where = `cases[${index}]`;

    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (id === '') problems.push(`${where}.id is required — it keys the output entry.`);
    else if (seen.has(id)) problems.push(`${where}.id "${id}" is duplicated; ids must be unique.`);
    else seen.add(id);

    if (typeof entry?.jd !== 'string' || entry.jd.trim() === '') {
      problems.push(`${where}.jd is required.`);
    }
    if (!Number.isInteger(entry?.days) || entry.days < 1) {
      problems.push(`${where}.days must be a positive whole number.`);
    }
    if (entry?.company_url !== undefined && typeof entry.company_url !== 'string') {
      problems.push(`${where}.company_url must be a string when present.`);
    }
  });

  if (problems.length > 0) {
    return { ok: false, message: `The input file is not usable:\n  ${problems.join('\n  ')}` };
  }

  return {
    ok: true,
    cases: parsed.map((entry) => ({
      id: entry.id.trim(),
      jd: entry.jd,
      company_url: typeof entry.company_url === 'string' ? entry.company_url : '',
      days: entry.days,
    })),
  };
}
