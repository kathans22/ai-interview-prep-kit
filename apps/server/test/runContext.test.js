/**
 * runContext.test.js — the collaborators the batch command and the server actually build.
 *
 * Decides: that `createRunContext` hands the orchestrator a search provider it can call,
 * and that a real case run through it records the public discussion search as ATTEMPTED.
 *
 * WHY THIS FILE EXISTS. `selectSearchProvider` was tested, `searchPublicDiscussion` was
 * tested, and the orchestrator's search step was tested with a provider passed in by hand.
 * The one line joining them — `createRunContext` — passed the selector's whole
 * `{ provider, degraded, reason }` record instead of the provider, so every real case, in
 * the batch command and in the server, recorded SEARCH_NOT_ATTEMPTED. Only a test at the
 * call site the adapters really use can catch that.
 *
 * Offline: the fixture provider answers the model steps, the company URL is empty so
 * nothing is crawled, and Tavily is replaced by an injected fetch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFixtureProvider } from '@aipk/core/llm/offlineProvider.js';
import { SEARCH_REASONS } from '@aipk/core/retrieval/searchPublicDiscussion.js';
import { validateKit } from '@aipk/core/contracts/validateKit.js';

import { validateEnv } from '../src/config/env.js';
import { createRunContext, runCase } from '../src/cli/runCase.js';

const CASE = {
  id: 'search-wiring',
  jd: [
    'Backend Engineer — Kestrel Payments (London)',
    '',
    'Requirements:',
    '• Deep expertise in Go',
    '• Postgres at scale, including partitioning',
  ].join('\n'),
  company_url: '',
  days: 3,
};

function config(overrides) {
  const result = validateEnv({
    NODE_ENV: 'development', PORT: '4000', WEB_ORIGIN: 'http://localhost:5173',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/unused', SESSION_SECRET: 's'.repeat(64),
    GEMINI_API_KEY: 'unused', GEMINI_MODEL: 'offline-fixture',
    // The maxima the validator permits: nothing here calls Google, so nothing should wait.
    GEMINI_RPM: '10000', GEMINI_TPM: '100000000', GEMINI_RPD: '1000000',
    LLM_MAX_OUTPUT_TOKENS: '2048', MAX_LLM_CALLS_PER_KIT: '12', CASE_SOFT_DEADLINE_MS: '150000',
    BATCH_CONCURRENCY: '1', IDEMPOTENCY_WINDOW_MS: '900000', ALLOW_PRIVATE_HOSTS: 'true',
    CRAWL_MAX_PAGES: '12', CRAWL_CONCURRENCY: '3', FETCH_TIMEOUT_MS: '8000', FETCH_MAX_BYTES: '2000000',
    ...overrides,
  });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  return result.config;
}

const searchNotes = (kit) => kit.run_notes.filter((note) => /public discussion search/i.test(note));

test('the run context passes a callable search provider, not the selection record', () => {
  for (const [provider, key] of [['none', ''], ['tavily', ''], ['tavily', 'tvly-test']]) {
    const context = createRunContext({
      config: config({ SEARCH_PROVIDER: provider, SEARCH_API_KEY: key }),
      provider: createFixtureProvider(),
    });
    assert.equal(typeof context.searchProvider?.search, 'function', `${provider} / key "${key}"`);
    assert.equal(context.searchProvider, context.searchSelection.provider);
  }
});

test('with no search key, a real case still ATTEMPTS the search and records it as empty', async () => {
  const context = createRunContext({
    config: config({ SEARCH_PROVIDER: 'tavily', SEARCH_API_KEY: '' }),
    provider: createFixtureProvider(),
  });
  assert.equal(context.searchSelection.degraded, true, 'no key is a degraded selection, said out loud');

  const entry = await runCase(CASE, context);

  assert.equal(entry.status, 'ok');
  assert.equal(validateKit(entry.kit).valid, true);
  assert.deepEqual(searchNotes(entry.kit), [
    `Public discussion search ran and found nothing (${SEARCH_REASONS.EMPTY}).`,
  ]);
});

test('with a key, a real case sends the search to Tavily and uses what comes back', async () => {
  const requests = [];
  const searchFetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return new Response(
      JSON.stringify({
        results: [
          { title: 'Kestrel Payments interview', url: 'https://example.com/kestrel', content: 'Two rounds and a take-home.' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  const context = createRunContext({
    config: config({ SEARCH_PROVIDER: 'tavily', SEARCH_API_KEY: 'tvly-test' }),
    provider: createFixtureProvider(),
    searchFetchImpl,
  });
  const entry = await runCase(CASE, context);

  assert.equal(entry.status, 'ok');
  assert.equal(requests.length, 1, 'exactly one search request');
  assert.match(requests[0].body.query, /Kestrel Payments/);
  assert.equal(requests[0].body.api_key, 'tvly-test');
  assert.deepEqual(searchNotes(entry.kit), [], 'a search that found results leaves no gap note');
});
