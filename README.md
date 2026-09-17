# AI Interview Prep Kit

Paste a job description and a company URL. The app reads the posting and the company's own
website, and builds an interview preparation kit. The kit includes:
- the role's requirements, each quoted from the posting
- questions that cover every requirement, across four categories
- flashcards, and a day-by-day schedule sized to the days you have
- a company brief built only from pages it actually fetched

Edit the kit by hand, regenerate a section without losing your edits, and practise.

The same pipeline runs from a batch command that turns a file of cases into a file of kits.

**Contents**

1. [Overview and tech stack](#1-overview-and-tech-stack)
2. [Setup — local, deployed, and the batch command](#2-setup)
3. [Gemini: model, limits and SDK](#3-gemini-model-limits-and-sdk)
4. [Architecture](#4-architecture)
5. [Retrieval](#5-retrieval)

---

## 1. Overview and tech stack

| Layer | Choice |
|---|---|
| Web client | React 18.3, Vite 8, Tailwind CSS 4 (CSS-first, no config file), React Router 7 |
| API | Node.js (20.19+ or 22.12+), Express 5, Mongoose 9 on MongoDB Atlas, bcryptjs |
| Pipeline | `packages/core` — plain ES modules, no framework |
| Model | Gemini `gemini-3.5-flash-lite`, through `@google/genai` 2.x |
| Search | Tavily (optional); without a key the search step records an honest empty result |
| Tests | `node:test` and `node:assert`, no test dependencies — `npm test`, 664 tests |

The repository is an npm workspace with three packages:

```
packages/core   the one implementation: contracts, deterministic engines, retrieval,
                generation, orchestration, practice ordering, answer scoring
apps/server     Express API and the batch command — two thin adapters over core
apps/web        React client — talks only to the API
```

### Why React + Vite, not Next.js

**This is a single-page, authenticated tool.** Every screen is behind a login and shows
one person's kits. Nothing on it is public, so there is nothing to index and nothing to
render on the server. Next.js earns its complexity through server rendering, SEO and
server-side data fetching, and none of those has anything to do here.

**One integration path per kind of caller.** Both of the pipeline's callers are thin
adapters over `packages/core`:
- the batch command calls `buildKit` directly
- the API calls `buildKit` for the browser

The Vite app is a **pure client of that API**. Exactly one module, `apps/web/src/lib/api.js`,
calls `fetch`, and the client never imports `@aipk/core`. With Next.js, server components
and route handlers become a second server-side caller of the same logic. That second path
would need its own session handling, its own rate limiting and its own copy of the
revision rules. It would drift from the API, and the batch command could not exercise it.

**The work is long-running, not request-shaped.** A kit takes 30 to 150 seconds to build,
in the background, with progress streamed to the page. That needs a long-lived Node
process holding a job runner, a limiter shared across builds, and an event stream. A Vite
build is static files next to that one process, and it deploys to any free static host.

### Why JavaScript, not TypeScript

**The data that matters is checked at runtime anyway.** Every kit crosses a frozen JSON
contract, and most of its content comes from a language model and from web pages. A
compile-time type cannot validate a model's answer or a crawled page. So `validateKit` and
`verifySchedule` check every kit at runtime, response schemas constrain every model call,
and the API validates every request body. Types would have duplicated those checks, not
replaced them.

**No build step between a clean clone and the batch command.** `npm run evaluate` runs the
source directly on Node. The pipeline, the server and the command need no compiler, no
`ts-node` and no generated output that could go stale.

**The cost is real, and it is paid in tests.** Exported functions carry JSDoc, and contract
tests hold the two sides of every boundary together: the client's mirrored input limits,
the regeneration preview, the scorer's length bounds, and `render.yaml` against
`.env.example`.

---

## 2. Setup

Node **20.19+ or 22.12+** (Vite 8 and Mongoose 9 need it) and npm.

### 2.1 Install

```bash
git clone https://github.com/kathans22/ai-interview-prep-kit.git
cd ai-interview-prep-kit
npm install
cp .env.example .env
```

`npm install` at the root installs all three workspaces from the one lockfile. `.env.example`
documents every variable and what it controls. Only three values are secrets:
`SESSION_SECRET` (generate one with `openssl rand -hex 32`), `GEMINI_API_KEY`, and the
optional `SEARCH_API_KEY`.

### 2.2 The batch command

The command:

```bash
npm run evaluate -- --input <cases.json> --output <kits.json>
```

Input is a JSON array of `{ id, jd, company_url, days }`. The output is:

```json
{ "version": "1.0", "generated_at": "<ISO8601Z>", "kits": [ { "id", "status", "kit", "error" } ] }
```

A case's `status` is `ok` whenever a kit was produced, including a degraded kit whose gaps
are recorded in `kit.run_notes`. It is `failed` only when no kit could be produced. The
exit code is non-zero only when no case produced a kit, or when the arguments are wrong.

**A working example, with no API key, no database and no quota.** The five sample cases
point at local fixture sites: a normal site, a thin posting, no hiring page, a dead URL,
and a prompt-injection page. Start the fixture server in one terminal:

```bash
node fixtures/serve.js
```

Then, in another:

```bash
npm run evaluate -- --input fixtures/cases.sample.json --output kits.json --fake
```

```
[case-01-normal] (1/5) 5 day(s) · http://localhost:8099/acme/
  ✓ case-01-normal ok in 0.6s — 6 requirements, 22 questions, 5 day schedule, …
…
5 case(s): 5 ok, 0 failed · 1.1s total · 40 model call(s) spent
Wrote … bytes to kits.json
```

`--fake` swaps in a deterministic offline provider that derives its answers from the input.
Everything else is the real pipeline: the crawl, the evidence check, coverage, the
schedule and both validators. The run needs no `.env`.

**The same command against Gemini:** set `GEMINI_API_KEY` in `.env` and drop `--fake`.
Measured on 2026-09-12, the five sample cases took **167 seconds and 39 requests**, and
all five kits were valid. The batch command never connects to MongoDB.

### 2.3 Running the app locally

Needs a MongoDB connection string in `.env`: a free Atlas cluster, or a local `mongod`.

```bash
npm run dev:server     # API on http://localhost:4000, reading the root .env
npm run dev:web        # client on http://localhost:5173, proxying /api to the API
```

Open <http://localhost:5173>, register, and create a kit.

`npm test` runs the whole suite offline in about 15 seconds. It needs no key, no database
and no network, and that was checked from a fresh clone with every outbound connection
refused. The one skipped test is the MongoDB half of the store contract, which runs when
`MONGODB_URI` is set.

`npm run smoke` runs the whole pipeline offline and prints 31 checks. `npm run
eval:extraction -- --offline` re-scores the extraction eval from its committed cache
(§11).

### 2.4 Deployed

Both halves run on free tiers:

```
browser ──https──▶ Netlify  (static web client, and a proxy for /api/*)
                       │
                       └──https──▶ Render  (Express API, background kit builds)
                                      ├──TLS──▶ MongoDB Atlas  (free M0 cluster)
                                      └──https─▶ Gemini API    (unbilled project)
```

The committed configuration is `render.yaml` for the API and `netlify.toml` for the web
client. `test/deploy.test.js` checks `render.yaml` against `.env.example`:
- every variable in the template is declared
- production values are the safe ones
- no secret is committed

**Why the web client proxies `/api`.** The API is configured for a genuinely cross-origin
client:
- CORS allows exactly one origin, with credentials.
- In production the session cookie is `HttpOnly; Secure; SameSite=None`.

But Safari on iPhone, and any browser that blocks third-party cookies, throws away a
cross-site cookie. Sign-in would appear to work, and every request after it would fail
with 401. So the static site proxies `/api/*` to the API. To the browser the API is then
same-origin, and the cookie is first-party everywhere. Setting `VITE_API_BASE` instead of
`API_ORIGIN` calls the API directly, which works in browsers that allow cross-site cookies.

`SameSite=None` gives up the cross-site request protection that `Lax` provided. To restore
it, the API refuses any state-changing request whose `Origin` names another site, with
`403 ORIGIN_NOT_ALLOWED`.

**1. MongoDB Atlas.**
- Create a free M0 cluster.
- Add a database user used only by this app, with a long generated password and the role
  `readWrite` on `ai_interview_prep_kit` only.
- **Network access** cannot be restricted by address, because Render's free services have
  no fixed outbound IPs. The allowlist entry is `0.0.0.0/0`. Access is restricted by what
  a connection needs instead: that one least-privilege user and its password, over TLS
  (Atlas refuses unencrypted connections), to one database.
- Remove any development users and allowlist entries.
- On a paid Render plan with static outbound IPs, replace `0.0.0.0/0` with those addresses.
- Put the database name in the connection string. Without it MongoDB silently uses `test`,
  and the server warns at boot.

**2. Gemini.** Create a key at <https://aistudio.google.com/apikey>, and keep its Google
Cloud project **unbilled** (§3).

**3. Netlify (the web client).**
- Import the repository. `netlify.toml` supplies the build: `npm run build:web` from the
  root, publishing `apps/web/dist`, on Node 22.
- Choose the site name.
- The first build **fails on purpose**. There is no API to point at yet, and a site that
  cannot reach its API should not be published.

**4. Render (the API).**
- New → Blueprint → this repository. It creates one free web service: `npm ci --omit=dev`,
  then `npm start`, with health check `/api/health`.
- Render asks for the values that are never committed:
  - `WEB_ORIGIN`: the Netlify address, exactly
  - `MONGODB_URI`
  - `GEMINI_API_KEY`
  - `SEARCH_API_KEY`: optional
- `SESSION_SECRET` is generated by Render, and `PORT` is injected.
- **`ALLOW_PRIVATE_HOSTS` is `false`.** With `NODE_ENV=production`, the server refuses to
  boot if it is `true` (§5).

**5. Connect them.**
- On Netlify, set `API_ORIGIN` to `https://<service>.onrender.com` and redeploy.
- `https://<site>.netlify.app/api/health` should return `{"ok":true,"env":"production",…}`.
  That request travelled through the proxy to the API.

**Cold starts on the free tier.** The API sleeps after 15 minutes without traffic, and the
next request waits while Render starts it again: typically 30 to 60 seconds. On a phone
this looks like a sign-in button that does nothing for a while. It is not broken:
- If the first page load or sign-in fails with a gateway error, the proxy gave up before
  the API woke. Wait a minute and try again; the second attempt is fast.
- To avoid it before a demo, open `/api/health` a minute beforehand.
- Once awake, the service stays awake while it is used. Watching a build counts.
- A build running when the service restarts is marked **interrupted** at the next boot,
  and can be continued from its page.

**Free-tier limits worth knowing:**
- Render: 750 instance hours a month.
- Netlify: 300 build minutes a month. Proxied requests are time-limited; the progress
  screen survives that by falling back from its event stream to polling.
- Atlas M0: 512 MB of storage.
- Gemini: see §3.

---

## 3. Gemini: model, limits and SDK

| | |
|---|---|
| Model | **`gemini-3.5-flash-lite`**, pinned. Never a `-latest` alias: an alias can switch to a preview build with tighter limits. The server refuses to boot on `-latest`, `-preview` or `-exp`. |
| Limits designed against | **15 requests/minute, 250,000 input tokens/minute, 500 requests/day** — read from the AI Studio rate-limit page on 2026-09-11 |
| SDK | **`@google/genai` `^2.21.0`**, which keeps it below 3.0 |
| Calls per kit | at most **12**; the normal path is 11 (§12) |

**The limits are per Google Cloud project, per model — not per key.** A second key in the
same project adds nothing. The daily ceiling resets at midnight Pacific time.

**The project is deliberately unbilled.** Enabling billing on a Cloud project removes its
free tier: from then on every request is charged from the first token. This app is
designed to live inside the free allowance and degrade when it runs out (§12). It must
never be turned into a paid service by a setting nobody noticed.

**The model was chosen on measurement, not size.** The project started on
`gemini-3.6-flash`, whose free tier allows **5 requests a minute and 20 a day**. The whole
pipeline was designed against that ceiling:
- the 12-call budget per kit
- one call per question category rather than per requirement (§7)
- the committed eval cache (§11)
- the offline provider behind `--fake`

A five-case batch run needs about 40 requests, twice that model's entire day. Switching to
`gemini-3.5-flash-lite` gave 25 times the daily quota, and the extraction eval scored it
better: must-precision rose from 90% to 100%, with recall, priority accuracy, drops and
inventions unchanged. Both models' eval caches are committed.

**Pacing happens in code, before a request is sent.** One limiter per model tracks
requests per minute, tokens per minute and requests per day, and it is shared by every
build in the process:
- **Admission happens inside the retry loop**, so a retried request is counted as the new
  request it is.
- **Requests are spaced evenly** at 60/RPM seconds. They are not allowed out as a burst,
  because a full bucket released at once breaks Google's rolling one-minute window even
  when the configured number is right.
- **Per-minute limits are waited out.** A 429 is retried with exponential backoff, and a
  `Retry-After` header wins over the computed delay.
- **The daily limit is refused**, before the request is sent, so the build degrades
  instead of waiting until midnight.
- **Every limit must match the model.** A limit set higher than the model's real one
  raises no error: requests go out until Google refuses them, and each refusal costs a
  retry.

**Why `^2.21.0` and not 3.x.** The 3.x line requires Node 22. The grading contract is a clean
clone on someone else's machine, and the project supports Node 20.19+. The 2.x line runs on
Node 20, 22 and 24 with the same call shape (`GoogleGenAI` → `ai.models.generateContent` →
`response.text`), and nothing in 3.x is needed here.

---

## 4. Architecture

```
                 ┌──────────────────────── apps/web ────────────────────────┐
  browser ──────▶│ React SPA · lib/api.js is the only fetch() · no core import│
                 └───────────────────────────┬───────────────────────────────┘
                                             │ JSON over HTTP, session cookie
                 ┌────────────── apps/server ▼───────────────┐   ┌── apps/server/src/cli ──┐
                 │ Express routes: auth, kits, edit (PATCH),  │   │ npm run evaluate        │
                 │ regenerate/undo, progress (SSE + poll),    │   │ args → runBatch → envelope
                 │ practice, score · in-process job runner    │   │                         │
                 │ memoryStore / mongoStore (one contract)    │   │                         │
                 └──────────────────────┬─────────────────────┘   └────────────┬────────────┘
                                        │ buildKit(input, deps, hooks)          │ buildKit(…)
                 ┌──────────────────────▼────────── packages/core ─────────────▼────────────┐
                 │ orchestrator  buildKit · research · coverageLoop · timeGovernor ·        │
                 │               checkpoints · assemble                                     │
                 │ retrieval     urlGuard · fetchPage · robots · clean · crawl ·            │
                 │               findHiringPage · searchPublicDiscussion · sourceLedger     │
                 │ generation    extractRequirements · extractRoleProfile · summariseCompany│
                 │               extractHiringProcess · routeCategories · generateQuestions │
                 │               fillGaps · generateFlashcards                              │
                 │ deterministic coverage · scheduleAllocator · verifySchedule ·            │
                 │               verifyEvidence                                             │
                 │ contracts     kitSchema · validateKit · emptyKit · ids · provenance ·    │
                 │               merge                                                      │
                 │ llm           provider · json (parse + repair) · retry · limiter ·      │
                 │               budget · safePrompt · schema · fake + offline providers    │
                 │ practice      orderCards          scoring   scoreAnswer · weakSpots      │
                 └──────────────────────────────────────────────────────────────────────────┘
```

**Why `packages/core` is shared, not duplicated.** The brief's batch command must run *the
same code the application uses*. That is only true if there is one implementation, so
`buildKit` is the single function that produces a kit:
- `POST /api/kits` records the request, answers `202` with a kit id, and hands `buildKit` to
  the job runner.
- `npm run evaluate` calls `buildKit` once per case.

Neither adapter contains pipeline logic. They supply collaborators (a provider, a fetcher,
a limiter, a store) and translate the result. The alternative, a route and a script that
each assemble the steps, drifts within a stage. A fix to the crawl lands in one and not
the other, and the graded batch output no longer describes the app anyone uses. With one
function the claim is structural, and a test of `buildKit` tests both.

**Everything is injected.** `buildKit` takes its provider, fetcher, robots checker, search
provider, budget, clock and checkpoint store as arguments. That is how:
- the batch command swaps in an offline provider with `--fake`
- the test suite runs whole builds against local fixture sites with no network
- a resumed build restores its checkpoints

The API takes its store the same way, so every route, auth check and revision conflict is
tested against an in-memory store that passes the same contract test as the MongoDB one.

**What each side of the boundary knows.**
- **Core** knows nothing about Express, MongoDB, the CLI or the environment. It never reads
  `process.env` and never logs.
- **The server** validates configuration at boot and refuses to start rather than limp. It
  refuses:
  - an unsafe `ALLOW_PRIVATE_HOSTS` (§5)
  - an unpinned or retired model id
  - a weak session secret
  - an http web origin in production

  It warns, and still starts, about a daily limit too small for a batch run or a blank
  search key.
- **The client** holds no business rules. Where it must predict the server (input limits,
  which items a regeneration would replace), it mirrors core in one module, and a test
  holds the mirror to the original.

**A build, end to end.**
1. The browser posts the posting, company URL and day count.
2. The API validates the input and checks idempotency: the same submission within 15
   minutes returns the existing kit.
3. The API writes a `queued` kit and answers `202`.
4. The job runner (two builds at a time, sharing one limiter) calls `buildKit`. Each step's
   progress is streamed over server-sent events **and** persisted to the kit, so a page
   that reloads, or connects late, sees what already happened.
5. After each expensive step a checkpoint is saved on the kit. An interrupted build
   resumes without repeating finished calls or re-fetching pages.
6. When `buildKit` returns, the kit has already passed both validators. The job writes it
   as `ready`.
7. If the process restarts mid-build, boot marks the orphaned kit `BUILD_INTERRUPTED`, and
   the page offers to continue it.

---

## 5. Retrieval

Retrieval answers four questions about the company:
- what its site says
- which page describes how it hires
- what the public says about interviewing there
- which of those sources the kit may cite

Every step degrades: an unreachable site, a missing hiring page or an empty search is
recorded in the kit and the build continues.

### Link ranking — best-first, from evidence

The crawler starts at the company URL and **discovers** links from the pages it fetches.
Each link is scored from evidence:

| Signal | Effect |
|---|---|
| Hiring words in the slug or anchor | `how-we-hire` +10, `hiring` / `interview` +8, `careers` / `jobs` / `recruiting` / `join-us` +7 |
| Where processes actually live | `handbook` / `work-with-us` +6, `process` / `playbook` / `life-at` / `working-at` +5 |
| Context for the company brief | `about` / `engineering` / `culture` +4, `mission` / `values` / `team` / `people` +3, `blog` +2 |
| Pages that are never useful | `login` / `signin` −10, `privacy` / `legal` / `terms` / `cookie` / `checkout` −8, `pricing` −5, feeds and archives −3 to −6 |
| Same origin | +5; off-origin −6 |
| Depth | −0.75 per path segment, −1.5 per link hop |
| Anchor text present | +1 |
| Asset URLs (images, PDFs, scripts) | never fetched |

The frontier is **re-sorted every round**, so a strong link found two hops in is fetched
before a weak one found first. Links scoring at or below zero are not fetched. The crawl
stops at 12 pages or 2 hops.

Every link not fetched is returned with a reason: budget reached, low score, robots,
refused, failed. Every signal behind a score is returned too, so a ranking decision can be
explained, not just trusted.

### Finding the hiring page — no hardcoded paths

There is no list of `/careers`, `/jobs`, `/about`. A guessed path finds only the pages that
were already easy to find. The acme fixture keeps its process at `/acme/handbook/how-we-hire`,
and real companies put theirs in a handbook, an engineering blog, a Notion export or a
"life at" microsite.

1. **Candidates come from pages actually fetched**, re-scored on the page's own title and
   first headings. A page titled "How we hire" is a candidate even if its URL said nothing.
2. **The obvious case costs no call.** If the top candidate scores 15 or more and its URL
   or title reads as hiring, it is accepted.
3. **Otherwise one short model call confirms.** The model sees the top five candidates —
   URL, title and the first 700 characters, as fenced data — and returns one URL with a
   confidence from 1 to 5, or an empty string.
4. **The answer is held to the list.** A URL that is not exactly one of the candidates is
   refused, and so is confidence below 3. The first rule is also an injection defence: a
   page cannot redirect the crawler by naming a URL in its text.
5. **No page is a correct answer.** The kit records `NO_HIRING_PAGE_FOUND` and skips the
   hiring-process step, so no call is spent inventing a process. A kit that presented the
   pricing page as the interview process would be worse than one that says it found none.

When a page is found, one call extracts the process as **machine-usable stages**: a closed
set of kinds such as `take-home` and `system-design`. Those stages change which question
categories each requirement gets (§6).

### Sources used — only what was fetched

`sourceLedger` records every fetch, skip, robots decision and search, and it is the only
thing that may write provenance:
- `source.pages_used` and `company_brief.sources` list **only URLs that were fetched
  successfully**.
- A URL a page linked to, or one a model mentioned, never reaches the kit.
- If retrieval returned no usable pages, **the company-brief call is not made at all**, and
  the brief says the site could not be read. A model asked to describe a company from its
  name alone will do so fluently, and from nothing.

**Public discussion search** always runs, because an attempt with no results is a different
fact from never looking:
- one Tavily query: `<company> <role> interview process experience`, up to five results
- under time pressure it narrows to one result; it is never skipped
- each outcome is recorded with its own reason: results found, an empty result
  (including when no search key is set), a failed provider, or a search that could not
  run because the posting named no company

Snippets reach the model **labelled unverified**. They may corroborate what a fetched page
says, never stand alone as a fact about the company.

### robots.txt and fetching

- **One `robots.txt` per origin**, cached. The most specific matching rule wins, with
  `Allow` beating `Disallow` on a tie. An empty `Disallow:` allows everything. A disallowed
  path is not fetched, and the skip is recorded.
- **A missing or unreadable `robots.txt` means allowed**, as the standard intends. "No file"
  and "could not find out" are recorded as different reasons.
- **Every fetch has limits.** Each request:
  - times out after 10 seconds, and follows at most 5 redirects
  - accepts `text/html` and `text/plain` only
  - is abandoned while streaming once it passes 2 MB. A missing or lying `Content-Length`
    cannot get past that.
- **Retries are narrow.** A timeout, a network error or a 5xx is retried once; a 404 is not.
- **Nothing throws.** Every outcome is a value with a reason, so one dead link never ends a
  case.
- **Cleaning.** `script`, `style`, `noscript`, `template`, `svg` and `iframe` are removed
  before anything else is read, so a string inside a script cannot plant a crawl target.
  Navigation and footers are excluded from body text, but their links are kept: a careers
  link in a footer is exactly the link the crawler is looking for.

### The loopback tension, and the environment gate

The brief pulls in two directions here:
- **Section 11 of the brief requires rejecting private and loopback addresses.** A crawler
  that fetches user-supplied URLs is an SSRF hole. Point it at `http://169.254.169.254/` and
  it reads cloud instance credentials; point it at `http://localhost:27017` and it probes
  the deploy's own network.
- **The batch command's own fixture sites are served from `http://localhost:8099`.** A
  guard that always refuses loopback makes every sample case report its site unreachable.

The two cannot both be satisfied by one fixed rule, so the rule is **gated by
environment**, and the gate is explicit:
- **`urlGuard` judges the resolved address, not the spelling.** It resolves the hostname and
  checks every address it returns. `localhost`, `127.0.0.1`, `0x7f.1` and a public name
  whose DNS points at `10.0.0.5` are all refused alike. It re-checks **every redirect hop**,
  so a public URL that 302s to a private one is caught, and a host with one public and one
  private address is refused.
- **`ALLOW_PRIVATE_HOSTS` must be stated in the environment.** It is never inferred, so a
  mistyped `NODE_ENV` cannot quietly open the crawler.
- **`true` only on a developer's machine**, so the local fixture sites can be crawled.
  `npm run evaluate -- --fake` defaults it to `true`, prints that it did so, and still
  obeys an explicit `false`.
- **`false` in production, and enforced.** With `NODE_ENV=production`, a value of `true` is
  a fatal configuration error (`CONFIG_SSRF_RISK`), and the server does not start. A warning
  in a deploy log is a warning nobody reads.
