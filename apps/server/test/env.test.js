/**
 * env.test.js — tests for the boot-time configuration validator.
 *
 * Decides: that a bad environment is rejected with a named reason, and that a good one
 * coerces to the shape the rest of the process expects.
 *
 * Does NOT decide: anything about kits. No network, no database, no Gemini — this suite
 * is free to run against a rate-limited free tier.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateEnv, formatProblems, formatWarnings, loadConfigOrExit } from '../src/config/env.js';

/**
 * A minimal environment that should validate cleanly.
 *
 * Mirrors .env.example exactly. When the template gains a variable, this fixture must
 * gain it too — a test fixture that drifts from the shipped template stops testing the
 * configuration anybody actually uses.
 */
function validEnv(overrides = {}) {
  return {
    NODE_ENV: 'development',
    PORT: '4000',
    WEB_ORIGIN: 'http://localhost:5173',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/ai_interview_prep_kit',
    SESSION_SECRET: 'a'.repeat(64),
    GEMINI_API_KEY: 'test-key',
    GEMINI_MODEL: 'gemini-3.6-flash',
    GEMINI_MODEL_LIGHT: 'gemini-3.5-flash-lite',
    GEMINI_RPM: '5',
    GEMINI_TPM: '100000',
    GEMINI_RPD: '200',
    LLM_MAX_OUTPUT_TOKENS: '8192',
    MAX_LLM_CALLS_PER_KIT: '12',
    CASE_SOFT_DEADLINE_MS: '150000',
    BATCH_CONCURRENCY: '2',
    IDEMPOTENCY_WINDOW_MS: '900000',
    SEARCH_PROVIDER: 'tavily',
    SEARCH_API_KEY: 'tvly-test',
    ALLOW_PRIVATE_HOSTS: 'true',
    CRAWL_MAX_PAGES: '12',
    CRAWL_CONCURRENCY: '3',
    FETCH_TIMEOUT_MS: '10000',
    FETCH_MAX_BYTES: '2000000',
    FIXTURE_PORT: '8099',
    ...overrides,
  };
}

function codesFor(result, name) {
  return result.problems.filter((entry) => entry.name === name).map((entry) => entry.code);
}

test('a complete environment validates and coerces types', () => {
  const { ok, config, problems } = validateEnv(validEnv());

  assert.equal(ok, true);
  assert.deepEqual(problems, []);
  assert.equal(config.gemini.rpm, 5);
  assert.equal(config.gemini.maxOutputTokens, 8192);
  assert.equal(config.budgets.maxLlmCallsPerKit, 12);
  assert.equal(config.budgets.caseSoftDeadlineMs, 150000);
  assert.equal(config.server.port, 4000);
  assert.equal(config.retrieval.allowPrivateHosts, true);
  assert.equal(config.gemini.modelLight, 'gemini-3.5-flash-lite', 'the template enables the split');
});

test('every missing required variable is reported, not just the first', () => {
  const { ok, config, problems } = validateEnv({});

  assert.equal(ok, false);
  assert.equal(config, null);
  const missing = problems.filter((entry) => entry.code === 'CONFIG_MISSING').map((e) => e.name);
  for (const name of ['MONGODB_URI', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'PORT', 'WEB_ORIGIN']) {
    assert.ok(missing.includes(name), `${name} should be reported missing`);
  }
});

test('an empty GEMINI_MODEL fails at boot rather than as a 404 later', () => {
  const result = validateEnv(validEnv({ GEMINI_MODEL: '   ' }));
  assert.equal(result.ok, false);
  assert.deepEqual(codesFor(result, 'GEMINI_MODEL'), ['CONFIG_MISSING']);
});

test('-latest, -preview and -exp model ids are rejected', () => {
  for (const model of ['gemini-flash-latest', 'gemini-3.7-flash-preview', 'gemini-3.7-flash-exp']) {
    const result = validateEnv(validEnv({ GEMINI_MODEL: model }));
    assert.equal(result.ok, false, `${model} should be rejected`);
    assert.ok(
      codesFor(result, 'GEMINI_MODEL').includes('CONFIG_UNSTABLE_MODEL'),
      `${model} should report CONFIG_UNSTABLE_MODEL`
    );
  }
});

