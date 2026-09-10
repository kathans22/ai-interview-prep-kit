/**
 * ids.js — stable identifier generation for requirements, questions and flashcards.
 *
 * Decides: what the next unused id for a prefix is, and how an id string is parsed.
 * Ids are assigned ONCE and never renumbered: a question that cites r3 must keep citing
 * the same requirement after a later pass appends r7, and a schedule that cites q2 must
 * survive a second generation pass. Every function here is pure.
 *
 * Does NOT decide: when ids are assigned, what they are attached to, or whether the
 * references between them resolve — that is validateKit.js. It also never mutates the
 * collection it is given.
 *
 * The counter is derived from the ids that already exist rather than held in a module
 * variable, so two kits generated in one process can never contaminate each other's
 * numbering.
 */

import { ID_PREFIXES } from './kitSchema.js';

/** Matches a well-formed id: a lowercase letter prefix followed by a positive integer. */
const ID_PATTERN = /^([a-z]+)([1-9]\d*)$/;

/**
 * Split an id into its prefix and number.
 *
 * @param {string} id
 * @returns {{ prefix: string, number: number } | null} null when the id is malformed
 */
export function parseId(id) {
  if (typeof id !== 'string') return null;
  const match = ID_PATTERN.exec(id.trim());
  if (!match) return null;
  return { prefix: match[1], number: Number(match[2]) };
}

/**
 * True when `id` is a well-formed id, optionally for one specific prefix.
 *
 * @param {string} id
 * @param {string} [prefix]
 */
export function isValidId(id, prefix) {
  const parsed = parseId(id);
  if (!parsed) return false;
  return prefix === undefined ? true : parsed.prefix === prefix;
}

/**
 * The next unused id for a prefix.
 *
 * Takes the highest existing number for that prefix and adds one, so a gap left by a
 * removed item is never reused — reuse would silently repoint every reference to the
 * deleted item at its replacement.
 *
 * @param {string} prefix e.g. "r", "q", "f"
 * @param {Iterable<string>} [existingIds] ids already in use; other prefixes are ignored
 * @returns {string}
 */
export function nextId(prefix, existingIds = []) {
  if (typeof prefix !== 'string' || prefix === '') {
    throw new Error('IDS_INVALID_PREFIX: nextId requires a non-empty string prefix.');
  }

  let highest = 0;
  for (const candidate of existingIds) {
    const parsed = parseId(candidate);
    if (parsed && parsed.prefix === prefix && parsed.number > highest) {
      highest = parsed.number;
    }
  }

  return `${prefix}${highest + 1}`;
}

/**
 * A run of consecutive new ids. Useful when a batched generation call returns several
 * items at once and each needs an id before any of them is stored.
 *
 * @param {string} prefix
 * @param {number} count
 * @param {Iterable<string>} [existingIds]
 * @returns {string[]}
 */
export function nextIds(prefix, count, existingIds = []) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`IDS_INVALID_COUNT: nextIds requires a non-negative integer, got ${count}.`);
  }

  const taken = [...existingIds];
  const created = [];
  for (let index = 0; index < count; index += 1) {
    const id = nextId(prefix, taken);
    created.push(id);
    taken.push(id);
  }
  return created;
}

/**
 * Collect the ids from a list of objects that carry an `id` field.
 * Anything without a usable id is skipped rather than throwing — validateKit reports
 * malformed ids; this helper only gathers what is there.
 *
 * @param {Array<{id?: string}>} items
 * @returns {string[]}
 */
export function collectIds(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => item?.id).filter((id) => typeof id === 'string' && id !== '');
}

/**
 * The next id for a named collection, using the prefix registered in kitSchema so call
 * sites never spell "r", "q" or "f" themselves.
 *
 * @param {'requirement'|'question'|'flashcard'} collection
 * @param {Array<{id?: string}>} existingItems
 */
export function nextIdFor(collection, existingItems = []) {
  const prefix = ID_PREFIXES[collection];
  if (!prefix) {
    throw new Error(
      `IDS_UNKNOWN_COLLECTION: no id prefix registered for "${collection}". ` +
        `Known collections: ${Object.keys(ID_PREFIXES).join(', ')}.`
    );
  }
  return nextId(prefix, collectIds(existingItems));
}
