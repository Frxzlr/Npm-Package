# Contributing to whycrash

Thanks for helping! The most valuable contribution is a **new or better diagnosis** — an
error you've personally lost time to, explained so the next person doesn't.

## Setup

Development needs Node.js 22.12+ (the published package itself supports Node.js 18+).

```sh
npm install
npm test            # builds, then runs the full test suite
npm run check       # everything CI runs: types, lint, format, tests, package checks
```

## How whycrash works

```
error object ──┐
               ├─▶ ErrorInfo (normalized) ─▶ rules ─▶ Diagnosis[] ─▶ format()
error text ────┘   src/normalize.ts           src/rules/*      src/explain.ts   src/format.ts
                   src/parse.ts
```

- **`src/parse.ts`** turns terminal output into `ErrorInfo` (Node's uncaught-error format,
  `util.inspect` with `[cause]`/`[errors]`, source arrows, Jest/Vitest frames).
- **`src/normalize.ts`** turns live `Error` objects (or anything thrown) into the same shape.
- **`src/rules/`** contains every diagnosis, grouped by topic. Each rule is a plain object:
  `{ id, summary, diagnose(error, ctx) }`.
- **`src/explain.ts`** runs rules over the error and its `cause` chain, ranks the results
  (confidence → custom rules → deepest cause) and keeps one diagnosis per rule.
- **`src/context.ts`** provides the safe, cached helpers rules use to investigate
  (`readFile`, `findUp`, `userFrame`, `packageManager`, …).

## Adding a diagnosis

1. **Reproduce the real error.** Write the smallest script that triggers it and look at the
   exact output on a current Node.js version. Don't write rules against messages from memory.
2. **Add the rule** to the matching file in `src/rules/` and to that file's exported list.
   - Match on `error.code` whenever there is one; message text changes between versions.
   - _Investigate_ before explaining: check the files, package.json, Node.js version or
     source line that distinguishes one cause from another. That's what makes whycrash
     different from a list of canned messages.
   - Titles are one specific line using real values (port, file, package). Put code in
     `backticks`. Fixes are concrete steps, most likely first.
   - Use `confidence: 'medium'` or `'low'` when the rule is inferring rather than certain.
   - Return `undefined` when unsure. Silence is better than a wrong diagnosis.
3. **Test it** in the matching `test/rules-*.test.ts`. Prefer the `crash()` helper, which
   runs a real Node.js process in a temporary project and diagnoses its actual output — that
   tests the text parser and the rule together. Use synthetic errors (`info()` or an `Error`
   with properties) only for situations you can't reproduce locally (TLS, DNS, Windows).
4. **Document it**: add a row to the "What it diagnoses" table in `README.md` (a test checks
   that every rule is listed) and update the count.
5. Run `npm run check`.

### Rule checklist

- [ ] Reproduced against real output
- [ ] Never throws (the engine guards rules, but don't rely on it)
- [ ] No network access, no writes, no expensive scans (`findInProject` is the bounded exception)
- [ ] Advice is correct for the Node.js versions it mentions (check the Node.js docs' "History")
- [ ] Tests for the positive case _and_ a near-miss that must not match

## Other contributions

- **Parser support** for more output formats (frameworks, test runners, loggers): add a
  fixture test in `test/parse.test.ts`.
- **Bug reports**: include the full error output (redact secrets) and your Node.js version.

## Code style

TypeScript strict mode, ESLint and Prettier (`npm run lint`, `npm run format`). Zero runtime
dependencies is a feature — please don't add any.

## Releasing

See [RELEASING.md](./RELEASING.md).
