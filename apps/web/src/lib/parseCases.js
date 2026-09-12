/**
 * parseCases.js — turn an uploaded JSON or CSV file into rows the batch endpoint accepts.
 *
 * Decides: how a file becomes a list of cases, and what is wrong with each row.
 *
 * Does NOT decide: whether the batch is submitted, or what happens to it afterwards. It
 * also decides nothing the server does not already check — the per-row rules come from
 * `validation.js`, so a row this file calls valid is a row the server's
 * `validateKitInput` accepts on the same grounds.
 *
 * WHY A REAL CSV PARSER AND NOT `split(',')`. The payload here is a job description.
 * Descriptions contain commas in almost every sentence, and quoted line breaks in any
 * file exported from a spreadsheet. `line.split(',')` would cut a single posting into
 * eight columns and report eight broken rows — or worse, produce rows that look
 * plausible and are built from fragments of the wrong posting. This is the one place in
 * this feature where being approximately right is indistinguishable from being wrong, so
 * the parser handles quoting properly: doubled quotes inside a quoted field, commas and
 * newlines inside quotes, and both CRLF and LF line endings.
 *
 * A BOM IS STRIPPED. Excel and Google Sheets both prefix exported CSV with U+FEFF, which
 * would otherwise become part of the first header name — so the file would parse, and
 * then report that its `id` column is missing while the header visibly says `id`.
 *
 * EVERY ROW GETS AN ANSWER. A file with one bad row out of five is four valid cases and
 * one explained problem, not a rejected file. The only fatal outcomes are the ones where
 * no rows can be recovered at all: unreadable JSON, or a CSV with no usable header.
 */

import { LIMITS, checkCompanyUrl, checkDays, checkJd } from './validation.js';

/** The column names the file must use. Named in the error when they are missing. */
export const COLUMNS = Object.freeze(['id', 'jd', 'company_url', 'days']);

/**
 * Split CSV text into rows of raw string fields.
 *
 * A character-by-character scan rather than a regular expression: quoting is a state,
 * and a pattern that tries to express "inside quotes" either fails on escaped quotes or
 * becomes unreadable. Exported for its own tests, because a parser nobody tested
 * directly is a parser that works on the one file it was written against.
 */
export function splitCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let index = 0;

  // Strip a byte-order mark before anything looks at the first character.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < input.length) {
    const char = input[index];

    if (quoted) {
      if (char === '"') {
        // A doubled quote is a literal quote; a single one closes the field.
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      endField();
      index += 1;
      continue;
    }
    if (char === '\r') {
      // CRLF or a lone CR both end the record.
      endRow();
      index += input[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // A trailing newline leaves an empty final field rather than an empty record.
  if (field !== '' || row.length > 0) endRow();

  // Drop records that are entirely empty — the blank line at the end of most files.
  return rows.filter((entry) => entry.some((value) => value.trim() !== ''));
}

/** Validate one case and describe everything wrong with it. */
function checkRow({ id, jd, companyUrl, days }, index, seenIds) {
  const problems = [];

  const jdResult = checkJd(jd);
  if (!jdResult.valid) problems.push(jdResult.reason);

  const urlResult = checkCompanyUrl(companyUrl);
  if (!urlResult.valid) problems.push(urlResult.reason);

  const daysResult = checkDays(days);
  if (!daysResult.valid) problems.push(daysResult.reason);

  // The id keys the result, so a duplicate makes two kits indistinguishable to whoever
  // reads the response. The server refuses it too; saying so here is cheaper.
  if (seenIds.has(id)) problems.push(`The id "${id}" is used by an earlier row — ids must be unique.`);

  return { index, id, jd: String(jd ?? ''), companyUrl: String(companyUrl ?? '').trim(), days, problems };
}

/**
 * Read an uploaded file's text into rows.
 *
 * @param {string} text  the file's contents
 * @param {string} name  the file name, used only to guess the format
 * @returns {{format: string, rows: object[], fatal: string|null, overflow: number}}
 */
export function parseCases(text, name = '') {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') {
    return { format: 'unknown', rows: [], fatal: 'That file is empty.', overflow: 0 };
  }

  // The content decides, not the extension: a `.txt` holding a JSON array is obviously
  // JSON, and a `.json` holding CSV is obviously not.
  const looksJson = trimmed.startsWith('[') || trimmed.startsWith('{');
  return looksJson ? fromJson(trimmed) : fromCsv(trimmed, name);
}

function fromJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      format: 'json',
      rows: [],
      // The parser's own message names the position, which is the only useful detail
      // when a file is nearly-valid JSON.
      fatal: `That file is not valid JSON — ${error.message}`,
      overflow: 0,
    };
  }

  const list = Array.isArray(parsed) ? parsed : parsed?.cases;
  if (!Array.isArray(list)) {
    return {
      format: 'json',
      rows: [],
      fatal: 'Expected a JSON array of cases, or an object with a "cases" array.',
      overflow: 0,
    };
  }

  return collect(
    list.map((entry, index) => ({
      id: typeof entry?.id === 'string' && entry.id.trim() !== '' ? entry.id.trim() : `case-${index + 1}`,
      jd: entry?.jd,
      companyUrl: entry?.company_url ?? entry?.companyUrl ?? '',
      // A numeric string is accepted here and normalised, because JSON written by hand
      // very often quotes numbers. The server requires a real integer, so the
      // conversion happens before it is sent, not after it is rejected.
      days: entry?.days === '' || entry?.days === undefined || entry?.days === null ? entry?.days : Number(entry.days),
    })),
    'json'
  );
}

