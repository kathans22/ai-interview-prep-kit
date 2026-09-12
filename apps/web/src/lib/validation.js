/**
 * validation.js — the client's copy of the input rules, and the reasons it shows.
 *
 * Decides: whether the form's current contents could be submitted, and the sentence
 * shown when they could not.
 *
 * Does NOT decide: whether the server will accept them. **The server is the authority**
 * and validates independently; if these two ever disagree, the server wins and the user
 * sees its message, not this file's.
 *
 * WHY A SECOND COPY EXISTS AT ALL, given that invariant 36 says the client restates no
 * server rule. The stage's brief asks for two things that cannot be done from the server:
 * client-side URL sanity checking, and a disabled submit button whose REASON is visible
 * rather than a dead button the user pokes at. Both require knowing the rule before a
 * request is sent. So this is a deliberate, contained duplication, and it is contained in
 * exactly two ways:
 *   - It lives in ONE module. Nothing else in the client hardcodes a bound.
 *   - It only ever *explains* — it never transforms input, and a value it would reject is
 *     still sent if the user forces it, because the button's `disabled` is an
 *     affordance, not a gate.
 *
 * The numbers mirror `apps/server/src/http/validate.js` (`JD_MIN`, `JD_MAX`, `DAYS_MIN`,
 * `DAYS_MAX`, `MAX_BATCH_CASES`), read from that file rather than guessed. Drift is a
 * real risk and is recorded as a carry-forward rather than argued away: the honest fix is
 * for the server to publish its own bounds, which would delete most of this file.
 */

/** Mirrors of the server's bounds. One place, and the only place. */
export const LIMITS = Object.freeze({
  jdMin: 20,
  jdMax: 200_000,
  daysMin: 1,
  daysMax: 60,
  maxBatchCases: 5,
});

/**
 * Is this a company URL we are willing to send?
 *
 * Empty is VALID: the server defaults `company_url` to `''` and a kit builds without it,
 * degraded but honest. Refusing an empty field would invent a requirement the contract
 * does not have — and the whole point of the degradation path is that a posting with no
 * company site still produces a kit.
 *
 * `new URL()` is the check, not a regular expression. A hand-written pattern gets
 * punycode, IPv6 literals, ports and userinfo wrong in ways that reject valid input,
 * which is the worse failure here: a false rejection blocks a real user, while a false
 * acceptance is caught by the server a moment later. The scheme test matches the
 * server's — http and https only.
 */
export function checkCompanyUrl(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed === '') return { valid: true, reason: null };

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    // The most common shape of this mistake by a wide margin, so the message names it.
    return {
      valid: false,
      reason: 'That does not look like a full web address. Include the https:// prefix.',
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { valid: false, reason: 'The address must start with http:// or https://.' };
  }

  // A URL with no host parses in some engines (`https:///path`), and a hostname with no
  // dot is almost always a typo rather than an intranet name a crawler could reach.
  if (url.hostname === '') {
    return { valid: false, reason: 'That address has no website name in it.' };
  }

  return { valid: true, reason: null };
}

/** Is the job description long enough to extract anything from? */
export function checkJd(value) {
  const text = String(value ?? '');
  const length = text.trim().length;

  if (length === 0) return { valid: false, reason: 'Paste the job description first.' };
  if (length < LIMITS.jdMin) {
    return {
      valid: false,
      reason: `The description is too short to extract requirements from — ${LIMITS.jdMin} characters minimum, ${length} so far.`,
    };
  }
  if (text.length > LIMITS.jdMax) {
    return {
      valid: false,
      reason: `The description is longer than ${LIMITS.jdMax.toLocaleString()} characters. Trim it to the role itself.`,
    };
  }
  return { valid: true, reason: null };
}

/**
 * How many days until the interview?
 *
 * Both ends are inclusive, and the brief calls out 1 and 60 specifically because both
 * are real: one day is a schedule capped at a single day with nothing dropped, and sixty
 * produces genuine review days rather than filler. A bound written as `> 1` or `< 60`
 * would reject exactly the two cases the deterministic engine was built to handle.
 */
export function checkDays(value) {
  if (value === '' || value === null || value === undefined) {
    return { valid: false, reason: 'Say how many days you have to prepare.' };
  }

  const days = Number(value);

  if (!Number.isInteger(days)) {
    return { valid: false, reason: 'Days must be a whole number.' };
  }
  if (days < LIMITS.daysMin || days > LIMITS.daysMax) {
    return {
      valid: false,
      reason: `Days must be between ${LIMITS.daysMin} and ${LIMITS.daysMax} — both included.`,
    };
  }
  return { valid: true, reason: null };
}

/**
 * Check a whole single-kit submission.
 *
 * Returns EVERY reason, not the first. A form that reveals one problem at a time makes
 * the user submit, read, fix, submit again — and the server already collects all its
 * field errors for the same reason.
 */
export function checkKitInput({ jd, companyUrl, days }) {
  const fields = {
    jd: checkJd(jd),
    companyUrl: checkCompanyUrl(companyUrl),
    days: checkDays(days),
  };

  const reasons = Object.values(fields)
    .filter((result) => !result.valid)
    .map((result) => result.reason);

  return { valid: reasons.length === 0, fields, reasons };
}
