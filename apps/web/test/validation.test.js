/**
 * validation.test.js — the client's input rules.
 *
 * These matter more than they look. The form's submit button is driven entirely by this
 * module, so a bound that is wrong by one blocks a legitimate submission with no way
 * around it — and the two bounds the brief names explicitly, 1 day and 60 days, are
 * exactly the ones an off-by-one would eat.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS, checkCompanyUrl, checkDays, checkJd, checkKitInput } from '../src/lib/validation.js';

const LONG_ENOUGH = 'Senior Frontend Engineer at Acme Logistics, React and mentoring.';

test('the mirrored bounds are the ones the server enforces', () => {
  // Read from apps/server/src/http/validate.js. If the server changes and this does not,
  // this assertion is the thing that should have failed first.
  assert.deepEqual(LIMITS, {
    jdMin: 20,
    jdMax: 200_000,
    daysMin: 1,
    daysMax: 60,
    maxBatchCases: 5,
  });
});

// --- job description --------------------------------------------------------

test('an empty description asks for one rather than reciting a bound', () => {
  const result = checkJd('');
  assert.equal(result.valid, false);
  assert.match(result.reason, /Paste the job description/);
});

test('a short description says how short it is', () => {
  const result = checkJd('Frontend dev');
  assert.equal(result.valid, false);
  assert.match(result.reason, /20 characters minimum, 12 so far/);
});

test('whitespace does not count towards the minimum', () => {
  assert.equal(checkJd(`     ${' '.repeat(40)}     `).valid, false);
});

test('a real posting passes', () => {
  assert.deepEqual(checkJd(LONG_ENOUGH), { valid: true, reason: null });
});

test('an over-long description is refused on its raw length, not its trimmed one', () => {
  // The maximum is about what gets sent over the wire; the minimum is about how much
  // meaningful text there is to extract from. They read different lengths on purpose.
  const result = checkJd('x'.repeat(LIMITS.jdMax + 1));
  assert.equal(result.valid, false);
  assert.match(result.reason, /longer than/);
});

// --- company url ------------------------------------------------------------

test('an empty company URL is VALID — a kit builds without one', () => {
  assert.deepEqual(checkCompanyUrl(''), { valid: true, reason: null });
  assert.deepEqual(checkCompanyUrl('   '), { valid: true, reason: null });
});

test('a bare hostname is refused, and the message names the fix', () => {
  const result = checkCompanyUrl('example.com');
  assert.equal(result.valid, false);
  assert.match(result.reason, /https:\/\//);
});

test('a non-http scheme is refused', () => {
  for (const value of ['ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd']) {
    assert.equal(checkCompanyUrl(value).valid, false, value);
  }
});

test('http and https both pass, with ports and paths', () => {
  for (const value of [
    'https://example.com',
    'http://example.com/careers',
    'http://localhost:8099/acme/',
    'https://example.co.uk:8443/a/b?c=d',
  ]) {
    assert.equal(checkCompanyUrl(value).valid, true, value);
  }
});

// --- days -------------------------------------------------------------------

test('BOTH ends of the range are allowed — 1 and 60 are the cases the brief names', () => {
  assert.equal(checkDays(1).valid, true);
  assert.equal(checkDays(60).valid, true);
  assert.equal(checkDays('1').valid, true);
  assert.equal(checkDays('60').valid, true);
});

test('just outside either end is refused', () => {
  assert.equal(checkDays(0).valid, false);
  assert.equal(checkDays(61).valid, false);
  assert.match(checkDays(61).reason, /both included/);
});

test('a fraction is refused — the allocator takes integers', () => {
  assert.equal(checkDays(2.5).valid, false);
  assert.match(checkDays(2.5).reason, /whole number/);
});

test('an empty field asks the question rather than reporting a type error', () => {
  assert.match(checkDays('').reason, /how many days/);
  assert.match(checkDays(null).reason, /how many days/);
});

// --- the whole submission ---------------------------------------------------

test('every reason is returned together, not one at a time', () => {
  const result = checkKitInput({ jd: 'too short', companyUrl: 'nope', days: 0 });

  assert.equal(result.valid, false);
  assert.equal(result.reasons.length, 3, 'a form that reveals one problem per submit wastes a round trip each time');
  assert.equal(result.fields.jd.valid, false);
  assert.equal(result.fields.companyUrl.valid, false);
  assert.equal(result.fields.days.valid, false);
});

test('a complete submission with no company URL is valid', () => {
  const result = checkKitInput({ jd: LONG_ENOUGH, companyUrl: '', days: 5 });
  assert.equal(result.valid, true);
  assert.deepEqual(result.reasons, []);
});
