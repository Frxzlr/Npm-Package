# whycrash

**Stack traces tell you _where_. whycrash tells you _why_.**

[![npm version](https://img.shields.io/npm/v/whycrash.svg)](https://www.npmjs.com/package/whycrash)
[![node](https://img.shields.io/node/v/whycrash.svg)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](./package.json)
[![license](https://img.shields.io/npm/l/whycrash.svg)](./LICENSE)

whycrash diagnoses Node.js errors by **investigating your project**: it reads the failing
line, checks which files and packages actually exist, follows `cause` chains, and looks at
your Node.js version — then tells you what went wrong and how to fix it.

```sh
npx whycrash -- npm run dev
```

No AI, no network calls, no telemetry. Zero dependencies.

---

### Before

```
/app/demo/api-shape/index.cjs:8
  const names = response.users.map((user) => user.name);
                               ^

TypeError: Cannot read properties of undefined (reading 'map')
    at main (/app/demo/api-shape/index.cjs:8:32)
```

### After

```
whycrash: `response.users` is undefined

  Your code reads `.map` from `response.users`, but `response.users` is
  `undefined` at that point.

  Try
  › Default it to an empty array: `(response.users ?? []).map`
  › Find where `response.users` gets its value and log it just before this
    line
  › If it comes from an async call, check for a missing `await`

  demo/api-shape/index.cjs:8:32
    7 │   const response = await getUsers();
  › 8 │   const names = response.users.map((user) => user.name);
      │                                ^
    9 │   console.log(names);
```

The `fetch failed` that hides its real reason two levels deep:

```
whycrash: Nothing is accepting connections on localhost:3000

  fetch() could not connect: the connection to `[::1]:3000` and
  `127.0.0.1:3000` was refused, so no process is accepting connections there
  (or a firewall rejected it).

  Try
  › Start the server that should be listening on port 3000, then retry
  › Check the host and port in your URL or config — a missing or stale
    environment variable is a common culprit

  demo/server-down/client.mjs:1:13
  › 1 │ const res = await fetch('http://localhost:3000/api/users');
      │             ^
    2 │ console.log(await res.json());

  Docs https://nodejs.org/api/errors.html#common-system-errors
```

The ES module import that works in your bundler but not in Node.js:

```
whycrash: `./utils` is missing its file extension — use `./utils.js`

  ES modules don't guess file extensions or `index` files the way `require()`
  does, so the import must name the file exactly. The file exists as
  `./utils.js`.

  Try
  › Change the import to `./utils.js`
  › Writing TypeScript? Set `"module": "nodenext"` in tsconfig.json so the
    compiler flags missing extensions

  demo/esm-import/index.js:1:25
  › 1 │ import { slugify } from './utils';
      │                         ^
    2 │

  Docs https://nodejs.org/api/esm.html#mandatory-file-extensions
```

This is real output from the scripts in [`demo/`](./demo), shown without colors (only the
absolute path in the first block was shortened). In a terminal, code is highlighted.

## Why

Node.js error messages are accurate but rarely _helpful_. The useful part is often missing,
buried, or requires knowledge you don't have at 2 a.m.:

- `TypeError: fetch failed` puts the real reason in `error.cause` — or in an `AggregateError`
  inside it.
- `Cannot read properties of undefined (reading 'map')` doesn't say _what_ was undefined.
- `ERR_MODULE_NOT_FOUND` doesn't mention that `./utils.js` is right there.
- `ENOENT: './config.json'` doesn't tell you the path was resolved from a different folder
  than the one your file is in.
- `Cannot find module 'zod'` doesn't notice that it's in package.json but was never installed.

Generic "explain this error" tools map a message to a canned paragraph. whycrash runs
**rules that look at your code and your machine** to work out which of several possible
causes is the real one, and points at the exact line.

## Install

```sh
npm install --save-dev whycrash
# or: pnpm add -D whycrash / yarn add -D whycrash / bun add -d whycrash
```

Or use it without installing: `npx whycrash ...`

## Quick start

Pick whichever fits your workflow — they all use the same diagnoses.

**1. Wrap any command** (works with `node`, `tsx`, `nodemon`, `next dev`, `vite`, test
runners, scripts — anything that prints Node.js errors):

```json
{
  "scripts": {
    "dev": "whycrash -- tsx watch src/server.ts"
  }
}
```

Output passes through untouched; diagnoses are printed after the error, and the exit code
of your command is preserved.

**2. Load it into the process** (no wrapper; uses the real error objects):

```sh
node --import whycrash/register app.js      # ES modules or CommonJS
node -r whycrash/register app.js            # CommonJS, older setups
NODE_OPTIONS="--import=whycrash/register" npm run dev
```

**3. Use the API** for errors you catch yourself:

```js
import { report } from 'whycrash';

app.use((err, req, res, next) => {
  report(err); // prints a diagnosis to stderr if whycrash recognises the error
  next(err);
});
```

**4. Paste or pipe an error:**

```sh
whycrash "Error: listen EADDRINUSE: address already in use :::3000"
whycrash ERR_REQUIRE_ESM
npm test 2>&1 | whycrash
```

## What it diagnoses

44 built-in diagnoses (`whycrash --list`). Each one inspects real context — some examples of
what that means are in _italics_.

**Modules & packages**

| Diagnosis                        | What it investigates                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `module-path-not-found`          | Missing extensions, directory imports, `.js` imports of `.ts` files, wrong letter case, typos — _checks which files actually exist_              |
| `package-not-found`              | Typos (_did you mean `lodash`?_), declared-but-not-installed (_uses your package manager_), missing peer deps, `@types`-only installs            |
| `package-subpath-not-exported`   | Deep imports blocked by `"exports"` — _reads the package's package.json and lists valid entry points_; ESM-only packages loaded with `require()` |
| `require-esm`                    | `ERR_REQUIRE_ESM` — _advice depends on whether your Node.js version supports `require(esm)`_                                                     |
| `require-async-module`           | `require()` of an ES module with top-level `await`                                                                                               |
| `import-in-commonjs`             | `import` in a CommonJS file — _names the package.json `"type"` responsible_; Jest + ESM-only dependencies                                        |
| `commonjs-in-esm`                | `require`, `module.exports`, `__dirname`, `__filename` in ES modules — _version-appropriate replacements_                                        |
| `unknown-file-extension`         | Running `.ts` (_on Node.js versions without type stripping_), `.jsx`, `.css`, and other assets                                                   |
| `typescript-in-node-modules`     | Dependencies — _or linked monorepo packages_ — that ship TypeScript source                                                                       |
| `typescript-syntax-not-erasable` | `enum`, namespaces and parameter properties under Node.js type stripping                                                                         |
| `json-import-attribute`          | JSON imports without `with { type: 'json' }`, and the removed `assert` syntax                                                                    |
| `native-module-mismatch`         | `.node` add-ons built for another Node.js version (_maps `NODE_MODULE_VERSION` to versions_), OS (_Docker_), or CPU architecture                 |
| `openssl-legacy`                 | `ERR_OSSL_EVP_UNSUPPORTED` from old webpack-based tooling                                                                                        |

**Network & HTTP**

| Diagnosis            | What it investigates                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `connection-refused` | _Names the service by port_ (PostgreSQL, Redis, MongoDB, Ollama…), IPv6 `::1` vs IPv4, `localhost` inside containers |
| `dns-lookup-failed`  | Docker Compose service names, URLs passed as hostnames, `undefined` hosts, temporary DNS failures                    |
| `network-timeout`    | Connect vs. response timeouts, with the right fix for each                                                           |
| `connection-reset`   | `ECONNRESET`, `socket hang up`, keep-alive/load-balancer mismatches                                                  |
| `tls-certificate`    | Corporate proxies, self-signed and expired certificates, wrong hostnames, HTTP on an HTTPS port                      |
| `address-in-use`     | Port in use — _platform-specific commands_, macOS AirPlay on ports 5000/7000                                         |
| `invalid-url`        | Relative URLs in server-side `fetch()`, URLs containing `undefined`, missing protocols, ports `fetch()` blocks       |
| `body-already-read`  | Reading a `Response` body twice                                                                                      |
| `request-aborted`    | `AbortSignal.timeout()` and `AbortController` cancellations                                                          |

**Files, processes & memory**

| Diagnosis                   | What it investigates                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `file-not-found`            | _Relative path resolved from the wrong folder_, letter case, typos, missing parent folder, missing `.env` (_finds `.env.example`_) |
| `spawn-not-found`           | Commands missing from `PATH`, bad `cwd`, Windows `.cmd`/`.bat` spawning                                                            |
| `permission-denied`         | Privileged ports, global npm installs, files locked on Windows                                                                     |
| `too-many-open-files`       | `EMFILE` / `ENFILE`                                                                                                                |
| `out-of-memory`             | Heap limit reached, strings too long, failed buffer allocations                                                                    |
| `unsettled-top-level-await` | Exit code 13: a top-level `await` that never settled                                                                               |

**Data**

| Diagnosis                 | What it investigates                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `json-parse-html`         | HTML (error page, login redirect, SPA fallback) parsed as JSON                          |
| `json-parse-invalid`      | `JSON.parse(undefined)`, parsing an already-parsed object, empty bodies, malformed JSON |
| `circular-json`           | Circular structures — _recognises Express/HTTP objects_                                 |
| `bigint-json`             | `JSON.stringify` of BigInt values                                                       |
| `invalid-date`            | Formatting an Invalid Date                                                              |
| `structured-clone-failed` | `structuredClone` / `postMessage` of functions and other uncloneable values             |

**JavaScript runtime**

| Diagnosis                  | What it investigates                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `property-of-undefined`    | _Reads the failing line and names the undefined expression_; lost `this`, missing `express.json()`, functions that return nothing, errors inside dependencies |
| `not-a-function`           | Default/named import interop, non-arrays, non-strings, non-Promises, axios `.json()`, Express `next`                                                          |
| `not-a-constructor`        | Import mix-ups and arrow functions with `new`                                                                                                                 |
| `before-initialization`    | Temporal dead zone — _detects circular imports by reading your imports_                                                                                       |
| `browser-global-on-server` | `window`/`document`/`localStorage` during SSR, build scripts and tests — _blames the library if it's in node_modules_                                         |
| `missing-global`           | `fetch`, `structuredClone`, `WebSocket`… — _too-old Node.js vs. a test environment that hid them_                                                             |
| `stack-overflow`           | _Shows the repeating call cycle_, self-calling setters, huge spreads                                                                                          |
| `headers-already-sent`     | _Finds the earlier `res.send()` without `return`_                                                                                                             |
| `non-error-thrown`         | Thrown/rejected strings — _searches your source to find where_                                                                                                |
| `invalid-argument`         | Node.js APIs called with `undefined` or an un-awaited Promise                                                                                                 |

## API

```ts
import {
  explain, // (error, options?) => Diagnosis | undefined
  explainAll, // (error, options?) => Diagnosis[]
  format, // (diagnosis | undefined, options?) => string
  report, // (error, options?) => Diagnosis | undefined   (explain + print)
  register, // (options?) => unregister()
  parseErrorText, // (text) => ErrorInfo[]
  defineRule, // (rule) => rule   (typing helper)
  builtinRules, // readonly Rule[]
} from 'whycrash';
```

### `explain(error, options?)`

Returns the best `Diagnosis`, or `undefined` if no rule recognises the error. `error` can be
an `Error`, **any thrown value**, or **error text** (a pasted stack trace, a log excerpt, or a
bare code such as `'ECONNREFUSED'`). Walks the whole `cause` chain and `AggregateError`
members, and prefers the diagnosis closest to the root cause.

```ts
interface Diagnosis {
  id: string; // rule id, e.g. 'connection-refused'
  title: string; // one line; `backticks` mark code
  explanation: string;
  fixes: string[]; // most likely fix first; a line break starts a code example
  confidence: 'high' | 'medium' | 'low';
  location?: { file: string; line: number; column?: number };
  docs?: string; // link to the relevant Node.js docs
  error: ErrorInfo; // the error in the chain that was diagnosed
}
```

`explain()` never throws for any input. It only throws a `TypeError` when `options.rules`
is malformed — that's a programming error you want to see.

### `explainAll(error, options?)`

All diagnoses, best first, one per rule.

### `format(diagnosis, options?)`

Renders a diagnosis for the terminal: wrapped text, highlighted code, and a code frame with
a caret at the failing column. Returns `''` for `undefined`, so
`console.error(format(explain(err)))` is always safe.

| Option      | Default                  |                                                                                      |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `color`     | auto                     | Colors on/off. Auto honours `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb` and TTY detection |
| `width`     | terminal width (max 100) | Wrap width                                                                           |
| `codeFrame` | `true`                   | Show the source code around `location`                                               |
| `cwd`       | `process.cwd()`          | Paths are shown relative to this folder                                              |

### `report(error, options?)`

`explain()` + `format()` + write to `options.stream` (default `process.stderr`). Returns the
diagnosis. Ideal for `catch` blocks, error middleware and loggers.

### `register(options?)`

Prints a diagnosis whenever the process crashes from an uncaught exception or unhandled
rejection. Calling it twice is a no-op; it returns a function that removes the hook.
`import 'whycrash/register'` calls it for you.

It only **observes** crashes (through `process.on('uncaughtExceptionMonitor')`), so Node.js's
own error output, your exit code and any `uncaughtException` handlers behave exactly as
before. The diagnosis appears just above Node's error output, followed by `↓ original error`.

### `parseErrorText(text)`

Finds every error in a block of text: Node's uncaught-error output, `util.inspect` format
(including `[cause]` and `AggregateError` `[errors]`), Node's source arrows, and Jest/Vitest
frames. Returns normalized `ErrorInfo` objects you can pass to `explain()`.

### Options for `explain`, `explainAll`, `report`, `register`

| Option        | Default            |                                             |
| ------------- | ------------------ | ------------------------------------------- |
| `rules`       | `[]`               | Your own rules. They run first and win ties |
| `builtins`    | `true`             | `false` runs only your rules                |
| `cwd`         | `process.cwd()`    | Folder used to resolve relative paths       |
| `nodeVersion` | `process.version`  | Diagnose for another Node.js version        |
| `platform`    | `process.platform` | Diagnose for another platform               |
| `inContainer` | auto-detected      | Treat the process as running in a container |

`report` and `register` also accept the `format` options and a `stream`.

## Teach it your team's errors

The rules your team keeps explaining in Slack can live next to the code:

```ts
// whycrash.rules.ts
import { defineRule } from 'whycrash';

export const localDbDown = defineRule({
  id: 'acme/local-db-down',
  summary: 'Local Postgres is not running',
  diagnose(error) {
    if (error.code !== 'ECONNREFUSED' || error.props.port !== 5432) return;
    return {
      title: 'The local database is not running',
      explanation: 'Our dev database runs in Docker and stops when Docker Desktop restarts.',
      fixes: [
        'Run `docker compose up -d db`',
        'Then `npm run db:migrate` if this is a fresh volume',
      ],
    };
  },
});
```

```ts
// dev-only entry, e.g. src/dev.ts
import { register } from 'whycrash';
import { localDbDown } from './whycrash.rules.js';

register({ rules: [localDbDown] });
```

A rule receives a normalized `ErrorInfo` (`name`, `message`, `code`, `props`, `frames`,
`cause`, `errors`, `sourceHint`) and a read-only `RuleContext` with safe helpers: `readFile`,
`readJson`, `exists`, `findUp`, `userFrame`, `sourceLine`, `packageManager`, `nodeAtLeast`,
`findInProject` and more. Helpers never throw, and a rule that throws is skipped.

## CLI

```
whycrash -- <command> [args...]   Run a command and diagnose errors in its output
<command> 2>&1 | whycrash         Diagnose errors in piped output (passes it through)
whycrash "<error text>"           Diagnose an error message or code
whycrash --list                   List the built-in diagnoses

--json         Print diagnoses as JSON (text and piped input only)
--no-color     Disable colors (also: NO_COLOR=1)
-h, --help     Show help
-v, --version  Show the version
```

- When running a command, stdout/stderr pass through unchanged, Ctrl-C reaches the command,
  and whycrash exits with the command's exit code (127 if it couldn't be started).
- The same error repeated (e.g. on every request) is diagnosed once per run.
- `--json` output is stable and machine-readable — useful for CI annotations and for AI
  coding agents that run your commands.

## Environment variables

| Variable        | Effect                                                                         |
| --------------- | ------------------------------------------------------------------------------ |
| `WHYCRASH=0`    | Disable the register hook without changing code (`false`/`off`/`no` also work) |
| `NO_COLOR=1`    | Disable colors                                                                 |
| `FORCE_COLOR=1` | Force colors (e.g. in CI logs that support them)                               |

## Guarantees

- **Never changes behaviour.** The hook only observes; exit codes, Node's error output and
  your handlers are untouched. The CLI forwards output byte for byte.
- **Never throws from a crash path.** A failing rule or unreadable file is skipped.
- **Never phones home.** Everything runs locally and offline. It reads files in your project
  (only to diagnose a failure) and never writes anything.
- **Never guesses loudly.** Each diagnosis carries a `confidence`; less certain ones are
  labelled _likely cause_ or _possible cause_. Errors it doesn't recognise produce no output.

## TypeScript

whycrash is written in TypeScript and ships declarations for both ESM and CommonJS
consumers (`moduleResolution` `node16`, `nodenext` and `bundler`). All public types are
exported: `Diagnosis`, `ErrorInfo`, `Rule`, `RuleContext`, `Finding`, `ExplainOptions`,
`FormatOptions`, `ReportOptions`, `StackFrame`, `SourceLocation`.

## Compatibility

- **Node.js 18 and newer.** Diagnoses adapt to the Node.js version they describe (for
  example `import.meta.dirname` vs. `fileURLToPath`, or whether `require(esm)` is available).
- **ESM and CommonJS**: `import` and `require` both work, as do `--import` and `-r`.
- **macOS, Linux and Windows.**
- **Any tool's output**: the CLI understands Node's error format wherever it's printed —
  dev servers, test runners, build tools.
- whycrash targets **Node.js** errors. It doesn't run in browsers.

## Performance

- **Zero cost until something fails.** The register hook is a single event listener; the
  API does nothing until you call it.
- On a failure, rules read a handful of files (each capped at 2 MB, cached per diagnosis).
  The one exception is a thrown _string_ with no stack, where whycrash searches up to 2,000
  of your source files (never `node_modules`) to find it.
- The CLI pass-through adds no buffering: output is forwarded as it arrives and analysed
  once the stream goes quiet (150 ms).
- Install size: zero dependencies; the package is plain unminified JavaScript so you can
  read every rule in `node_modules/whycrash/dist`.

## FAQ

**Should I use it in production?** It's built for development and CI. The hook is
harmless in production (it only prints on a crash), but the advice is written for the
person fixing the code, not for log pipelines.

**Does it send my code anywhere?** No. There are no network calls at all.

**Is it an AI tool?** No. Every diagnosis comes from a deterministic rule you can read and
test. That makes it fast, offline, and predictable — and its `--json` output is a good,
cheap first step for AI coding agents before they start guessing.

**My error isn't recognised.** Please open an issue with the error output (redact secrets)
— or, better, add a rule. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Roadmap

- More rules for popular libraries: Prisma, Postgres/MySQL drivers, Next.js, Vite, Jest/Vitest
- Source-map support for diagnosing compiled output that ships without maps
- An ESLint-style config file for team rules (`whycrash.config.js`)
- Editor integration (VS Code problem matcher)
- Optional rich output for CI (GitHub Actions annotations)

Ideas and votes welcome in the issues.

## Contributing

New diagnoses are the most valuable contribution, and each one is small: a rule, a test that
reproduces the real error, and a line in this README. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
