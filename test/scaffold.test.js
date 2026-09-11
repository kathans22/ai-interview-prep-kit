/**
 * scaffold.test.js — proves the test runner is wired and the skeleton holds.
 *
 * Decides: whether `npm test` actually executes assertions, and whether the repository
 * still satisfies the structural promises the batch command depends on — workspaces
 * declared, root scripts defined, CLI entry point present.
 *
 * Does NOT decide: anything about kit content, retrieval or generation. Those get their
 * own tests next to the modules that own the behaviour.
 *
 * Runner: node:test + node:assert, no test dependency.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(relative) {
  return JSON.parse(await readFile(join(repoRoot, relative), 'utf8'));
}

test('the test runner runs assertions at all', () => {
  assert.equal(1 + 1, 2);
});

test('root manifest declares both workspace globs', async () => {
  const manifest = await readJson('package.json');
  assert.deepEqual(manifest.workspaces, ['packages/*', 'apps/*']);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.private, true);
});

test('root manifest defines every script the project promises', async () => {
  const { scripts } = await readJson('package.json');
  for (const name of ['evaluate', 'eval:extraction', 'smoke', 'dev:server', 'dev:web', 'test']) {
    assert.ok(scripts[name], `missing root script: ${name}`);
  }
});

test('the frozen batch command points at a file that exists', async () => {
  const { scripts } = await readJson('package.json');

  // The script may carry node flags (--env-file-if-exists=.env). The entry point is the
  // last token that is not a flag — stripping only a leading "node " would break the
  // moment a flag is added, which is a test failing for a reason unrelated to the thing
  // it is meant to protect.
  const entry = scripts.evaluate
    .split(/\s+/)
    .filter((token) => token !== 'node' && !token.startsWith('-'))
    .at(-1);

  assert.ok(entry, `could not find an entry point in "${scripts.evaluate}"`);
  await assert.doesNotReject(
    access(join(repoRoot, entry)),
    `root script "evaluate" points at ${entry}, which does not exist`
  );
});

test('every workspace manifest is private, ESM and namespaced', async () => {
  for (const relative of [
    'packages/core/package.json',
    'apps/server/package.json',
    'apps/web/package.json',
  ]) {
    const manifest = await readJson(relative);
    assert.equal(manifest.private, true, `${relative} must be private`);
    assert.equal(manifest.type, 'module', `${relative} must be ESM`);
    assert.match(manifest.name, /^@aipk\//, `${relative} must use the @aipk namespace`);
  }
});

test('no TypeScript configuration has crept in', async () => {
  await assert.rejects(
    access(join(repoRoot, 'tsconfig.json')),
    'tsconfig.json exists — this project is JavaScript only'
  );
});
