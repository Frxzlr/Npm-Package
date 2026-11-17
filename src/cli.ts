#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { explain, explainAll } from './explain.js';
import { format, supportsColor } from './format.js';
import { parseErrorText } from './parse.js';
import { builtinRules } from './rules/index.js';
import type { Diagnosis } from './types.js';

const HELP = `whycrash — stack traces tell you where. whycrash tells you why.

Usage
  whycrash -- <command> [args...]   Run a command and diagnose errors in its output
  <command> 2>&1 | whycrash         Diagnose errors in piped output (passes it through)
  whycrash "<error text>"           Diagnose an error message or code
  whycrash --list                   List the built-in diagnoses

Options
  --json         Print diagnoses as JSON (text and piped input only)
  --no-color     Disable colors (also: NO_COLOR=1)
  -h, --help     Show this help
  -v, --version  Show the version

In your code
  node --import whycrash/register app.js     diagnose crashes in-process
  import { explain, report } from 'whycrash'  diagnose errors you catch

Examples
  whycrash -- npm run dev
  whycrash -- node server.js
  npm test 2>&1 | whycrash
  whycrash "Error: listen EADDRINUSE: address already in use :::3000"
  whycrash ERR_REQUIRE_ESM
`;

interface Flags {
  json: boolean;
  color: boolean | undefined;
  help: boolean;
  version: boolean;
  list: boolean;
}

function version(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function fail(message: string): never {
  process.stderr.write(`whycrash: ${message}\nRun \`whycrash --help\` for usage.\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): { flags: Flags; command?: string[]; rest: string[] } {
  const flags: Flags = { json: false, color: undefined, help: false, version: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--') return { flags, command: argv.slice(i + 1), rest: [] };
    if (!arg.startsWith('-') || arg === '-') return { flags, rest: argv.slice(i) };
    switch (arg) {
      case '--json':
        flags.json = true;
        break;
      case '--no-color':
        flags.color = false;
        break;
      case '--color':
        flags.color = true;
        break;
      case '-h':
      case '--help':
        flags.help = true;
        break;
      case '-v':
      case '--version':
        flags.version = true;
        break;
      case '--list':
        flags.list = true;
        break;
      default:
        fail(`unknown option ${arg}`);
    }
  }
  return { flags, rest: [] };
}

function looksLikeErrorText(text: string): boolean {
  return (
    /\s/.test(text) ||
    /^(?:E[A-Z0-9]{2,}|ERR_[A-Z0-9_]+)$/.test(text) ||
    /(?:Error|Exception)\b/.test(text)
  );
}

function toJson(d: Diagnosis) {
  const out: Record<string, unknown> = {
    id: d.id,
    title: d.title,
    explanation: d.explanation,
    fixes: d.fixes,
    confidence: d.confidence,
  };
  if (d.location) out.location = d.location;
  if (d.docs) out.docs = d.docs;
  out.error = {
    name: d.error.name,
    message: d.error.message,
    ...(d.error.code ? { code: d.error.code } : {}),
  };
  return out;
}

function diagnoseText(text: string): Diagnosis[] {
  const errors = parseErrorText(text);
  const results: Diagnosis[] = [];
  const keys = new Set<string>();
  const add = (d: Diagnosis | undefined) => {
    if (!d) return;
    const key = `${d.id}|${d.title}|${d.location?.file ?? ''}:${d.location?.line ?? ''}`;
    if (keys.has(key)) return;
    keys.add(key);
    results.push(d);
  };
  if (errors.length) for (const error of errors) add(explain(error));
  else add(explainAll(text)[0]);
  return results;
}

/** Watches a stream of text and diagnoses errors once the output goes quiet. */
class Scanner {
  private buffer = '';
  private timer: NodeJS.Timeout | undefined;
  private readonly seen = new Set<string>();

  constructor(private readonly emit: (d: Diagnosis) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) this.flush();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
    this.timer.unref();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const text = this.buffer;
    this.buffer = '';
    if (!text.trim()) return;
    for (const error of parseErrorText(text)) {
      const d = explain(error);
      if (!d) continue;
      const key = `${d.id}|${d.title}|${d.location?.file ?? ''}:${d.location?.line ?? ''}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.emit(d);
    }
  }
}