test('shut-down model families are rejected with their own code', () => {
  for (const model of ['gemini-1.5-flash', 'gemini-2.0-flash']) {
    const result = validateEnv(validEnv({ GEMINI_MODEL: model }));
    assert.ok(
      codesFor(result, 'GEMINI_MODEL').includes('CONFIG_RETIRED_MODEL'),
      `${model} should report CONFIG_RETIRED_MODEL`
    );
  }
});

test('a blank tavily key WARNS and still boots — a fresh clone must be able to start', () => {
  // .env.example ships SEARCH_API_KEY blank on purpose, and selectSearchProvider falls
  // back to the no-op provider, which still runs the step and records an honest empty
  // result. Making this fatal would stop anyone who copied the template verbatim.
  const withoutKey = validateEnv(validEnv({ SEARCH_API_KEY: '' }));

  assert.equal(withoutKey.ok, true, 'a blank search key must not stop boot');
  assert.deepEqual(codesFor(withoutKey, 'SEARCH_API_KEY'), [], 'and must not be an error');
  assert.deepEqual(
    withoutKey.warnings.map((entry) => entry.code),
    ['CONFIG_DEGRADED_SEARCH'],
    'but it must be said out loud'
  );
  assert.equal(withoutKey.config.retrieval.searchApiKey, null);

  const noProvider = validateEnv(validEnv({ SEARCH_PROVIDER: 'none', SEARCH_API_KEY: '' }));
  assert.equal(noProvider.ok, true);
  assert.deepEqual(noProvider.warnings, [], 'choosing "none" deliberately is not degraded');
});

test('every variable in .env.example is validated, not silently undefined', () => {
  // The bug this catches: a variable added to the template but not to REQUIRED_VARS
  // passes validation while undefined, then surfaces as NaN in a limiter or an
  // undefined fetch timeout, three stages away from the cause.
  for (const name of [
    'NODE_ENV', 'BATCH_CONCURRENCY', 'IDEMPOTENCY_WINDOW_MS',
    'CRAWL_MAX_PAGES', 'CRAWL_CONCURRENCY', 'FETCH_TIMEOUT_MS', 'FETCH_MAX_BYTES',
  ]) {
    const result = validateEnv(validEnv({ [name]: '' }));
    assert.equal(result.ok, false, `${name} must be validated`);
    assert.deepEqual(codesFor(result, name), ['CONFIG_MISSING'], `${name} should report missing`);
  }
});

test('the crawl and fetch numbers land in config as integers', () => {
  const { config } = validateEnv(validEnv());
  assert.equal(config.retrieval.crawlMaxPages, 12);
  assert.equal(config.retrieval.crawlConcurrency, 3);
  assert.equal(config.retrieval.fetchTimeoutMs, 10000);
  assert.equal(config.retrieval.fetchMaxBytes, 2000000);
  assert.equal(config.budgets.batchConcurrency, 2);
  assert.equal(config.budgets.idempotencyWindowMs, 900000);
  assert.equal(config.fixtures.port, 8099);
  assert.equal(config.retrieval.crawlMaxDepth, 2, 'absent from the template, defaulted here');
});

test('integers outside a sane range are rejected with their bounds named', () => {
  for (const [name, value] of [
    ['CRAWL_MAX_PAGES', '5000'],
    ['FETCH_TIMEOUT_MS', '600000'],
    ['BATCH_CONCURRENCY', '64'],
    ['PORT', '70000'],
    ['MAX_LLM_CALLS_PER_KIT', '0'],
  ]) {
    const result = validateEnv(validEnv({ [name]: value }));
    assert.equal(result.ok, false, `${name}=${value} should be rejected`);
    assert.deepEqual(codesFor(result, name), ['CONFIG_OUT_OF_RANGE']);
  }
});

