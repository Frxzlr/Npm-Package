# Why whycrash: idea selection and competitive analysis

Research done on 2026-11-17. Popularity figures quoted below come from search results at that
time and will change.

## 1. Fifteen candidate ideas

| #   | Idea                                                     | Problem it solves                                                                                                    |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | **whycrash** — context-aware diagnosis of Node.js errors | Error messages say what failed, not why; the real cause hides in `cause` chains, the file system or the failing line |
| 2   | Runtime "await waterfall" detector                       | Independent `await`s run sequentially; a terminal waterfall would show the wasted latency                            |
| 3   | Lockfile diff reviewer with supply-chain signals         | `package-lock.json` diffs are unreadable; new install scripts slip through review                                    |
| 4   | Pattern-based secret redaction for logs                  | API keys and tokens leak into logs                                                                                   |
| 5   | JSON shape summarizer                                    | Dumping a 5 MB API response is useless; its _shape_ (→ TS/Zod) is what you need                                      |
| 6   | Log "flight recorder"                                    | Debug logs are noise until an error happens; buffer them and flush only on failure                                   |
| 7   | "Why did my process exit?"                               | Scripts silently stop: `process.exit` deep in a dependency, unsettled top-level await, drained event loop            |
| 8   | Env-var contract checker                                 | Code reads env vars that `.env.example` doesn't document (or vice versa)                                             |
| 9   | Mutation detective                                       | "Who mutated this object?" — record mutations with call sites                                                        |
| 10  | Strict options with "did you mean" for library authors   | Typos in options objects are silently ignored                                                                        |
| 11  | Startup import profiler                                  | Which imports make CLIs and serverless cold starts slow                                                              |
| 12  | fetch error explainer + curl reproduction                | `TypeError: fetch failed` hides the reason                                                                           |
| 13  | Expiring TODOs that fail CI after a date                 | Temporary hacks become permanent                                                                                     |
| 14  | Test hang reporter                                       | "Jest did not exit one second after the test run has completed"                                                      |
| 15  | Agent-friendly log condenser                             | Test/build output is too long for AI coding agents' context                                                          |

## 2. Scoring

Weights from the brief: uniqueness 20%, usefulness 20%, reusability 15%, adoption 15%,
demo/viral potential 15%, feasibility 10%, extensibility 5%. Scores are 1–10 and are
judgement calls informed by the research below.

| #   | Idea                     | Uniq. | Useful | Reuse | Adopt | Viral | Feas. | Ext. | **Total** |
| --- | ------------------------ | ----- | ------ | ----- | ----- | ----- | ----- | ---- | --------- |
| 1   | whycrash                 | 6     | 8      | 9     | 7     | 8     | 8     | 9    | **7.65**  |
| 5   | JSON shape summarizer    | 5     | 8      | 8     | 8     | 8     | 9     | 7    | 7.45      |
| 2   | Await waterfall detector | 8     | 7      | 7     | 5     | 8     | 6     | 8    | 7.00      |
| 6   | Log flight recorder      | 7     | 8      | 7     | 6     | 5     | 8     | 7    | 6.85      |
| 12  | fetch error explainer    | 5     | 7      | 8     | 7     | 7     | 9     | 4    | 6.80      |
| 3   | Lockfile diff reviewer   | 4     | 8      | 8     | 7     | 7     | 6     | 8    | 6.70      |
| 4   | Secret redaction         | 4     | 8      | 9     | 7     | 5     | 8     | 7    | 6.70      |
| 15  | Agent log condenser      | 6     | 7      | 8     | 6     | 6     | 7     | 6    | 6.60      |
| 8   | Env-var contract checker | 4     | 7      | 9     | 7     | 5     | 8     | 6    | 6.45      |
| 7   | Why did my process exit  | 7     | 6      | 7     | 6     | 6     | 7     | 5    | 6.40      |
| 9   | Mutation detective       | 7     | 6      | 6     | 5     | 6     | 7     | 5    | 6.10      |
| 11  | Import profiler          | 6     | 6      | 6     | 5     | 7     | 5     | 6    | 5.90      |
| 14  | Test hang reporter       | 4     | 7      | 7     | 6     | 5     | 6     | 5    | 5.75      |
| 13  | Expiring TODOs           | 2     | 6      | 8     | 6     | 5     | 9     | 4    | 5.55      |
| 10  | "Did you mean" options   | 6     | 5      | 7     | 4     | 3     | 9     | 4    | 5.40      |

### What the research changed

