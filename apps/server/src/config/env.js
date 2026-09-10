/**
 * env.js — reads and validates process environment into a typed config object.
 *
 * Decides: whether this process is configured well enough to run, what each variable
 * coerces to (integers as integers, booleans as booleans), and which combinations are
 * contradictory. It is the only place that touches process.env.
 *
 * Does NOT decide: anything about kits, retrieval, generation or scheduling. It also
 * does not read .env from disk — Node does that natively:
 *   node --env-file=.env apps/server/src/index.js
 * Keeping file loading out of here means no dotenv dependency and one honest source of
 * truth for what a valid configuration looks like.
 *
 * @aipk/core never reads env. Config is built here, in the adapter, and injected into
 * core — so core stays pure and testable without a environment fixture.
 */

/** Variables that must be present and non-empty in every environment. */
export const REQUIRED_VARS = [
  'MONGODB_URI',
  'SESSION_SECRET',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'GEMINI_RPM',
  'GEMINI_TPM',
  'GEMINI_RPD',
  'LLM_MAX_OUTPUT_TOKENS',
  'MAX_LLM_CALLS_PER_KIT',
  'CASE_SOFT_DEADLINE_MS',
  'SEARCH_PROVIDER',
  'ALLOW_PRIVATE_HOSTS',
  'PORT',
  'WEB_ORIGIN',
];

/** Present-but-optional variables, with the default applied when absent. */
export const OPTIONAL_VARS = {
  // Second, cheaper model for near-mechanical calls. Unset means one model for everything.
  GEMINI_MODEL_LIGHT: null,
};

const POSITIVE_INTEGER_VARS = [
  'GEMINI_RPM',
  'GEMINI_TPM',
  'GEMINI_RPD',
  'LLM_MAX_OUTPUT_TOKENS',
  'MAX_LLM_CALLS_PER_KIT',
  'CASE_SOFT_DEADLINE_MS',
  'PORT',
];

const BOOLEAN_VARS = ['ALLOW_PRIVATE_HOSTS'];

const SEARCH_PROVIDERS = ['tavily', 'none'];

/**
 * Model ids that must never be pinned. A -latest alias hot-swaps to whatever released
 * most recently — possibly a preview build — so an eval tuned today can describe a model
 * you are no longer calling tomorrow, and the README cannot name the model used.
 * Preview and experimental builds additionally carry tighter quotas and often require
 * billing, which contradicts keeping the project unbilled.
 */
const UNSTABLE_MODEL_SUFFIXES = ['-latest', '-preview', '-exp'];

/** Model families that are shut down and answer 404. Most tutorials still use them. */
const RETIRED_MODEL_PREFIXES = ['gemini-1.0', 'gemini-1.5', 'gemini-2.0'];

const MIN_SESSION_SECRET_LENGTH = 32;

