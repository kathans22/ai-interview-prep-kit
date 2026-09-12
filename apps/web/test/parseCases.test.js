/**
 * parseCases.test.js — the batch file parser.
 *
 * The CSV half carries almost all the risk in this feature. The payload is a job
 * description, so every realistic row contains commas, and a spreadsheet export contains
 * quoted line breaks and a byte-order mark. A parser that is approximately right here
 * does not fail loudly — it produces rows built from fragments of the wrong posting,
 * which then build a kit for a job nobody advertised.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { COLUMNS, parseCases, splitCsv, toBatchPayload } from '../src/lib/parseCases.js';
import { LIMITS } from '../src/lib/validation.js';

const JD = 'Senior Frontend Engineer at Acme Logistics. React, mentoring, five years.';

// --- the CSV scanner --------------------------------------------------------

test('a quoted field keeps its commas', () => {
  const rows = splitCsv('id,jd\r\nc1,"React, TypeScript, and mentoring"');
  assert.deepEqual(rows, [
    ['id', 'jd'],
    ['c1', 'React, TypeScript, and mentoring'],
  ]);
});

test('a quoted field keeps its newlines, so a multi-line description survives', () => {
  const rows = splitCsv('id,jd\nc1,"line one\nline two"\nc2,short');
  assert.equal(rows.length, 3);
  assert.equal(rows[1][1], 'line one\nline two');
  assert.equal(rows[2][1], 'short');
});

test('a doubled quote inside a quoted field is one literal quote', () => {
  const rows = splitCsv('jd\n"they said ""hello"" twice"');
  assert.equal(rows[1][0], 'they said "hello" twice');
});

test('CRLF, LF and a lone CR all end a record', () => {
  assert.equal(splitCsv('a\r\nb\nc\rd').length, 4);
});

test('a byte-order mark does not become part of the first header name', () => {
  // Excel and Google Sheets both write one. Without stripping it, the file parses and
  // then reports a missing `id` column while the header visibly says id.
  const rows = splitCsv('﻿id,jd\nc1,x');
  assert.equal(rows[0][0], 'id');
});

test('a trailing newline does not produce a phantom empty row', () => {
  assert.equal(splitCsv('id,jd\nc1,x\n').length, 2);
  assert.equal(splitCsv('id,jd\nc1,x\n\n\n').length, 2);
});

// --- CSV as cases -----------------------------------------------------------

test('a realistic CSV export parses into valid cases', () => {
  const csv = `id,jd,company_url,days\r\nc1,"${JD}",https://example.com,5\r\nc2,"${JD}",,1\r\n`;
  const result = parseCases(csv, 'roles.csv');

  assert.equal(result.format, 'csv');
  assert.equal(result.fatal, null);
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every((row) => row.valid), JSON.stringify(result.rows.map((r) => r.problems)));
  assert.equal(result.rows[1].companyUrl, '', 'an empty company URL is valid — a kit builds without one');
});

test('a CSV with no header for jd or days is fatal, and the message names the columns', () => {
  const result = parseCases('name,notes\nc1,hello', 'roles.csv');
  assert.equal(result.rows.length, 0);
  assert.match(result.fatal, /header row/);
  for (const column of COLUMNS) assert.match(result.fatal, new RegExp(column));
});

test('columns may be in any order, and an absent optional column is not fatal', () => {
  const result = parseCases(`days,jd,id\n5,"${JD}",c1`, 'roles.csv');
  assert.equal(result.fatal, null);
  assert.equal(result.rows[0].valid, true);
  assert.equal(result.rows[0].companyUrl, '');
});

test('one bad row does not reject the file — the rest stay usable', () => {
  const result = parseCases(`id,jd,company_url,days\nc1,"${JD}",https://a.com,5\nc2,tooshort,nope,0`, 'r.csv');

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].valid, true);
  assert.equal(result.rows[1].valid, false);
  assert.equal(result.rows[1].problems.length, 3, 'short description, bad URL and bad days are three separate problems');
});

test('a row with no id is given one, and it is visible rather than implied', () => {
  const result = parseCases(`id,jd,days\n,"${JD}",5`, 'r.csv');
  assert.equal(result.rows[0].id, 'case-1');
});

test('a duplicated id is flagged, because the id keys the result', () => {
  const result = parseCases(`id,jd,days\nsame,"${JD}",5\nsame,"${JD}",5`, 'r.csv');
  assert.equal(result.rows[0].valid, true);
  assert.equal(result.rows[1].valid, false);
  assert.match(result.rows[1].problems[0], /unique/);
});

test('rows past the cap are reported, not silently dropped', () => {
  const header = 'id,jd,days\n';
  const body = Array.from({ length: 7 }, (_, i) => `c${i},"${JD}",5`).join('\n');
  const result = parseCases(header + body, 'r.csv');

  assert.equal(result.rows.length, LIMITS.maxBatchCases);
  assert.equal(result.overflow, 2, 'a file that quietly loses a posting is worse than one that refuses');
});

// --- JSON as cases ----------------------------------------------------------

test('a JSON array parses, and so does an object with a cases array', () => {
  const cases = [{ id: 'c1', jd: JD, company_url: 'https://example.com', days: 5 }];

  for (const text of [JSON.stringify(cases), JSON.stringify({ cases })]) {
    const result = parseCases(text, 'roles.json');
    assert.equal(result.format, 'json');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].valid, true);
  }
});

test('the content decides the format, not the file extension', () => {
  const result = parseCases(JSON.stringify([{ id: 'c1', jd: JD, days: 5 }]), 'roles.txt');
  assert.equal(result.format, 'json');
});

test('days written as a numeric string is accepted and normalised', () => {
  // Hand-written JSON quotes numbers constantly. The server needs a real integer, so the
  // conversion happens before the request rather than after its rejection.
  const result = parseCases(JSON.stringify([{ id: 'c1', jd: JD, days: '5' }]), 'r.json');
  assert.equal(result.rows[0].valid, true);
  assert.equal(toBatchPayload(result.rows)[0].days, 5);
  assert.equal(typeof toBatchPayload(result.rows)[0].days, 'number');
});

test('invalid JSON is fatal and keeps the parser own message, which names the position', () => {
  const result = parseCases('[{"id": "c1",}]', 'r.json');
  assert.equal(result.rows.length, 0);
  assert.match(result.fatal, /not valid JSON/);
});

test('JSON that is neither an array nor a cases object says what was expected', () => {
  const result = parseCases('{"kits": []}', 'r.json');
  assert.match(result.fatal, /array of cases/);
});

test('an empty file is reported as empty rather than as a parse failure', () => {
  assert.match(parseCases('   ', 'r.csv').fatal, /empty/);
});

// --- the payload ------------------------------------------------------------

test('only valid rows are submitted, in the shape the endpoint takes', () => {
  const result = parseCases(`id,jd,company_url,days\nc1,"${JD}",https://a.com,5\nc2,bad,,0`, 'r.csv');
  const payload = toBatchPayload(result.rows);

  assert.equal(payload.length, 1);
  assert.deepEqual(Object.keys(payload[0]).sort(), ['company_url', 'days', 'id', 'jd']);
  assert.equal(payload[0].id, 'c1');
});