test('production must not permit private hosts', () => {
  const unsafe = validateEnv(validEnv({ NODE_ENV: 'production', ALLOW_PRIVATE_HOSTS: 'true' }));
  assert.equal(unsafe.ok, false);
  assert.deepEqual(codesFor(unsafe, 'ALLOW_PRIVATE_HOSTS'), ['CONFIG_SSRF_RISK']);

  const safe = validateEnv(validEnv({ NODE_ENV: 'production', ALLOW_PRIVATE_HOSTS: 'false' }));
  assert.equal(safe.ok, true);
  assert.equal(safe.config.retrieval.allowPrivateHosts, false);
  assert.equal(safe.config.isProduction, true);
});

test('the SSRF flag must be stated explicitly — NODE_ENV does not silently supply it', () => {
  // Deliberate: this flag decides whether a user-supplied URL can reach the deploy's
  // own network. Inferring it from NODE_ENV would mean a mistyped NODE_ENV quietly
  // opens the crawler, with nothing in the config file to show for it. The template
  // sets it on every environment, so requiring it costs nothing and removes a way to
  // be wrong by omission.
  const missing = validateEnv(validEnv({ ALLOW_PRIVATE_HOSTS: '' }));
  assert.equal(missing.ok, false);
  assert.deepEqual(codesFor(missing, 'ALLOW_PRIVATE_HOSTS'), ['CONFIG_MISSING']);

  // When it IS stated, it is obeyed in both directions.
  const offLocally = validateEnv(validEnv({ NODE_ENV: 'development', ALLOW_PRIVATE_HOSTS: 'false' }));
  assert.equal(offLocally.config.retrieval.allowPrivateHosts, false);

  const onLocally = validateEnv(validEnv({ NODE_ENV: 'development', ALLOW_PRIVATE_HOSTS: 'true' }));
  assert.equal(onLocally.config.retrieval.allowPrivateHosts, true);
});

test('the model split is off when the light model equals the main one', () => {
  const split = validateEnv(validEnv());
  assert.equal(split.config.gemini.modelLight, 'gemini-3.5-flash-lite');

  const disabledByEquality = validateEnv(validEnv({ GEMINI_MODEL_LIGHT: 'gemini-3.6-flash' }));
  assert.equal(disabledByEquality.config.gemini.modelLight, null, 'the template\'s way of disabling it');

  const disabledByAbsence = validateEnv(validEnv({ GEMINI_MODEL_LIGHT: '' }));
  assert.equal(disabledByAbsence.config.gemini.modelLight, null, 'and the other way');
});

test('the light model is held to the same stability rules as the main one', () => {
  const alias = validateEnv(validEnv({ GEMINI_MODEL_LIGHT: 'gemini-flash-lite-latest' }));
  assert.deepEqual(codesFor(alias, 'GEMINI_MODEL_LIGHT'), ['CONFIG_UNSTABLE_MODEL']);

  const retired = validateEnv(validEnv({ GEMINI_MODEL_LIGHT: 'gemini-2.0-flash-lite' }));
  assert.deepEqual(codesFor(retired, 'GEMINI_MODEL_LIGHT'), ['CONFIG_RETIRED_MODEL']);
});

test('a daily ceiling too small for one batch run is a warning, not a refusal', () => {
  const tight = validateEnv(validEnv({ GEMINI_RPD: '30' }));
  assert.equal(tight.ok, true, 'it degrades rather than fails');
  assert.deepEqual(tight.warnings.map((entry) => entry.code), ['CONFIG_BUDGET_TIGHT']);
  assert.match(tight.warnings[0].message, /60 requests/);
});

test('an unrecognised NODE_ENV warns rather than blocks', () => {
  const staging = validateEnv(validEnv({ NODE_ENV: 'staging' }));
  assert.equal(staging.ok, true);
  assert.deepEqual(staging.warnings.map((entry) => entry.code), ['CONFIG_UNKNOWN_ENVIRONMENT']);
  assert.equal(staging.config.isProduction, false, 'anything but production is local');
});

