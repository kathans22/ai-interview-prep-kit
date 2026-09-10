/**
 * extractRoleProfile.js — the human-readable facts about the role.
 *
 * Decides: title, seniority, responsibilities, company name and location, as the
 * posting states them. Fills role.title, role.seniority, role.responsibilities and the
 * readable parts of source.
 *
 * Does NOT decide: requirements (extractRequirements), anything about the company
 * beyond the name printed on the posting (summariseCompany), or what to do when a
 * field is absent.
 *
 * WHY THIS STEP EXISTS AT ALL. Without it the kit is structurally valid and hollow:
 * every field present, every field empty. A reviewer opening it sees a schema, not a
 * prep kit. It is one call for the difference between "" and "Senior Frontend Engineer,
 * remote across the UK".
 *
 * AN ABSENT FIELD COMES BACK AS AN EMPTY STRING, NEVER A GUESS. This is the rule the
 * prompt spends most of its words on, because the pressure runs the other way: a model
 * asked for a location will produce a plausible one, and "London" invented from a
 * British-sounding company name is indistinguishable from "London" that was printed on
 * the posting. The empty string is honest and the reader can see the gap. An invented
 * value is a quiet lie in a document someone will prepare from — and seniority is the
 * worst case, because it changes what questions get generated downstream.
 *
 * Responsibilities are what the role DOES; requirements are what the candidate must
 * BRING. The prompt separates them explicitly, because postings mix them freely and a
 * responsibility copied into the requirement list is a requirement with no evidence.
 */

import { completeStructured } from '../llm/json.js';
import { safePrompt } from '../llm/safePrompt.js';
import { object, arrayOf, str } from '../llm/schema.js';
import { badInput, invalidOutput, asGenerationError } from './errors.js';

const STEP = 'extract-role-profile';

/** More than this and the model is summarising the whole posting, not listing duties. */
const MAX_RESPONSIBILITIES = 8;

export const ROLE_PROFILE_SCHEMA = object({
  title: str('The job title exactly as the posting gives it. Empty string if unstated.'),
  seniority: str(
    'The seniority as the posting states it: junior, mid, senior, staff, principal, lead, or similar. Empty string if the posting does not say.'
  ),
  company: str('The hiring company name as printed on the posting. Empty string if unstated.'),
  location: str(
    'The location or work arrangement as stated, e.g. "Remote (UK)" or "Bristol, hybrid". Empty string if unstated.'
  ),
  responsibilities: arrayOf(
    str('One responsibility, phrased as something the person will DO in the role.'),
    'What the role involves day to day. Empty array if the posting does not describe duties.'
  ),
});

const SYSTEM_INSTRUCTION = [
  'You read a job posting and report five plain facts about the role.',
  '',
  'THE ONE RULE THAT MATTERS: if the posting does not state something, return an empty',
  'string for it — or an empty array for responsibilities. Never infer, never guess,',
  'never fill a field with what is typical for this kind of role.',
  '',
  '  Posting says "Senior Frontend Engineer (Remote, UK)"',
  '    title: "Senior Frontend Engineer"   seniority: "senior"   location: "Remote (UK)"',
  '',
  '  Posting says "Frontend Engineer" and never mentions where',
  '    title: "Frontend Engineer"   seniority: ""   location: ""',
  '    NOT seniority "mid" because the title has no qualifier.',
  '    NOT location "Remote" because most engineering roles are.',
  '',
  'seniority comes from the posting\'s own words — a title like "Senior X", or a line',
  'saying "this is a staff-level role". Years of experience are a REQUIREMENT, not a',
  'seniority: "5+ years" alone does not make the role senior.',
  '',
  'RESPONSIBILITIES ARE WHAT THE PERSON WILL DO, not what they must already have.',
  '  responsibility: "Own the operator console used by dispatchers"',
  '  requirement (do NOT list here): "5+ years with React"',
  'Phrase each as an action. Postings mix the two freely; separate them.',
].join('\n');

/** Coerce and check the model's answer, naming anything unusable. */
function validateProfile(answer) {
  if (!answer || typeof answer !== 'object') {
    throw invalidOutput(STEP, 'The model did not return a role profile object.');
  }

  const asString = (value, field) => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
      throw invalidOutput(STEP, `${field} must be a string, got ${typeof value}.`, { value });
    }
    return value.trim();
  };

  const responsibilities = Array.isArray(answer.responsibilities) ? answer.responsibilities : [];

  return {
    title: asString(answer.title, 'title'),
    seniority: asString(answer.seniority, 'seniority').toLowerCase(),
    company: asString(answer.company, 'company'),
    location: asString(answer.location, 'location'),
    responsibilities: responsibilities
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry !== '')
      .slice(0, MAX_RESPONSIBILITIES),
  };
}

/**
 * Extract the role profile from a job description.
 *
 * @param {string} jdText untrusted; routed through safePrompt
 * @param {object} options
 * @param {{ complete: Function }} options.provider
 * @param {() => void} [options.spend]
 * @param {(event: object) => void} [options.onRepair]
 * @returns {Promise<{
 *   title: string, seniority: string, company: string, location: string,
 *   responsibilities: string[], missing: string[]
 * }>} `missing` names the fields the posting did not state — the gap, made countable
 *   rather than left as a set of empty strings someone has to notice.
 */
export async function extractRoleProfile(jdText, { provider, spend, onRepair } = {}) {
  if (typeof jdText !== 'string' || jdText.trim() === '') {
    throw badInput(STEP, 'A job description is required.');
  }
  if (!provider || typeof provider.complete !== 'function') {
    throw badInput(STEP, 'A provider is required.');
  }

  const wrapped = safePrompt({ text: jdText.trim(), kind: 'jd', label: 'pasted job description' });

  let answer;
  try {
    answer = await completeStructured({
      provider,
      request: {
        systemInstruction: SYSTEM_INSTRUCTION,
        contents: wrapped.text,
        responseSchema: ROLE_PROFILE_SCHEMA,
      },
      step: STEP,
      spend,
      onRepair,
    });
  } catch (cause) {
    throw asGenerationError(cause, STEP);
  }

  const profile = validateProfile(answer);

  const missing = ['title', 'seniority', 'company', 'location'].filter(
    (field) => profile[field] === ''
  );
  if (profile.responsibilities.length === 0) missing.push('responsibilities');

  return { ...profile, missing };
}
