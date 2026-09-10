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

import { validateEnv, formatProblems, loadConfigOrExit } from '../src/config/env.js';

/** A minimal environment that should validate cleanly. */
function validEnv(overrides = {}) {
  return {
    MONGODB_URI: 'mongodb://127.0.0.1:27017/ai_interview_prep_kit',
    SESSION_SECRET: 'a'.repeat(64),
    GEMINI_API_KEY: 'test-key',
    GEMINI_MODEL: 'gemini-3.6-flash',
    GEMINI_RPM: '5',
    GEMINI_TPM: '100000',
    GEMINI_RPD: '200',
    LLM_MAX_OUTPUT_TOKENS: '8192',
    MAX_LLM_CALLS_PER_KIT: '12',
    CASE_SOFT_DEADLINE_MS: '150000',
    SEARCH_PROVIDER: 'tavily',
    SEARCH_API_KEY: 'tvly-test',
    ALLOW_PRIVATE_HOSTS: 'true',
    PORT: '4000',
    WEB_ORIGIN: 'http://localhost:5173',
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
  assert.equal(config.gemini.modelLight, null, 'the light model is optional');
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

test('a search key is required for tavily but not for none', () => {
  const withoutKey = validateEnv(validEnv({ SEARCH_API_KEY: '' }));
  assert.equal(withoutKey.ok, false);
  assert.deepEqual(codesFor(withoutKey, 'SEARCH_API_KEY'), ['CONFIG_MISSING']);

  const noProvider = validateEnv(validEnv({ SEARCH_PROVIDER: 'none', SEARCH_API_KEY: '' }));
  assert.equal(noProvider.ok, true, 'SEARCH_PROVIDER=none must run without a key');
  assert.equal(noProvider.config.retrieval.searchApiKey, null);
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
