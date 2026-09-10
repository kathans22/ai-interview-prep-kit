/**
 * kitSchema.js — the frozen vocabulary of a kit.
 *
 * Decides: the exact spelling of every enum value, the difficulty range, the top-level
 * shape of a kit, and the id prefix for each collection. This is the single place those
 * literals exist.
 *
 * Does NOT decide: whether a given kit is valid (validateKit.js), how a kit is built
 * (emptyKit.js, the generation modules), or what any field should contain. It holds
 * names, not judgement.
 *
 * Why the spellings matter, since they look like typos and are not:
 *   - "behavioural" is British in BOTH requirement.kind and question.category.
 *   - "system-design" and "company-fit" are hyphenated, not underscored.
 *   - requirement.kind has no "system-design" value; that exists only on questions.
 * A renamed field or an Americanised enum is a hard contract failure, so nothing outside
 * this file may hardcode these strings — import them.
 */

/** requirement.kind — note "behavioural", and note that "system-design" is absent. */
export const REQUIREMENT_KINDS = Object.freeze(['technical', 'behavioural', 'domain']);

/** requirement.priority */
export const REQUIREMENT_PRIORITIES = Object.freeze(['must', 'nice']);

/** question.category — hyphenated compounds, British "behavioural". */
export const QUESTION_CATEGORIES = Object.freeze([
  'technical',
  'behavioural',
  'system-design',
  'company-fit',
]);

/** question.difficulty — inclusive integer range. */
export const DIFFICULTY_RANGE = Object.freeze({ min: 1, max: 3 });

/** Every top-level key a kit must carry. Extra keys are allowed; these are not optional. */
export const KIT_TOP_LEVEL_KEYS = Object.freeze([
  'source',
  'company_brief',
  'role',
  'questions',
  'flashcards',
  'schedule',
  'coverage',
]);

/**
 * Required keys per nested object. Kept beside the top-level list so a renamed field is
 * caught by the validator rather than discovered in the batch output.
 *
 * Note that source.role is a STRING (the role as advertised) and is a different field
 * from the top-level role OBJECT. They are not interchangeable.
 */
export const KIT_SECTION_KEYS = Object.freeze({
  source: Object.freeze([
    'company',
    'company_url',
    'role',
    'location',
    'jd_chars',
    'researched_at',
    'pages_used',
  ]),
  company_brief: Object.freeze(['summary', 'what_they_do', 'sources']),
  role: Object.freeze(['title', 'seniority', 'responsibilities', 'requirements']),
  requirement: Object.freeze(['id', 'text', 'kind', 'priority']),
  question: Object.freeze([
    'id',
    'requirement_ids',
    'category',
    'prompt',
    'answer_outline',
    'difficulty',
  ]),
  flashcard: Object.freeze(['id', 'front', 'back', 'requirement_ids']),
  schedule: Object.freeze(['days_available', 'days']),
  scheduleDay: Object.freeze(['day', 'focus', 'question_ids', 'minutes']),
  coverage: Object.freeze(['uncovered_requirement_ids', 'passes']),
});

/** Id prefixes per collection. Ids are stable within a kit and never renumbered. */
export const ID_PREFIXES = Object.freeze({
  requirement: 'r',
  question: 'q',
  flashcard: 'f',
});

/** The batch results document version, per Frozen Contract 2. */
export const KIT_CONTRACT_VERSION = '1.0';
