/**
 * smoke.js — the cheapest possible proof that a clean clone is wired correctly.
 *
 * Decides: whether the repository skeleton is intact — workspaces resolve, the root
 * scripts point at files that exist, and Node is new enough to run the project.
 *
 * Does NOT decide: whether the OUTPUT is any good. It never touches Gemini, so it can
 * say the pipeline runs end to end and produces a contract-valid kit; it can say nothing
 * about whether the questions are worth asking. That is the extraction eval's job, and
 * the real timed run's.
 *
 * TWO PARTS:
 *   1. the skeleton — workspaces resolve, root scripts point at files that exist, Node
 *      is new enough. Pure filesystem, instant.
 *   2. the batch run — all five sample cases through the REAL orchestrator, against the
 *      local fixture sites and an offline provider.
 *
 * WHY PART 2 IS WORTH THE SECONDS IT COSTS. Everything the graded command does — argv,
 * config, the limiter, the crawler, every generation step, coverage, scheduling,
 * validation, the envelope, the atomic write — runs here, with no network and no quota.
 * Before this, the only way to exercise that path was to spend twelve of twenty daily
 * model requests, which meant it was exercised rarely and late. The two faults that hurt
 * most in this project (BUG-008 and BUG-019, both "implemented, tested, called by
 * nothing") were invisible precisely because no test ran the whole path.
 *
 * It is still offline and still free, so it stays safe to run any number of times
 * against a rate-limited free tier.
 *
 * Run with: npm run smoke
 */

import { access, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_NODE_MAJOR = 20;

const REQUIRED_PATHS = [
  'package.json',
  '.env.example',
  '.gitignore',
  'packages/core/package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'apps/server/src/cli/evaluate.js',
  'scripts/smoke.js',
  'scripts/evalExtraction.js',
];

const REQUIRED_SCRIPTS = ['evaluate', 'eval:extraction', 'smoke', 'dev:server', 'dev:web', 'test'];

const checks = [];

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
}

async function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  record(
    `node >= ${REQUIRED_NODE_MAJOR}`,
    major >= REQUIRED_NODE_MAJOR,
    `found v${process.versions.node}`
  );
}

async function checkPaths() {
  for (const relative of REQUIRED_PATHS) {
    let ok = true;
    let detail = 'present';
    try {
      await access(join(repoRoot, relative));
    } catch (cause) {
      ok = false;
      detail = `missing (${cause.code})`;
    }
    record(relative, ok, detail);
  }
}

async function checkRootScripts() {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const scripts = manifest.scripts ?? {};
  for (const name of REQUIRED_SCRIPTS) {
    record(`script:${name}`, Boolean(scripts[name]), scripts[name] ?? 'not defined');
  }
  record(
    'workspaces declared',
    Array.isArray(manifest.workspaces) && manifest.workspaces.length > 0,
    JSON.stringify(manifest.workspaces ?? null)
  );
}

async function checkWorkspaceLinks() {
  for (const name of ['core', 'server', 'web']) {
    let ok = true;
    let detail = 'linked';
    try {
      await access(join(repoRoot, 'node_modules', '@aipk', name));
    } catch {
      ok = false;
      detail = 'not linked — run `npm install` at the repo root';
    }
    record(`@aipk/${name}`, ok, detail);
  }
}

/**
 * Run all five sample cases end to end, offline.
 *
 * Config is built here rather than read from `.env`, because the smoke run must work on
 * a clean clone with no `.env` at all. The numbers are deliberately generous: this is
 * not measuring rate limiting, and a real RPM here would make the run sleep for minutes
 * to prove something the limiter's own tests already prove.
 */