test('formatWarnings renders, and says the run continues', () => {
  assert.equal(formatWarnings([]), '');
  const { warnings } = validateEnv(validEnv({ SEARCH_API_KEY: '' }));
  const text = formatWarnings(warnings);
  assert.match(text, /CONFIG_DEGRADED_SEARCH/);
  assert.match(text, /proceed/);
});

test('loadConfigOrExit prints warnings without exiting', () => {
  const warned = [];
  let exited = false;
  const config = loadConfigOrExit(validEnv({ SEARCH_API_KEY: '' }), {
    onWarn: (text) => warned.push(text),
    exit: () => { exited = true; },
  });

  assert.equal(exited, false);
  assert.ok(config, 'a degraded configuration is still a configuration');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /no-op provider/);
});

test('an unknown search provider is named in the error', () => {
  const result = validateEnv(validEnv({ SEARCH_PROVIDER: 'bing' }));
  assert.deepEqual(codesFor(result, 'SEARCH_PROVIDER'), ['CONFIG_UNKNOWN_SEARCH_PROVIDER']);
});

test('numeric variables reject non-integers and non-positives', () => {
  for (const value of ['0', '-1', '2.5', 'five', '']) {
    const result = validateEnv(validEnv({ GEMINI_RPM: value }));
    assert.equal(result.ok, false, `GEMINI_RPM="${value}" should be rejected`);
  }
});

test('ALLOW_PRIVATE_HOSTS accepts only true or false', () => {
  assert.equal(validateEnv(validEnv({ ALLOW_PRIVATE_HOSTS: 'yes' })).ok, false);
  assert.equal(validateEnv(validEnv({ ALLOW_PRIVATE_HOSTS: 'FALSE' })).config.retrieval.allowPrivateHosts, false);
});

test('a typed-in session secret is rejected, a generated one is not', () => {
  const weak = validateEnv(validEnv({ SESSION_SECRET: 'change-me' }));
  assert.deepEqual(codesFor(weak, 'SESSION_SECRET'), ['CONFIG_WEAK_SECRET']);
  assert.equal(validateEnv(validEnv()).ok, true);
});

test('malformed MONGODB_URI and WEB_ORIGIN are caught', () => {
  const badUri = validateEnv(validEnv({ MONGODB_URI: 'localhost:27017' }));
  assert.deepEqual(codesFor(badUri, 'MONGODB_URI'), ['CONFIG_MALFORMED']);

  const badOrigin = validateEnv(validEnv({ WEB_ORIGIN: 'localhost:5173' }));
  assert.deepEqual(codesFor(badOrigin, 'WEB_ORIGIN'), ['CONFIG_MALFORMED']);
});

test('the optional light model is carried through when set', () => {
  const { config } = validateEnv(validEnv({ GEMINI_MODEL_LIGHT: 'gemini-3.5-flash-lite' }));
  assert.equal(config.gemini.modelLight, 'gemini-3.5-flash-lite');
});

test('formatProblems lists every variable and its code', () => {
  const { problems } = validateEnv({});
  const text = formatProblems(problems);
  assert.match(text, /GEMINI_MODEL/);
  assert.match(text, /CONFIG_MISSING/);
  assert.match(text, /\.env\.example/);
});

test('loadConfigOrExit exits with 1 and prints, instead of throwing', () => {
  const written = [];
  let exitCode = null;

  const config = loadConfigOrExit(
    {},
    { onError: (text) => written.push(text), exit: (code) => { exitCode = code; } }
  );

  assert.equal(config, null);
  assert.equal(exitCode, 1);
  assert.equal(written.length, 1);
  assert.match(written[0], /Configuration is invalid/);
});

test('loadConfigOrExit returns config and never exits on a good environment', () => {
  let exited = false;
  const config = loadConfigOrExit(validEnv(), { exit: () => { exited = true; } });

  assert.equal(exited, false);
  assert.equal(config.gemini.model, 'gemini-3.6-flash');
});
