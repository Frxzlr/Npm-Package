# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While whycrash is `0.x`, minor versions may change diagnosis wording and the `ErrorInfo`
shape; the documented API (`explain`, `explainAll`, `format`, `report`, `register`,
`parseErrorText`, `defineRule`, `builtinRules`) stays backward compatible.

## [Unreleased]

## [0.1.0] - 2026-11-17

### Added

- `explain()` / `explainAll()`: diagnose an `Error`, any thrown value, or error text, following
  `cause` chains and `AggregateError` members.
- 44 built-in diagnoses covering module resolution, ESM/CommonJS interop, TypeScript type
  stripping, native add-ons, networking and TLS, file system, processes, memory, JSON and
  common runtime `TypeError`s / `ReferenceError`s.
- `format()`: terminal rendering with wrapping, highlighted code and a code frame.
- `report()`: diagnose and print a caught error.
- `register()` and `whycrash/register`: observe uncaught exceptions and unhandled
  rejections without changing Node.js behaviour.
- `parseErrorText()`: parse Node's uncaught-error output, `util.inspect` format (with
  `[cause]` and `[errors]`), source arrows, and Jest/Vitest frames.
- Custom rules via `defineRule()` and the `rules` option.
- `whycrash` CLI: wrap a command, read piped output, or diagnose pasted text; `--json` and
  `--list`.
- ESM and CommonJS builds with TypeScript declarations for both. Zero runtime dependencies.
