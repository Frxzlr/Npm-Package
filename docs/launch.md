# Launch kit

Drafts for launching whycrash. Replace `<repo-url>` with the GitHub URL before posting.
Everything here is written to be accurate — no invented numbers, testimonials or stars.

## Positioning

- **Tagline:** Stack traces tell you _where_. whycrash tells you _why_.
- **One-liner:** Context-aware diagnoses for Node.js errors — it reads your code, files and
  packages to explain what actually went wrong.
- **Proof points:** 44 diagnoses · zero dependencies · offline, no AI, no telemetry ·
  one-line setup · Node.js 18+ · ESM + CJS.

### Natural sharing mechanisms

1. **The output is a screenshot.** Every diagnosis is a self-contained before/after.
2. **It shows up in shared places**: CI logs, pairing sessions, screen shares — teammates
   see it without being told about it.
3. **Teams encode their own knowledge** with custom rules ("Postgres on 5432 is down → run
   `docker compose up -d db`"), which spreads the tool inside a company.
4. **Contribution loop**: "my error isn't covered" → issue template → a 20-line rule.

## Demo (GIF / 30-second video)

Record with [VHS](https://github.com/charmbracelet/vhs): `vhs demo/demo.tape` (writes
`demo/whycrash.gif`). Storyboard:

1. `node demo/api-shape/index.cjs` → raw `TypeError: Cannot read properties of undefined (reading 'map')` (2 s)
2. Same command through `whycrash --` → "`response.users` is undefined" with a code frame (4 s)
3. `whycrash -- node demo/esm-import/index.js` → "missing its file extension — use `./utils.js`" (4 s)
4. `whycrash -- node demo/server-down/client.mjs` → "Nothing is accepting connections on localhost:3000" (4 s)
5. End card: `npx whycrash -- npm run dev` (2 s)

Keep it under 20 seconds, dark theme, 15–16 px font, no typing mistakes. Put the GIF at the
top of the README once recorded.

## X / Twitter

**Post 1**

> Node.js: `TypeError: Cannot read properties of undefined (reading 'map')`
>
> Me: …what is undefined?
>
> So I built whycrash. It reads the failing line and tells you: "`response.users` is undefined" — with a code frame and fixes.
>
> `npx whycrash -- npm run dev`
>
> [GIF]

**Post 2 (reply)**

> It investigates instead of pattern-matching:
> • `fetch failed` → unwraps the cause: nothing on localhost:3000 (it tried ::1 and 127.0.0.1)
> • ESM import without `.js` → finds `./utils.js` on disk
> • `Cannot find module 'zod'` → it's in package.json, you just never ran `pnpm install`
> • EADDRINUSE on 5000 on macOS → it's AirPlay Receiver

**Post 3 (reply)**

> 44 diagnoses. Zero dependencies. Offline — no AI, no telemetry. Node 18+, ESM + CJS.
> Works as a command wrapper, a `--import` hook, or an API.
> Missing your favourite error? Each diagnosis is ~30 lines + a test. PRs welcome: <repo-url>

## Reddit (r/node, r/javascript)

**Title:** I built whycrash: it reads your code to explain Node.js errors (offline, zero deps)

**Body:**

> Node's errors are accurate but often unhelpful: `fetch failed` hides the reason in
> `error.cause`, `Cannot read properties of undefined` doesn't say what was undefined, and
> `ERR_MODULE_NOT_FOUND` doesn't mention that `./utils.js` is sitting right there.
>
> whycrash runs rules that inspect your project to pick the actual cause: it reads the
> failing line at V8's column, checks which files and packages exist, reads package.json /
> `"exports"`, follows `cause` chains, and adapts advice to your Node.js version.
>
> ```
> npx whycrash -- npm run dev          # wrap any command
> node --import whycrash/register app.js
> ```
>
> It's deterministic (no AI, no network), zero dependencies, and every diagnosis has a
> confidence level — errors it doesn't recognise produce no output rather than a guess.
>
> 44 diagnoses so far. I'd love to hear which errors cost you the most time — those are the
> next rules. Repo: <repo-url>

(Check each subreddit's self-promotion rules first; r/node allows project posts with
discussion. Reply to comments for the first few hours.)

## Show HN

**Title:** Show HN: Whycrash – Node.js error diagnoses that look at your code, not just the message

**Text:**

> whycrash is a small zero-dependency tool that explains Node.js errors by investigating the
> project: which expression was undefined (read from the source at V8's column), whether a
> missing module is a typo, an uninstalled dependency or a missing file extension, what's
> behind `fetch failed`, why a relative path didn't resolve, and so on.
>
> You can run it as a wrapper (`whycrash -- npm run dev`, it parses the error output), as an
> in-process hook (`node --import whycrash/register`, observes via
> `uncaughtExceptionMonitor` so exit codes and output stay untouched), or as a library.
>
> Design choices I'd like feedback on: deterministic rules instead of an LLM (fast, offline,
> testable; `--json` makes it a cheap first step for coding agents), confidence levels with
> silence for unknown errors, and testing each rule against real Node.js output in temporary
> projects rather than hand-written strings.
>
> <repo-url>

## LinkedIn

> I've lost more hours than I'd like to admit to errors like `fetch failed` and "Cannot read
> properties of undefined" — the stack trace says where, never why.
>
> So I built **whycrash**, an open-source tool that diagnoses Node.js errors by looking at
> your actual project: it names the undefined expression, finds the file your import meant,
> notices an uninstalled dependency, unwraps network errors, and suggests fixes that match
> your Node.js version.
>
> It runs offline, has zero dependencies, and works with any command:
> `npx whycrash -- npm run dev`
>
> If you work with Node.js, I'd love your feedback — and the errors that cost you the most
> time. <repo-url>

## Developer-focused demo talk (5 minutes)

1. **The problem (60 s):** three real errors, raw. Ask the room what caused each.
2. **The reveal (90 s):** same three through whycrash.
3. **How it works (90 s):** `ErrorInfo` normalization → rules → context helpers; show one
   20-line rule (e.g. `address-in-use` with the AirPlay check) and its test.
4. **Team rules (45 s):** `defineRule` for "local DB is down".
5. **Call to action (15 s):** `npx whycrash -- npm run dev`; contribute a rule.

## Contribution opportunities (seed as "good first issue")

- Prisma error codes (`P1001` can't reach database, `P2002` unique constraint)
- `pg` / `mysql2` connection and authentication errors
- Next.js: `Dynamic server usage`, `Text content does not match server-rendered HTML`
- Vite: `Failed to resolve import`, pre-transform errors
- Jest/Vitest: `Cannot log after tests are done`, open handles
- npm/pnpm errors piped through the CLI: `ERESOLVE`, `EINTEGRITY`, `ENOTEMPTY`
- GitHub Actions problem matcher so diagnoses appear as annotations

## Launch checklist

- [ ] GIF recorded and added to the README
- [ ] Repository public with description, topics (`nodejs`, `debugging`, `errors`, `cli`,
      `developer-tools`), and the README's demo above the fold
- [ ] 5–10 "good first issue" issues created from the list above
- [ ] Published to npm (see RELEASING.md) and `npx whycrash --help` verified from a clean machine
- [ ] Posts scheduled: Show HN and Reddit on a weekday morning (US time); X and LinkedIn the same day
- [ ] Be available to answer comments for the first several hours
