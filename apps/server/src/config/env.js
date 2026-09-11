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
 *
 * ERRORS STOP THE PROCESS; WARNINGS DO NOT. The distinction matters more than it looks.
 * A missing GEMINI_MODEL cannot be worked around and must stop boot. A missing search
 * key can: the search still runs against the no-op provider and records an honest empty
 * result, which is a documented, degraded-but-correct mode. Treating the second as fatal
 * would mean a fresh clone that copied .env.example verbatim refuses to start — the
 * template ships that key blank on purpose.
 */

/** Variables that must be present and non-empty in every environment. */
export const REQUIRED_VARS = [
  'NODE_ENV',
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
  'BATCH_CONCURRENCY',
  'IDEMPOTENCY_WINDOW_MS',
  'SEARCH_PROVIDER',
  'ALLOW_PRIVATE_HOSTS',
  'CRAWL_MAX_PAGES',
  'CRAWL_CONCURRENCY',
  'FETCH_TIMEOUT_MS',
  'FETCH_MAX_BYTES',
  'PORT',
  'WEB_ORIGIN',
];

/** Present-but-optional variables, with the default applied when absent. */
export const OPTIONAL_VARS = {
  // Second, cheaper model for near-mechanical calls. Unset — or set equal to
  // GEMINI_MODEL — means one model for everything.
  GEMINI_MODEL_LIGHT: null,
  // The light model's OWN daily ceiling. Every Gemini rate limit is per model, so the
  // split only buys quota if the second model is counted separately. Defaults to the
  // main model's RPD, which is conservative: a lite model usually allows more, so the
  // worst case is under-using it rather than over-running a limit we have not read.
  GEMINI_RPD_LIGHT: null,
  // Local fixture server port. Unused in production, so absence is not a fault.
  FIXTURE_PORT: 8099,
  // Crawl depth is the one crawl knob the template omits; core defaults to 2.
  CRAWL_MAX_DEPTH: 2,
};

/**
 * Integer variables and the range each must fall in.
 *
 * The ceilings are not decoration. A CRAWL_MAX_PAGES of 500 would blow the 150s case
 * deadline long before it blew anything else, and a FETCH_TIMEOUT_MS of ten minutes
 * would let one hanging route consume the entire batch window. Catching those at boot
 * is the difference between a clear message and a mystifying timeout an hour later.
 */
const INTEGER_VARS = Object.freeze({
  GEMINI_RPM: { min: 1, max: 10_000 },
  GEMINI_TPM: { min: 1_000, max: 100_000_000 },
  GEMINI_RPD: { min: 1, max: 10_000_000 },
  GEMINI_RPD_LIGHT: { min: 1, max: 10_000_000 },
  LLM_MAX_OUTPUT_TOKENS: { min: 256, max: 1_000_000 },
  MAX_LLM_CALLS_PER_KIT: { min: 1, max: 100 },
  CASE_SOFT_DEADLINE_MS: { min: 1_000, max: 900_000 },
  BATCH_CONCURRENCY: { min: 1, max: 16 },
  IDEMPOTENCY_WINDOW_MS: { min: 0, max: 86_400_000 },
  CRAWL_MAX_PAGES: { min: 1, max: 200 },
  CRAWL_CONCURRENCY: { min: 1, max: 16 },
  CRAWL_MAX_DEPTH: { min: 0, max: 6 },
  FETCH_TIMEOUT_MS: { min: 500, max: 120_000 },
  FETCH_MAX_BYTES: { min: 10_000, max: 100_000_000 },
  PORT: { min: 1, max: 65_535 },
  FIXTURE_PORT: { min: 0, max: 65_535 },
});

const BOOLEAN_VARS = ['ALLOW_PRIVATE_HOSTS'];

/** Anything other than "production" is treated as local, per the template. */
const KNOWN_ENVIRONMENTS = ['development', 'test', 'production'];

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
 * @returns {{
 *   ok: boolean,
 *   config: object|null,
 *   problems: Array<{name:string,code:string,message:string}>,
 *   warnings: Array<{name:string,code:string,message:string}>
 * }} `problems` stop boot; `warnings` describe a degraded but working configuration and
 *   are returned even on success, so a caller can print them without re-deriving them.
 */