function quoteWindowsArg(arg: string): string {
  if (arg && !/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

function runCommand(command: string[], color: boolean): void {
  const [file, ...args] = command;
  if (!file) fail('missing command after --');
  const print = (d: Diagnosis) => process.stderr.write(format(d, { color }));
  const env = { ...process.env };
  if (color && env.FORCE_COLOR === undefined && env.NO_COLOR === undefined) env.FORCE_COLOR = '1';

  const win = process.platform === 'win32';
  const child = win
    ? spawn([file, ...args].map(quoteWindowsArg).join(' '), {
        stdio: ['inherit', 'pipe', 'pipe'],
        env,
        shell: true,
      })
    : spawn(file, args, { stdio: ['inherit', 'pipe', 'pipe'], env });

  const out = new Scanner(print);
  const err = new Scanner(print);
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    out.push(chunk.toString('utf8'));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    err.push(chunk.toString('utf8'));
  });

  // The terminal already delivers Ctrl-C to the child; keep running until it exits.
  process.on('SIGINT', () => undefined);
  for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      if (child.exitCode === null) child.kill(signal);
    });
  }

  child.on('error', (error) => {
    const d = explain(error);
    if (d) print(d);
    else process.stderr.write(`whycrash: could not start ${file}: ${error.message}\n`);
    process.exit(127);
  });
  child.on('close', (code, signal) => {
    out.flush();
    err.flush();
    if (code !== null) process.exitCode = code;
    else if (signal) process.exitCode = 128 + (os.constants.signals[signal] ?? 1);
  });
}

function readStdin(onChunk: (text: string) => void, onEnd: () => void): void {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => onChunk(chunk));
  process.stdin.on('end', onEnd);
}

function main(): void {
  // `whycrash -- cmd | head` closes our stdout early; that must not crash the wrapper.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') throw error;
    });
  }
  const { flags, command, rest } = parseArgs(process.argv.slice(2));
  const color = flags.color ?? supportsColor(process.stderr);

  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (flags.version) {
    process.stdout.write(`${version()}\n`);
    return;
  }
  if (flags.list) {
    const width = Math.max(...builtinRules.map((r) => r.id.length));
    for (const rule of builtinRules)
      process.stdout.write(`${rule.id.padEnd(width)}  ${rule.summary ?? ''}\n`);
    return;
  }

  const runArgs =
    command ??
    (rest.length > 1 || (rest[0] !== undefined && !looksLikeErrorText(rest[0])) ? rest : undefined);
  if (runArgs) {
    if (flags.json)
      fail(
        '--json works with error text or piped input, not when running a command.\nPipe the output instead: <command> 2>&1 | whycrash --json',
      );
    runCommand(runArgs, color);
    return;
  }

  if (rest[0] !== undefined) {
    const results = diagnoseText(rest[0]);
    if (flags.json) process.stdout.write(`${JSON.stringify(results.map(toJson), null, 2)}\n`);
    else if (results.length)
      for (const d of results)
        process.stdout.write(format(d, { color: flags.color ?? supportsColor(process.stdout) }));
    else
      process.stderr.write(
        `whycrash: no known diagnosis for this error.\nTo run a command instead, put it after --: whycrash -- ${rest[0]}\n`,
      );
    process.exitCode = results.length ? 0 : 1;
    return;
  }

  if (process.stdin.isTTY) {
    process.stdout.write(HELP);
    return;
  }

  if (flags.json) {
    let text = '';
    readStdin(
      (chunk) => (text += chunk),
      () => process.stdout.write(`${JSON.stringify(diagnoseText(text).map(toJson), null, 2)}\n`),
    );
    return;
  }
  const scanner = new Scanner((d) => process.stderr.write(format(d, { color })));
  readStdin(
    (chunk) => {
      process.stdout.write(chunk);
      scanner.push(chunk);
    },
    () => scanner.flush(),
  );
}

main();
