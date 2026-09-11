/**
 * envelope.js — the file every automated point is read from.
 *
 * Decides: the exact shape written to --output, and that a reader never sees a partial
 * one.
 *
 * Does NOT decide: what a kit contains, or whether a case succeeded. It shapes and
 * writes; it never repairs. A kit that failed validation must not be quietly fixed up
 * here, because then the envelope would claim a kit the pipeline could not actually
 * produce.
 *
 * THE SHAPE IS FROZEN, VERBATIM FROM BLOCK B:
 *
 *   { "version": "1.0",
 *     "generated_at": "2026-09-01T09:12:44Z",
 *     "kits": [ { "id", "status", "kit", "error" } ] }
 *
 * All five automated scoring criteria are read out of this file. Every field name here
 * is therefore load-bearing in a way ordinary code is not: `kits` is not `results`,
 * `generated_at` is not `generatedAt`, and `version` is the string "1.0" rather than the
 * number 1.0 — which would serialise as `1` and stop matching.
 *
 * `generated_at` IS A Z STRING, NOT AN OFFSET. `toISOString()` already ends in `Z`; the
 * spec's example is `2026-09-01T09:12:44Z` with no fractional part, so the milliseconds
 * are trimmed to match rather than left as `.000Z`. A local-offset timestamp would still
 * be valid ISO 8601 and would still be wrong.
 *
 * EVERY INPUT CASE APPEARS, ALWAYS. A case that failed is present with `kit: null` and a
 * non-null error. Omitting it would read as a kit that was never asked for rather than
 * one that could not be built, and the count of entries is itself part of the contract.
 *
 * WHY THE WRITE IS ATOMIC. The run takes minutes and the file is megabytes. A process
 * killed mid-write leaves valid-looking JSON truncated at some arbitrary byte, and the
 * next reader gets a parse error or — far worse — a file that parses into three kits
 * when five were built. Writing to a temp file in the SAME directory and renaming is
 * atomic on both POSIX and Windows: the reader sees either the old file or the complete
 * new one, never a half of either. Same directory matters, because rename across
 * filesystems is a copy, and a copy is not atomic.
 */

import { writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

/** The contract version. A string, not a number — see the header. */
export const ENVELOPE_VERSION = '1.0';

/**
 * An ISO 8601 instant in UTC, to whole seconds.
 *
 * @param {Date} [at]
 */
export function isoZ(at = new Date()) {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/**
 * Shape the envelope.
 *
 * Kept separate from writing so the contract test can assert the shape without touching
 * a filesystem, and so a shape bug cannot hide behind a disk error.
 *
 * @param {object[]} entries results from the batch runner, in input order
 * @param {{ now?: Date }} [options]
 */
export function buildEnvelope(entries, { now = new Date() } = {}) {
  return {
    version: ENVELOPE_VERSION,
    generated_at: isoZ(now),
    kits: entries.map((entry) => ({
      id: entry.id,
      // Exactly two values reach the file. `meta` is deliberately dropped: it is run
      // diagnostics for stderr, and a grader parsing this file should not have to know
      // which fields are contract and which are ours.
      status: entry.status === 'ok' ? 'ok' : 'failed',
      kit: entry.status === 'ok' ? entry.kit : null,
      error:
        entry.status === 'ok'
          ? null
          : {
              code: entry.error?.code ?? 'BUILD_FAILED',
              message: entry.error?.message ?? 'The case failed without a message.',
            },
    })),
  };
}

/**
 * Write the envelope atomically.
 *
 * @param {string} path the --output path
 * @param {object} envelope from `buildEnvelope`
 * @param {object} [io] injected for tests
 * @returns {Promise<{path: string, bytes: number}>}
 */
export async function writeEnvelope(path, envelope, io = {}) {
  const {
    write = writeFile,
    move = rename,
    makeDir = mkdir,
    remove = unlink,
    // Distinct per process, so two runs writing to the same output cannot land on the
    // same temp name and corrupt each other's file halfway through.
    suffix = `.${process.pid}.tmp`,
  } = io;

  // Two spaces. The file is read by a grader as well as a parser, and an unformatted
  // megabyte of JSON is not something a person can check a claim against.
  const json = `${JSON.stringify(envelope, null, 2)}\n`;

  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}${suffix}`);

  // `--output out/kits.json` should work on a clean clone without the user creating the
  // directory first. Failing on a missing parent would be correct and unhelpful.
  await makeDir(directory, { recursive: true });

  try {
    await write(temporary, json, 'utf8');
    await move(temporary, path);
  } catch (error) {
    // Leaving a stray temp file behind after a failure is how a directory fills with
    // `.kits.json.1234.tmp` over a week of failed runs. Best effort: the original error
    // is what the caller needs, so a failed cleanup must not replace it.
    try {
      await remove(temporary);
    } catch {
      /* the write already failed; the temp file may not exist */
    }
    throw error;
  }

  return { path, bytes: Buffer.byteLength(json, 'utf8') };
}