function problem(name, code, message) {
  return { name, code, message };
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * Validate a raw environment bag. Pure: no I/O, no process access, no exit.
 *
 * @param {Record<string, string|undefined>} source
 * @returns {{ ok: boolean, config: object|null, problems: Array<{name:string,code:string,message:string}> }}
 */
export function validateEnv(source = {}) {
  const problems = [];

  for (const name of REQUIRED_VARS) {
    if (isBlank(source[name])) {
      problems.push(problem(name, 'CONFIG_MISSING', `${name} is required and is empty or unset.`));
    }
  }

  const numbers = {};
  for (const name of POSITIVE_INTEGER_VARS) {
    if (isBlank(source[name])) continue;
    const parsed = Number(source[name]);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      problems.push(
        problem(
          name,
          'CONFIG_NOT_A_POSITIVE_INTEGER',
          `${name} must be a positive integer, got "${source[name]}".`
        )
      );
      continue;
    }
    numbers[name] = parsed;
  }

  const booleans = {};
  for (const name of BOOLEAN_VARS) {
    if (isBlank(source[name])) continue;
    const raw = String(source[name]).trim().toLowerCase();
    if (raw !== 'true' && raw !== 'false') {
      problems.push(
        problem(
          name,
          'CONFIG_NOT_A_BOOLEAN',
          `${name} must be exactly "true" or "false", got "${source[name]}".`
        )
      );
      continue;
    }
    booleans[name] = raw === 'true';
  }

  const model = isBlank(source.GEMINI_MODEL) ? '' : String(source.GEMINI_MODEL).trim();
  if (model) {
    const unstable = UNSTABLE_MODEL_SUFFIXES.find((suffix) => model.endsWith(suffix));
    if (unstable) {
      problems.push(
        problem(
          'GEMINI_MODEL',
          'CONFIG_UNSTABLE_MODEL',
          `GEMINI_MODEL "${model}" ends in "${unstable}". Pin a specific stable model id: ` +
            'aliases hot-swap between releases, and preview/experimental builds carry ' +
            'tighter rate limits and often require billing.'
        )
      );
    }
    const retired = RETIRED_MODEL_PREFIXES.find((prefix) => model.startsWith(prefix));
    if (retired) {
      problems.push(
        problem(
          'GEMINI_MODEL',
          'CONFIG_RETIRED_MODEL',
          `GEMINI_MODEL "${model}" belongs to the ${retired} family, which is shut down and ` +
            'returns 404. Pin a current stable Flash model from Google AI Studio.'
        )
      );
    }
  }

  const provider = isBlank(source.SEARCH_PROVIDER)
    ? ''
    : String(source.SEARCH_PROVIDER).trim().toLowerCase();
  if (provider && !SEARCH_PROVIDERS.includes(provider)) {
    problems.push(
      problem(
        'SEARCH_PROVIDER',
        'CONFIG_UNKNOWN_SEARCH_PROVIDER',
        `SEARCH_PROVIDER must be one of ${SEARCH_PROVIDERS.join(' | ')}, got "${provider}".`
      )
    );
  }
  if (provider === 'tavily' && isBlank(source.SEARCH_API_KEY)) {
    problems.push(
      problem(
        'SEARCH_API_KEY',
        'CONFIG_MISSING',
        'SEARCH_API_KEY is required when SEARCH_PROVIDER=tavily. Set SEARCH_PROVIDER=none ' +
          'to run without a key — the search still executes and records an honest empty result.'
      )
    );
  }

  if (!isBlank(source.SESSION_SECRET)) {
    const secret = String(source.SESSION_SECRET);
    if (secret.length < MIN_SESSION_SECRET_LENGTH) {
      problems.push(
        problem(
          'SESSION_SECRET',
          'CONFIG_WEAK_SECRET',
          `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters. ` +
            'Generate one with: openssl rand -hex 32'
        )
      );
    }
  }

  if (!isBlank(source.MONGODB_URI)) {
    const uri = String(source.MONGODB_URI).trim();
    if (!uri.startsWith('mongodb://') && !uri.startsWith('mongodb+srv://')) {
      problems.push(
        problem(
          'MONGODB_URI',
          'CONFIG_MALFORMED',
          'MONGODB_URI must start with mongodb:// or mongodb+srv://.'
        )
      );
    }
  }

  if (!isBlank(source.WEB_ORIGIN)) {
    const raw = String(source.WEB_ORIGIN).trim();
    let parsed = null;
    try {
      parsed = new URL(raw);
    } catch (cause) {
      problems.push(
        problem('WEB_ORIGIN', 'CONFIG_MALFORMED', `WEB_ORIGIN must be an absolute URL: ${cause.message}`)
      );
    }
    // "localhost:5173" parses without throwing — URL reads "localhost:" as the scheme —
    // so the protocol has to be checked explicitly or a missing http:// slips through.
    if (parsed && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      problems.push(
        problem(
          'WEB_ORIGIN',
          'CONFIG_MALFORMED',
          `WEB_ORIGIN must start with http:// or https://, got "${raw}".`
        )
      );
    }
  }

  if (problems.length > 0) {
    return { ok: false, config: null, problems };
  }

  return {
    ok: true,
    problems: [],
    config: {
      mongodbUri: String(source.MONGODB_URI).trim(),
      sessionSecret: String(source.SESSION_SECRET),
      gemini: {
        apiKey: String(source.GEMINI_API_KEY).trim(),
        model,
        modelLight: isBlank(source.GEMINI_MODEL_LIGHT)
          ? OPTIONAL_VARS.GEMINI_MODEL_LIGHT
          : String(source.GEMINI_MODEL_LIGHT).trim(),
        rpm: numbers.GEMINI_RPM,
        tpm: numbers.GEMINI_TPM,
        rpd: numbers.GEMINI_RPD,
        maxOutputTokens: numbers.LLM_MAX_OUTPUT_TOKENS,
      },
      budgets: {
        maxLlmCallsPerKit: numbers.MAX_LLM_CALLS_PER_KIT,
        caseSoftDeadlineMs: numbers.CASE_SOFT_DEADLINE_MS,
      },
      retrieval: {
        searchProvider: provider,
        searchApiKey: isBlank(source.SEARCH_API_KEY) ? null : String(source.SEARCH_API_KEY).trim(),
        allowPrivateHosts: booleans.ALLOW_PRIVATE_HOSTS,
      },
      server: {
        port: numbers.PORT,
        webOrigin: String(source.WEB_ORIGIN).trim(),
      },
    },
  };
}

/**
 * Render problems as the message a human should see on a failed boot.
 * Separated from printing so it can be asserted in tests.
 */
export function formatProblems(problems) {
  const lines = ['Configuration is invalid. Fix these before starting:', ''];
  for (const { name, code, message } of problems) {
    lines.push(`  ${name}  [${code}]`);
    lines.push(`    ${message}`);
  }
  lines.push('', 'See .env.example for every variable and what it controls.');
  lines.push('Load a file with: node --env-file=.env <entry point>');
  return lines.join('\n');
}

/**
 * Boot-time entry point: validate or stop the process.
 * Side effects are injected so this is testable without killing the test runner.
 */
export function loadConfigOrExit(
  source = process.env,
  { onError = (text) => process.stderr.write(`${text}\n`), exit = (code) => process.exit(code) } = {}
) {
  const { ok, config, problems } = validateEnv(source);
  if (!ok) {
    onError(formatProblems(problems));
    exit(1);
    return null;
  }
  return config;
}
