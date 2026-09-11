/**
 * cli.test.js — the batch contract, guarded.
 *
 * Decides: that `npm run evaluate` produces exactly the envelope Block B specifies,
 * including when a case fails.
 *
 * Does NOT decide: whether a kit is any good. That is the eval harness's job. This
 * asserts the shape of the file — and the shape is what gates all 55 automated points,
 * so a break here is not a failing test, it is a zero.
 *
 * THE ORCHESTRATOR IS STUBBED, ON PURPOSE. The stage says so, and the reason is that a
 * contract test which needed Gemini would cost twelve of twenty daily requests to run
 * once, so it would stop being run — leaving the one assertion that gates every
 * automated point as the one nobody checks. The stub lets this run on every commit, for
 * nothing, offline. `runCase` itself is exercised against the real orchestrator by the
 * smoke run.
 *
 * ONE CASE SUCCEEDS AND ONE THROWS, in the same run, because the interesting property is
 * not that either shape is right on its own — it is that a failure does not damage the
 * entry beside it, or the file they share.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateKit } from '@aipk/core/contracts/validateKit.js';

import { main } from '../src/cli/evaluate.js';
import { runBatch } from '../src/cli/batch.js';
import { buildEnvelope, writeEnvelope, isoZ, ENVELOPE_VERSION } from '../src/cli/envelope.js';
import { toCaseError, CASE_ERROR_CODES } from '../src/cli/runCase.js';
import { EXIT } from '../src/cli/args.js';

/** A complete, contract-valid kit — the thing a successful case must put in the file. */
function validKit({ days = 2 } = {}) {
  const question = (id, requirementId, category, difficulty) => ({
    id,
    requirement_ids: [requirementId],
    category,
    prompt: `A question about ${requirementId}, asked as an interviewer would.`,
    answer_outline: 'Context, the decision, the trade-off, and how it turned out.',
    difficulty,
  });

  return {
    source: {
      company: 'Acme Logistics',
      company_url: 'http://localhost:8099/acme/',
      role: 'Senior Frontend Engineer',
      location: 'Remote (UK)',
      jd_chars: 455,
      researched_at: '2026-09-11T00:00:00Z',
      pages_used: ['http://localhost:8099/acme/'],
    },
    company_brief: {
      summary: 'Acme builds dispatch and routing software.',
      what_they_do: 'An operator console for fleet dispatchers.',
      sources: ['http://localhost:8099/acme/'],
    },
    role: {
      title: 'Senior Frontend Engineer',
      seniority: 'senior',
      responsibilities: ['Own the operator console'],
      requirements: [
        { id: 'r1', text: '5+ years with React and TypeScript', kind: 'technical', priority: 'must' },
        { id: 'r2', text: 'Mentoring junior engineers', kind: 'behavioural', priority: 'must' },
      ],
    },
    questions: [
      question('q1', 'r1', 'technical', 3),
      question('q2', 'r1', 'system-design', 2),
      question('q3', 'r2', 'behavioural', 2),
      question('q4', 'r2', 'company-fit', 1),
    ],
    flashcards: [
      { id: 'f1', front: 'What does React reconciliation cost?', back: 'Work proportional to the tree.', requirement_ids: ['r1'] },
    ],
    schedule: {
      days_available: days,
      days: [
        { day: 1, focus: 'Technical depth', question_ids: ['q1', 'q2'], minutes: 60 },
        { day: 2, focus: 'Behavioural and fit', question_ids: ['q3', 'q4'], minutes: 45 },
      ].slice(0, days),
    },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
  };
}

/** Two cases: one that builds, one that throws. */
const CASES = [
  { id: 'case-ok', jd: 'A job description long enough to be usable.', company_url: '', days: 2 },
  { id: 'case-boom', jd: 'Another job description, for the case that fails.', company_url: '', days: 3 },
];

/** A stubbed orchestrator: `case-boom` throws the way a real build failure does. */
async function stubRunCase(kase) {
  if (kase.id === 'case-boom') {
    const error = new Error('Company site unreachable after 3 retries.');
    error.code = 'BUILD_NO_REQUIREMENTS';
    throw error;
  }
  return {
    id: kase.id,
    status: 'ok',
    kit: validKit({ days: kase.days }),
    error: null,
    meta: { elapsedMs: 5, notes: [], budget: { spent: 9, maxCalls: 12 }, requirements: 2, questions: 4, days: kase.days, pagesUsed: 1, uncovered: 0, passes: 1 },
  };
}