function fromCsv(text, name) {
  const records = splitCsv(text);
  if (records.length === 0) {
    return { format: 'csv', rows: [], fatal: 'That file has no rows.', overflow: 0 };
  }

  const header = records[0].map((cell) => cell.trim().toLowerCase());
  const at = Object.fromEntries(COLUMNS.map((column) => [column, header.indexOf(column)]));

  // `jd` and `days` are the two the server cannot default. Without them there is no
  // case, so a header missing either is fatal for the file rather than per row.
  if (at.jd === -1 || at.days === -1) {
    return {
      format: 'csv',
      rows: [],
      fatal:
        `${name || 'That CSV'} needs a header row naming its columns. ` +
        `Expected ${COLUMNS.join(', ')} — "jd" and "days" are required.`,
      overflow: 0,
    };
  }

  const cell = (record, column) => (at[column] === -1 ? '' : (record[at[column]] ?? ''));

  return collect(
    records.slice(1).map((record, index) => {
      const rawId = cell(record, 'id').trim();
      const rawDays = cell(record, 'days').trim();
      return {
        id: rawId === '' ? `case-${index + 1}` : rawId,
        jd: cell(record, 'jd'),
        companyUrl: cell(record, 'company_url'),
        days: rawDays === '' ? '' : Number(rawDays),
      };
    }),
    'csv'
  );
}

/** Validate the collected rows and apply the batch cap. */
function collect(candidates, format) {
  const seenIds = new Set();
  const rows = [];

  // The cap is a quota guard, not a performance one: five kits is up to sixty model
  // calls against a small daily ceiling. Rows past it are REPORTED, not silently
  // dropped — a file that quietly loses its sixth row is worse than one that refuses.
  const kept = candidates.slice(0, LIMITS.maxBatchCases);
  const overflow = candidates.length - kept.length;

  kept.forEach((candidate, index) => {
    const row = checkRow(candidate, index, seenIds);
    seenIds.add(row.id);
    rows.push({ ...row, valid: row.problems.length === 0 });
  });

  return { format, rows, fatal: null, overflow };
}

/** The cases to send, in the shape the batch endpoint takes. */
export function toBatchPayload(rows) {
  return rows
    .filter((row) => row.valid)
    .map((row) => ({ id: row.id, jd: row.jd, company_url: row.companyUrl, days: Number(row.days) }));
}