export function validateEnv(source = {}) {
  const problems = [];
  const warnings = [];

  for (const name of REQUIRED_VARS) {
    if (isBlank(source[name])) {
      problems.push(problem(name, 'CONFIG_MISSING', `${name} is required and is empty or unset.`));
    }
  }

  const numbers = {};
  for (const [name, range] of Object.entries(INTEGER_VARS)) {
    if (isBlank(source[name])) {
      // Optional integers fall back to their documented default rather than to NaN.
      if (name in OPTIONAL_VARS) numbers[name] = OPTIONAL_VARS[name];
      continue;
    }

    const raw = String(source[name]).trim();
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
      problems.push(
        problem(name, 'CONFIG_NOT_AN_INTEGER', `${name} must be an integer, got "${raw}".`)
      );
      continue;
    }
    if (parsed < range.min || parsed > range.max) {
      problems.push(
        problem(
          name,
          'CONFIG_OUT_OF_RANGE',
          `${name} must be between ${range.min} and ${range.max}, got ${parsed}.`
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
  // A blank key is a WARNING, not an error. selectSearchProvider() falls back to the
  // no-op provider, which still runs the step and records an honest empty result —
  // "attempted and empty" scores, and only "never attempted" does not. Making this
  // fatal would stop a fresh clone that copied .env.example verbatim, since the
  // template ships this key blank on purpose.
  if (provider === 'tavily' && isBlank(source.SEARCH_API_KEY)) {
    warnings.push(
      problem(
        'SEARCH_API_KEY',
        'CONFIG_DEGRADED_SEARCH',
        'SEARCH_PROVIDER=tavily but SEARCH_API_KEY is blank. Public-discussion search ' +
          'will run against the no-op provider and record an empty result honestly. ' +
          'Get a free key at https://tavily.com to search for real.'
      )
    );
  }

  const environment = isBlank(source.NODE_ENV) ? '' : String(source.NODE_ENV).trim().toLowerCase();
  if (environment && !KNOWN_ENVIRONMENTS.includes(environment)) {
    warnings.push(
      problem(
        'NODE_ENV',
        'CONFIG_UNKNOWN_ENVIRONMENT',
        `NODE_ENV "${environment}" is not one of ${KNOWN_ENVIRONMENTS.join(' | ')}. ` +
          'Anything other than "production" is treated as local.'
      )
    );
  }

  // The SSRF gate, and the one combination that is dangerous rather than merely odd.
  // ALLOW_PRIVATE_HOSTS is explicit and always wins; NODE_ENV only supplies the default
  // when it is absent. In production, permitting private hosts turns the crawler into
  // an SSRF hole pointed at the deploy's own network, so it is refused outright rather
  // than warned about — a warning in a deploy log is a warning nobody reads.
  const allowPrivateHosts = isBlank(source.ALLOW_PRIVATE_HOSTS)
    ? environment !== 'production'
    : String(source.ALLOW_PRIVATE_HOSTS).trim().toLowerCase() === 'true';

  if (environment === 'production' && allowPrivateHosts) {
    problems.push(
      problem(
        'ALLOW_PRIVATE_HOSTS',
        'CONFIG_SSRF_RISK',
        'ALLOW_PRIVATE_HOSTS must be false when NODE_ENV=production. Permitting private, ' +
          'loopback and link-local addresses lets a supplied company URL reach the deploy\'s ' +
          'own network and cloud metadata service. It is true locally only so the fixture ' +
          'sites on localhost can be crawled.'
      )
    );
  }

  const modelLight = isBlank(source.GEMINI_MODEL_LIGHT)
    ? null
    : String(source.GEMINI_MODEL_LIGHT).trim();

  // The template's convention for turning the split off is "set it equal to
  // GEMINI_MODEL". Normalising that to null here means the provider has one thing to
  // check rather than two, and cannot accidentally treat "no split" as a split.
  const effectiveModelLight = modelLight && modelLight !== model ? modelLight : null;

  if (effectiveModelLight) {
    const unstableLight = UNSTABLE_MODEL_SUFFIXES.find((suffix) => effectiveModelLight.endsWith(suffix));
    if (unstableLight) {
      problems.push(
        problem(
          'GEMINI_MODEL_LIGHT',
          'CONFIG_UNSTABLE_MODEL',
          `GEMINI_MODEL_LIGHT "${effectiveModelLight}" ends in "${unstableLight}". Pin a specific stable model id.`
        )
      );
    }
    const retiredLight = RETIRED_MODEL_PREFIXES.find((prefix) => effectiveModelLight.startsWith(prefix));
    if (retiredLight) {
      problems.push(
        problem(
          'GEMINI_MODEL_LIGHT',
          'CONFIG_RETIRED_MODEL',
          `GEMINI_MODEL_LIGHT "${effectiveModelLight}" belongs to the ${retiredLight} family, which is shut down.`
        )
      );
    }
  }

  // Budget sanity: five cases at twelve calls is sixty requests, and a daily ceiling
  // below that cannot complete a single batch run. Worth saying at boot rather than
  // discovering at case four.
  if (Number.isInteger(numbers.GEMINI_RPD) && Number.isInteger(numbers.MAX_LLM_CALLS_PER_KIT)) {
    const oneBatch = numbers.MAX_LLM_CALLS_PER_KIT * 5;
    if (numbers.GEMINI_RPD < oneBatch) {
      warnings.push(
        problem(
          'GEMINI_RPD',
          'CONFIG_BUDGET_TIGHT',
          `GEMINI_RPD is ${numbers.GEMINI_RPD}, below the ${oneBatch} requests a five-case ` +
            'batch run can need. The run will degrade rather than fail, but it will degrade.'
        )
      );
    }
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

    // A URI with no database in its path is legal, and MongoDB quietly uses `test`.
    // That is how a production deployment ends up writing every user and every kit into
    // a database nobody meant to use and nobody thinks to back up — and it is invisible,
    // because everything works. A warning rather than a fatal: the URI is valid, and
    // refusing to boot over a default would be wrong.
    const path = uri.split('/').slice(3).join('/').split('?')[0];
    if (path === '') {
      warnings.push(
        problem(
          'MONGODB_URI',
          'CONFIG_NO_DATABASE_NAME',
          'MONGODB_URI names no database, so MongoDB will use "test". Add one before ' +
            'the query string, e.g. mongodb+srv://user:pass@host/ai_interview_prep_kit?retryWrites=true'
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
    return { ok: false, config: null, problems, warnings };
  }

  return {
    ok: true,
    problems: [],
    warnings,
    config: {
      env: environment,
      isProduction: environment === 'production',
      mongodbUri: String(source.MONGODB_URI).trim(),
      sessionSecret: String(source.SESSION_SECRET),
      gemini: {
        apiKey: String(source.GEMINI_API_KEY).trim(),
        model,
        // null when unset OR when set equal to the main model — one "no split" value.
        modelLight: effectiveModelLight,
        rpm: numbers.GEMINI_RPM,
        tpm: numbers.GEMINI_TPM,
        rpd: numbers.GEMINI_RPD,
        // Only meaningful when modelLight is set. Falls back to the main ceiling.
        rpdLight: numbers.GEMINI_RPD_LIGHT ?? numbers.GEMINI_RPD,
        maxOutputTokens: numbers.LLM_MAX_OUTPUT_TOKENS,
      },
      budgets: {
        maxLlmCallsPerKit: numbers.MAX_LLM_CALLS_PER_KIT,
        caseSoftDeadlineMs: numbers.CASE_SOFT_DEADLINE_MS,
        batchConcurrency: numbers.BATCH_CONCURRENCY,
        idempotencyWindowMs: numbers.IDEMPOTENCY_WINDOW_MS,
      },
      retrieval: {
        searchProvider: provider,
        searchApiKey: isBlank(source.SEARCH_API_KEY) ? null : String(source.SEARCH_API_KEY).trim(),
        allowPrivateHosts,
        crawlMaxPages: numbers.CRAWL_MAX_PAGES,
        crawlMaxDepth: numbers.CRAWL_MAX_DEPTH,
        crawlConcurrency: numbers.CRAWL_CONCURRENCY,
        fetchTimeoutMs: numbers.FETCH_TIMEOUT_MS,
        fetchMaxBytes: numbers.FETCH_MAX_BYTES,
      },
      fixtures: {
        port: numbers.FIXTURE_PORT,
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

/** Render warnings — a working configuration, with something worth knowing about it. */
export function formatWarnings(warnings) {
  if (warnings.length === 0) return '';
  const lines = ['Configuration warnings (the run will proceed, degraded):', ''];
  for (const { name, code, message } of warnings) {
    lines.push(`  ${name}  [${code}]`);
    lines.push(`    ${message}`);
  }
  return lines.join('\n');
}

/**
 * Boot-time entry point: validate or stop the process.
 * Side effects are injected so this is testable without killing the test runner.
 */
export function loadConfigOrExit(
  source = process.env,
  {
    onError = (text) => process.stderr.write(`${text}\n`),
    onWarn = (text) => process.stderr.write(`${text}\n`),
    exit = (code) => process.exit(code),
  } = {}
) {
  const { ok, config, problems, warnings } = validateEnv(source);

  // Warnings are printed whether or not boot succeeds: a degraded search key is worth
  // knowing about even in the run that also has a fatal fault.
  if (warnings.length > 0 && typeof onWarn === 'function') onWarn(formatWarnings(warnings));

  if (!ok) {
    onError(formatProblems(problems));
    exit(1);
    return null;
  }
  return config;
}
