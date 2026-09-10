#!/usr/bin/env node
/**
 * evaluate.js — entry point for the frozen batch command.
 *
 * Decides: how the process is invoked. It reads argv, prints usage, and (from a later
 * stage) hands --input / --output to the orchestrator in @aipk/core.
 *
 * Does NOT decide: anything about a kit. Not how a company is researched, how
 * requirements are extracted, how questions are generated, how the schedule is
 * allocated, or what counts as a failure. This file is a thin adapter — the same code
 * the HTTP API runs lives in @aipk/core, and this CLI is one more caller of it.
 *
 * Frozen contract (Block B, Contract 2), from the repo root of a clean clone:
 *   npm run evaluate -- --input <cases.json> --output <kits.json>
 */

const USAGE = `
evaluate — generate interview prep kits for a batch of cases

Usage:
  npm run evaluate -- --input <cases.json> --output <kits.json>

Options:
  --input <path>    JSON array of cases: { id, jd, company_url, days }
  --output <path>   where the results document is written
  -h, --help        show this message

Output shape:
  { "version": "1.0", "generated_at": "<ISO8601Z>", "kits": [ { id, status, kit, error } ] }
`;

const argv = process.argv.slice(2);

if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}

process.stdout.write(USAGE);
process.stderr.write(
  'evaluate: arguments accepted, but the batch pipeline is not wired yet (scaffold stage).\n'
);
process.exit(1);