- **Lockfile reviewers (#3)** and **secret redaction (#4)** are crowded with small tools
  (lockwatch, octoscope, lockscript-guard, locksift, bumpdiff; autoredact,
  @carvis_ai/sanitize-log, @npmcli/redact, pino's path redaction). Uniqueness was scored down.
- **JSON shape (#5)** has quicktype plus newer inferrers (shape-infer, guess-json-shape,
  @jsonhero/json-infer-types). Useful, but the gap is narrower than it first looked.
- **Await waterfalls (#2)** are mostly unaddressed at runtime (better-all has a debug
  waterfall; Vercel has a _static_ conformance rule). But at runtime you can't tell whether
  the second call depends on the first one's result, so it would produce many false positives.
- **Expiring TODOs (#13)** already exist as `eslint-plugin-unicorn`'s
  `expiring-todo-comments`; **test hangs (#14)** are covered by `why-is-node-running`.
- **Error explainers (#1, #12)** exist too — see below — which is why #1 is designed around
  _investigation_ rather than explanation.

## 3. Competitive analysis for the selected idea

| Alternative                                                                                                                                                 | What it does                                                                               | Limitation whycrash addresses                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js's own messages                                                                                                                                      | Accurate, increasingly helpful (e.g. `require(esm)` hints)                                 | Intentionally generic; can't know your project layout, your intent, or which of several causes applies                                                                    |
| [hint-errors](https://github.com/ZLouisMiguel/hint-errors)                                                                                                  | Plain-English hints for uncaught errors; custom hints by regex; error-code table           | Hints are per error type/code; its docs don't describe reading source, the file system or `cause` chains; uncaught errors only                                            |
| [friendly-error](https://www.npmjs.com/package/friendly-error)                                                                                              | Friendlier uncaught errors via search lookups                                              | Last released years ago; relies on web lookups                                                                                                                            |
| explain-js-error, js-debug-assistant, errlens, stacksplain, explain-my-error, oops-explainer, … ([pkgstats](https://www.pkgstats.com/pkg:explain-js-error)) | Pattern → canned explanation; some call AI APIs                                            | Same generic answer for every project; network/API keys for the AI variants                                                                                               |
| [dev-error-explainers](https://socket.dev/npm/package/dev-error-explainers)                                                                                 | Offline, deterministic explanations (CORS, ESM/CJS, ERESOLVE, Next.js); CLI and MCP server | Matches documented error patterns; doesn't inspect the project                                                                                                            |
| [pretty-error](https://www.npmjs.com/package/pretty-error), youch                                                                                           | Prettier stack traces                                                                      | Formatting, not diagnosis                                                                                                                                                 |
| AI assistants / coding agents                                                                                                                               | Can explain almost anything                                                                | Need copy-paste or an agent loop, network access and tokens; may guess. whycrash is instant and deterministic, and its `--json` output is a cheap first step _for_ agents |

**The gap.** None of the tools found **investigate the project** to choose between possible
causes. A search for tools that name the undefined variable in `Cannot read properties of
undefined` found none ("finding the variable itself would need the stack trace and source
location"). Examples of what whycrash does that canned explainers can't:

- names the undefined expression (`response.users`) by reading the failing line at V8's column;
- finds `./utils.js` on disk for an extensionless ESM import, or `./math.ts` behind a `.js` import;
- sees that `zod` _is_ in package.json but `node_modules` is missing, and uses your package manager;
- reads a package's `"exports"` to list valid entry points;
- unwraps `fetch failed` → `AggregateError` → `ECONNREFUSED ::1` and `127.0.0.1`;
- notices that a relative path was resolved from the working directory while the file sits
  next to the script;
- adapts fixes to the running Node.js version (`import.meta.dirname`, `require(esm)`,
  type stripping, `--use-system-ca`).

**Risks.** The space has many small explainer packages, so the difference has to be visible
in a 10-second demo. Rules must stay accurate as Node.js changes its messages (mitigated by
matching on error codes and testing against real output on Node.js 22/24/26 in CI).

## 4. Why this idea

- **Everyone hits it, every week.** Every Node.js project crashes; adoption is one line
  (`whycrash -- npm run dev`) with no code changes and no runtime cost.
- **The demo is the pitch.** A raw stack trace next to "`response.users` is undefined" plus
  a code frame needs no explanation.
- **It grows with its community.** Each rule is small, testable and self-contained. "Add a
  diagnosis for the error that cost you an afternoon" is a contribution path open to anyone.
- **It's honest.** Deterministic rules with confidence levels, offline, no telemetry.

## Sources

- https://github.com/ZLouisMiguel/hint-errors
- https://www.npmjs.com/package/friendly-error
- https://socket.dev/npm/package/dev-error-explainers
- https://www.pkgstats.com/pkg:explain-js-error
- https://www.pkgstats.com/pkg:errlens
- https://www.npmjs.com/package/pretty-error
- https://www.goodfirstissue.org/nodejs/undici/issues/2199 (unhelpful `fetch failed` messages)
- https://github.com/nodejs/undici/issues/2953
- https://nodejs.org/api/errors.html ("use `error.code`, messages may change")
- https://www.pkgstats.com/pkg:shape-infer, https://socket.dev/npm/package/guess-json-shape
- https://www.pkgstats.com/pkg:autoredact, https://www.pkgstats.com/pkg:@carvis_ai/sanitize-log
- https://www.pkgstats.com/pkg:lockwatch, https://www.pkgstats.com/pkg:locksift
- https://vercel.com/docs/conformance/rules/NO_SERIAL_ASYNC_CALLS, https://www.pkgstats.com/pkg:better-all
- npm registry checks (`npm view <name>`) for name availability: `whycrash`, `why-crash`,
  `why_crash`, `why.crash` were all unregistered on 2026-11-17.
