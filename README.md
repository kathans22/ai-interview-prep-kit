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