async function checkBatchRun() {
  const { startFixtureServer } = await import('../fixtures/serve.js');
  const { createFixtureProvider } = await import('@aipk/core/llm/offlineProvider.js');
  const { validateCases } = await import('../apps/server/src/cli/args.js');
  const { createRunContext } = await import('../apps/server/src/cli/runCase.js');
  const { runBatch } = await import('../apps/server/src/cli/batch.js');
  const { buildEnvelope, writeEnvelope } = await import('../apps/server/src/cli/envelope.js');
  const { validateKit } = await import('@aipk/core/contracts/validateKit.js');
  const { verifySchedule } = await import('@aipk/core/deterministic/verifySchedule.js');
  const { resetLimiterForTests } = await import('@aipk/core/llm/limiter.js');

  const raw = await readFile(join(repoRoot, 'fixtures/cases.sample.json'), 'utf8');
  const validated = validateCases(JSON.parse(raw));
  if (!validated.ok) {
    record('sample cases parse', false, validated.message);
    return;
  }
  record('sample cases parse', true, `${validated.cases.length} cases`);

  // Port 0, then rewrite the case URLs to the port actually granted. Binding 8099
  // because the file says so would make the smoke run fail whenever anything else on
  // the machine already holds it, including a second copy of this run.
  const server = await startFixtureServer({ port: 0 });
  const cases = validated.cases.map((entry) => ({
    ...entry,
    company_url: entry.company_url.replace(
      /^http:\/\/localhost:\d+/,
      `http://127.0.0.1:${server.port}`
    ),
  }));

  // The smoke run owns the process, so it configures the singleton from scratch. A
  // previous configuration would otherwise make `configureLimiter` throw.
  resetLimiterForTests();

  const context = createRunContext({
    config: {
      env: 'test',
      isProduction: false,
      gemini: { apiKey: 'offline', model: 'fixture', maxOutputTokens: 2048, rpm: 10_000, tpm: 100_000_000, rpd: 100_000 },
      budgets: { maxLlmCallsPerKit: 12, caseSoftDeadlineMs: 150_000, batchConcurrency: 2 },
      retrieval: {
        searchProvider: 'none',
        searchApiKey: null,
        // The fixture sites are on 127.0.0.1, which the SSRF guard blocks by default —
        // correctly. This is the one context where that must be relaxed, and it is
        // relaxed here rather than by setting the env var the deployment reads.
        allowPrivateHosts: true,
        crawlMaxPages: 12,
        crawlMaxDepth: 2,
        crawlConcurrency: 3,
        fetchTimeoutMs: 8000,
        fetchMaxBytes: 2_000_000,
      },
    },
    provider: createFixtureProvider(),
  });

  let result;
  try {
    result = await runBatch({ cases, context });
  } finally {
    await server.close();
  }

  const { entries, elapsedMs } = result;

  record(
    'batch run completes',
    entries.length === cases.length && entries.every(Boolean),
    `${entries.length}/${cases.length} entries in ${(elapsedMs / 1000).toFixed(1)}s`
  );

  // Every case present, in input order. The envelope contract depends on both.
  record(
    'every case appears, in input order',
    entries.map((entry) => entry.id).join(',') === cases.map((entry) => entry.id).join(','),
    entries.map((entry) => `${entry.id}:${entry.status}`).join(' ')
  );

  // Each case's OWN days, not one default applied to all five.
  const scheduleRespectsDays = entries.every((entry, index) =>
    entry.status !== 'ok' ? true : entry.kit.schedule.days_available === cases[index].days
  );
  record(
    'each case uses its own days value',
    scheduleRespectsDays,
    cases.map((entry, index) => `${entry.days}→${entries[index].kit?.schedule?.days_available ?? '-'}`).join(' ')
  );

  // The assertion the whole command exists for.
  for (const entry of entries) {
    if (entry.status !== 'ok') {
      record(`${entry.id} produced a kit`, false, `${entry.error.code}: ${entry.error.message}`);
      continue;
    }

    const shape = validateKit(entry.kit);
    const schedule = verifySchedule(entry.kit);
    const ok = shape.valid && schedule.violations.length === 0;

    record(
      `${entry.id} kit is valid`,
      ok,
      ok
        ? `${entry.kit.role.requirements.length} reqs, ${entry.kit.questions.length} qs, ` +
          `${entry.kit.schedule.days_available}d, ${entry.meta.budget.spent} calls`
        : `${shape.errors.length} shape error(s), ${schedule.violations.length} schedule violation(s)`
    );
  }

  // No case may exceed the per-kit ceiling, and the run as a whole should sit near the
  // eleven-call normal path rather than quietly repairing its way to twelve every time.
  const overBudget = entries.filter((entry) => (entry.meta?.budget?.spent ?? 0) > 12);
  record(
    'no case exceeded the 12-call ceiling',
    overBudget.length === 0,
    `max ${Math.max(...entries.map((entry) => entry.meta?.budget?.spent ?? 0))} calls`
  );

  // The envelope, written the way the graded command writes it.
  const output = join(repoRoot, 'fixtures', '.smoke-kits.json');
  const envelope = buildEnvelope(entries);
  await writeEnvelope(output, envelope);

  const readBack = JSON.parse(await readFile(output, 'utf8'));
  record(
    'envelope round trips from disk',
    readBack.version === '1.0' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(readBack.generated_at) &&
      readBack.kits.length === cases.length,
    `version ${readBack.version}, ${readBack.kits.length} kits, ${readBack.generated_at}`
  );

  await rm(output, { force: true });
}

async function main() {
  await checkNodeVersion();
  await checkPaths();
  await checkRootScripts();
  await checkWorkspaceLinks();
  await checkBatchRun();

  for (const { name, ok, detail } of checks) {
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${name} — ${detail}\n`);
  }

  const failed = checks.filter((check) => !check.ok);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);

  if (failed.length > 0) {
    process.stderr.write(`smoke: ${failed.length} check(s) failed\n`);
    process.exit(1);
  }
}

main().catch((cause) => {
  process.stderr.write(`smoke: unexpected failure — ${cause.message}\n`);
  process.exit(1);
});