async function inTempDir(body) {
  const directory = await mkdtemp(join(tmpdir(), 'aipk-cli-'));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// ===========================================================================
// THE CONTRACT
// ===========================================================================

test('CONTRACT: the envelope has exactly the specified shape, with one case failed', async () => {
  await inTempDir(async (directory) => {
    const output = join(directory, 'kits.json');

    const { entries } = await runBatch({ cases: CASES, context: {}, run: stubRunCase });
    await writeEnvelope(output, buildEnvelope(entries));

    const envelope = JSON.parse(await readFile(output, 'utf8'));

    // --- the envelope itself ---------------------------------------------
    assert.deepEqual(Object.keys(envelope), ['version', 'generated_at', 'kits']);
    assert.equal(envelope.version, '1.0');
    assert.equal(typeof envelope.version, 'string', 'a number would serialise to 1 and stop matching');
    assert.match(
      envelope.generated_at,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      'an ISO 8601 Z string to whole seconds, as the spec prints it'
    );

    // --- both ids present, in input order ---------------------------------
    assert.equal(envelope.kits.length, 2, 'one entry per input case, always');
    assert.deepEqual(envelope.kits.map((entry) => entry.id), ['case-ok', 'case-boom']);

    // --- the successful case ----------------------------------------------
    const [ok, failed] = envelope.kits;
    assert.deepEqual(Object.keys(ok), ['id', 'status', 'kit', 'error']);
    assert.equal(ok.status, 'ok');
    assert.equal(ok.error, null);

    // The whole point of the file: the kit in it satisfies the frozen contract.
    const validation = validateKit(ok.kit);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors, null, 2));

    // --- the failed case ---------------------------------------------------
    assert.deepEqual(Object.keys(failed), ['id', 'status', 'kit', 'error']);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.kit, null, 'a failed case carries no kit');
    assert.notEqual(failed.error, null, 'and it must say why');
    assert.equal(typeof failed.error.code, 'string');
    assert.ok(failed.error.code.length > 0, 'the code is what a reader can act on');
    assert.equal(typeof failed.error.message, 'string');

    // The code comes from the closed set, not invented at the throw site.
    assert.ok(
      Object.values(CASE_ERROR_CODES).includes(failed.error.code),
      `${failed.error.code} is not one of the stable codes`
    );
  });
});

test('CONTRACT: a failing case does not damage the entry beside it', async () => {
  const { entries, ok, failed } = await runBatch({
    cases: CASES,
    context: {},
    run: stubRunCase,
  });

  assert.equal(ok, 1);
  assert.equal(failed, 1);
  assert.equal(entries.length, 2);
  assert.equal(validateKit(entries[0].kit).valid, true, 'the good kit survived its neighbour failing');
});

test('the whole command writes the file, end to end', async () => {
  await inTempDir(async (directory) => {
    const output = join(directory, 'out', 'kits.json');
    let err = '';

    const code = await main(['--input', 'cases.json', '--output', output], {
      stdout: { write: () => true },
      stderr: { write: (text) => { err += text; return true; } },
      readInput: async () => JSON.stringify(CASES),
      runBatch: async ({ cases, options }) => {
        const { entries } = await runBatch({ cases, context: {}, run: stubRunCase });
        await writeEnvelope(options.output, buildEnvelope(entries));
        return EXIT.OK;
      },
    });

    assert.equal(code, EXIT.OK);

    // The output directory did not exist: a clean clone should not have to mkdir first.
    const envelope = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(envelope.kits.length, 2);
    assert.equal(err, '', 'the stub wrote nothing; the real runner is what logs');
  });
});

// ===========================================================================
// Error translation — the codes a reader depends on
// ===========================================================================

test('error codes come from a closed set, and the cause beats the wrapper', () => {
  // buildKit wraps every extraction failure as BUILD_NO_REQUIREMENTS, so without reading
  // the cause a rate limit and a contentless posting arrive under one code — and one is
  // worth retrying tomorrow while the other never will be.
  assert.equal(
    toCaseError({ code: 'BUILD_NO_REQUIREMENTS', message: 'x', details: { cause: { code: 'LLM_RATE_LIMITED' } } }).code,
    CASE_ERROR_CODES.LLM_RATE_LIMITED
  );
  assert.equal(
    toCaseError({ code: 'BUILD_NO_REQUIREMENTS', message: 'x' }).code,
    CASE_ERROR_CODES.NO_REQUIREMENTS
  );
  assert.equal(toCaseError({ code: 'BUILD_NO_JD', message: 'x' }).code, CASE_ERROR_CODES.EMPTY_JD);
  assert.equal(toCaseError({ code: 'BUILD_BAD_DAYS', message: 'x' }).code, CASE_ERROR_CODES.INVALID_CASE);
  assert.equal(toCaseError({ code: 'LLM_CONTENT_BLOCKED', message: 'x' }).code, CASE_ERROR_CODES.LLM_CONTENT_BLOCKED);

  // An unrecognised failure never leaks an internal name into the envelope.
  assert.equal(toCaseError({ code: 'SOMETHING_NEW', message: 'x' }).code, CASE_ERROR_CODES.BUILD_FAILED);
  assert.equal(toCaseError(undefined).code, CASE_ERROR_CODES.BUILD_FAILED);

  // A failure that carried no message still produces one, because `message` is not
  // nullable in the contract.
  assert.ok(toCaseError({ code: 'X' }).message.length > 0);
});

