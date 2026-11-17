import { fileURLToPath } from 'node:url';
import type { SourceLocation, StackFrame } from './types.js';

const FRAME_LINE = /^\s*at\s+\S/;
const VITEST_FRAME_LINE = /^\s*❯\s+\S+:\d+/;

/** True if `line` looks like a V8 stack frame (`    at fn (file:1:2)`) or a Vitest frame (`❯ file:1:2`). */
export function isFrameLine(line: string): boolean {
  return FRAME_LINE.test(line) || VITEST_FRAME_LINE.test(line);
}

/** Convert `file:///x/y.js` to a path; leave everything else alone. */
export function toPath(file: string): string {
  if (file.startsWith('file://')) {
    try {
      return fileURLToPath(file);
    } catch {
      return file;
    }
  }
  return file;
}

function isInternalFile(file: string): boolean {
  return (
    file.startsWith('node:') ||
    file.startsWith('internal/') ||
    file === '<anonymous>' ||
    file === 'native' ||
    file.startsWith('evalmachine.') ||
    file.startsWith('index ') ||
    !/[\\/]/.test(file)
  );
}

function isDependencyFile(file: string): boolean {
  return /[\\/]node_modules[\\/]/.test(file);
}

/**
 * Parse a single stack line. Handles `at fn (loc)`, `at loc`, `at async fn (loc)`,
 * `at new Foo (loc)`, `at fn [as alias] (loc)` and nested eval locations.
 */
export function parseFrame(line: string): StackFrame | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith('❯ ')) {
    // Vitest: "❯ src/a.ts:3:7" or "❯ fnName src/a.ts:3:7"
    const parts = trimmed.slice(2).trim().split(/\s+/);
    const loc = parts.pop() ?? '';
    const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(loc);
    if (!m?.[1]) return undefined;
    const file = toPath(m[1]);
    const frame: StackFrame = {
      file,
      line: Number(m[2]),
      isInternal: isInternalFile(file),
      isDependency: isDependencyFile(file),
    };
    if (m[3]) frame.column = Number(m[3]);
    if (parts.length) frame.fn = parts.join(' ');
    return frame;
  }
  if (!trimmed.startsWith('at ')) return undefined;
  let body = trimmed.slice(3).trim();
  if (body.startsWith('async ')) body = body.slice(6).trimStart();
  if (body.endsWith(' {')) body = body.slice(0, -2).trimEnd();

  let fn: string | undefined;
  let location = body;
  if (body.endsWith(')')) {
    // Find the "(" that opens the trailing location group.
    let depth = 0;
    for (let i = body.length - 1; i >= 0; i--) {
      const ch = body[i];
      if (ch === ')') depth++;
      else if (ch === '(') {
        depth--;
        if (depth === 0) {
          const before = body.slice(0, i).trim();
          if (before) {
            fn = before;
            location = body.slice(i + 1, -1);
          }
          break;
        }
      }
    }
  }
  // Nested eval frames: "eval at foo (file.js:1:2), <anonymous>:1:1" → use the outer file.
  const evalMatch = /^eval at .*?\((.+?)\)/.exec(location);
  if (evalMatch?.[1]) location = evalMatch[1];

  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(location);
  const file = toPath(m?.[1] ?? location);
  const frame: StackFrame = {
    file,
    isInternal: isInternalFile(file),
    isDependency: isDependencyFile(file),
  };
  if (fn) frame.fn = fn;
  if (m?.[2]) frame.line = Number(m[2]);
  if (m?.[3]) frame.column = Number(m[3]);
  return frame;
}

const CARET_LINE = /^\s*\^+\s*$/;
const LOCATION_LINE = /^(.+?):(\d+)$/;

/**
 * Find Node's "source arrow" block that precedes an error header:
 *
 *     /app/index.js:3
 *     const x = ;
 *               ^
 *
 * `lines` are the lines *before* the header. The closest block that points at a non-internal
 * file wins (Node sometimes prints an internal block first).
 */
export function findSourceHint(
  lines: readonly string[],
): (SourceLocation & { snippet?: string }) | undefined {
  const start = Math.max(0, lines.length - 12);
  for (let i = lines.length - 1; i >= start + 2; i--) {
    if (!CARET_LINE.test(lines[i] ?? '')) continue;
    const locLine = lines[i - 2] ?? '';
    const m = LOCATION_LINE.exec(locLine.trim());
    if (!m?.[1] || !m[2]) continue;
    const file = toPath(m[1]);
    if (isInternalFile(file)) continue;
    const caret = lines[i] ?? '';
    const column = caret.indexOf('^') + 1;
    const hint: SourceLocation & { snippet?: string } = { file, line: Number(m[2]) };
    if (column > 0) hint.column = column;
    const snippet = lines[i - 1];
    if (snippet !== undefined) hint.snippet = snippet;
    return hint;
  }
  return undefined;
}

/** Parse an `error.stack` string into frames plus an optional source hint. */
export function parseStack(stack: string | undefined): {
  frames: StackFrame[];
  sourceHint?: SourceLocation & { snippet?: string };
} {
  if (!stack) return { frames: [] };
  const lines = stack.split(/\r?\n/);
  const frames: StackFrame[] = [];
  let firstFrame = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isFrameLine(line)) {
      if (firstFrame < 0) firstFrame = i;
      const frame = parseFrame(line);
      if (frame) frames.push(frame);
    }
  }
  // A source hint can only appear before the "Name: message" header line.
  const headerIndex = lines.findIndex((l) => /^[\w$.]*(?:Error|Exception)\b.*?:/.test(l));
  const preamble = headerIndex > 0 ? lines.slice(0, headerIndex) : [];
  const sourceHint = preamble.length ? findSourceHint(preamble) : undefined;
  return sourceHint ? { frames, sourceHint } : { frames };
}
