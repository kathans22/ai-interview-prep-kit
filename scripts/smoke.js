/**
 * smoke.js — the cheapest possible proof that a clean clone is wired correctly.
 *
 * Decides: whether the repository skeleton is intact — workspaces resolve, the root
 * scripts point at files that exist, and Node is new enough to run the project.
 *
 * Does NOT decide: whether any feature works. It performs no network calls, reads no
 * database and never touches Gemini, so it is safe to run any number of times against
 * a rate-limited free tier.
 *
 * Run with: npm run smoke
 */

import { access, readFile } from 'node:fs/promises';
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

async function main() {
  await checkNodeVersion();
  await checkPaths();
  await checkRootScripts();
  await checkWorkspaceLinks();

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