// ===========================================================================
// Arguments
// ===========================================================================

test('bad arguments exit non-zero with usage, and stdout stays clean', async () => {
  const cases = [
    [[], 'no arguments'],
    [['--input', 'only.json'], 'missing --output'],
    [['--output', 'only.json'], 'missing --input'],
  ];

  for (const [argv, what] of cases) {
    let out = '';
    let err = '';
    // eslint-disable-next-line no-await-in-loop
    const code = await main(argv, {
      stdout: { write: (text) => { out += text; return true; } },
      stderr: { write: (text) => { err += text; return true; } },
      readInput: async () => '[]',
    });

    assert.equal(code, EXIT.BAD_ARGUMENTS, `${what} should exit ${EXIT.BAD_ARGUMENTS}`);
    assert.ok(err.length > 0, `${what} should explain itself on stderr`);
    assert.equal(out, '', `${what} must not write to stdout — it is a data channel`);
  }
});

test('--help is the one thing that may reach stdout, and exits 0', async () => {
  let out = '';
  const code = await main(['--help'], {
    stdout: { write: (text) => { out += text; return true; } },
    stderr: { write: () => true },
  });

  assert.equal(code, EXIT.OK);
  assert.match(out, /--input/);
  assert.match(out, /--output/);
});

test('an unreadable or malformed input file fails before any work begins', async () => {
  let err = '';
  const io = {
    stdout: { write: () => true },
    stderr: { write: (text) => { err += text; return true; } },
  };

  const missing = await main(['--input', 'nope.json', '--output', 'out.json'], {
    ...io,
    readInput: async () => { throw new Error('ENOENT: no such file'); },
  });
  assert.equal(missing, EXIT.BAD_ARGUMENTS);
  assert.match(err, /Could not read/);

  err = '';
  const notJson = await main(['--input', 'bad.json', '--output', 'out.json'], {
    ...io,
    readInput: async () => '{not json',
  });
  assert.equal(notJson, EXIT.BAD_ARGUMENTS);
  assert.match(err, /not valid JSON/);

  err = '';
  const notCases = await main(['--input', 'bad.json', '--output', 'out.json'], {
    ...io,
    readInput: async () => JSON.stringify([{ id: 'a' }]),
  });
  assert.equal(notCases, EXIT.BAD_ARGUMENTS);
  // Every fault at once: discovering case four has no `days` after spending eleven
  // model calls on cases one to three is an expensive way to find a typo.
  assert.match(err, /jd is required/);
  assert.match(err, /days must be/);
});

// ===========================================================================
// The atomic write
// ===========================================================================

test('the output file is complete or absent, never half written', async () => {
  await inTempDir(async (directory) => {
    const output = join(directory, 'kits.json');
    const envelope = buildEnvelope([{ id: 'a', status: 'ok', kit: validKit(), error: null }]);

    await writeEnvelope(output, envelope);
    const before = await readFile(output, 'utf8');

    await assert.rejects(
      writeEnvelope(output, envelope, {
        write: async () => { throw new Error('ENOSPC: no space left on device'); },
      }),
      /ENOSPC/
    );

    // The previous good output survived, and no temp file was left behind to be
    // mistaken for it or to accumulate over a week of failed runs.
    assert.equal(await readFile(output, 'utf8'), before);
    assert.deepEqual(await readdir(directory), ['kits.json']);
  });
});

test('the rename happens only after the bytes are written', async () => {
  const order = [];
  await writeEnvelope('/tmp/ignored.json', buildEnvelope([]), {
    write: async () => { order.push('write'); },
    move: async () => { order.push('rename'); },
    makeDir: async () => {},
  });

  // Reversed, the reader could see an empty file under the real name.
  assert.deepEqual(order, ['write', 'rename']);
});

test('the version and timestamp helpers match the frozen spelling', () => {
  assert.equal(ENVELOPE_VERSION, '1.0');
  assert.equal(isoZ(new Date('2026-09-01T09:12:44.567Z')), '2026-09-01T09:12:44Z');
  assert.ok(!isoZ().includes('.'), 'no fractional seconds');
  assert.ok(isoZ().endsWith('Z'), 'UTC, not a local offset');
});
