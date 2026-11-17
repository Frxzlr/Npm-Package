/** Helpers that read a single line of JavaScript/TypeScript and recover expressions from it. */

const MAX_LINE = 2000;
const IDENT = /[\w$]/;
const KEYWORDS = new Set([
  'return',
  'typeof',
  'await',
  'new',
  'delete',
  'void',
  'in',
  'of',
  'case',
  'throw',
  'yield',
  'else',
]);

interface Scan {
  /** `true` where the character is code (not inside a string, template or comment). */
  code: boolean[];
  /** Closing bracket index → opening bracket index. */
  match: Map<number, number>;
}

function scanLine(line: string): Scan {
  const code: boolean[] = new Array<boolean>(line.length).fill(true);
  const match = new Map<number, number>();
  const stack: number[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '/' && line[i + 1] === '/') {
      for (let j = i; j < line.length; j++) code[j] = false;
      break;
    }
    if (ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      const stop = end === -1 ? line.length : end + 2;
      for (let j = i; j < stop; j++) code[j] = false;
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, line.length);
      for (let k = i; k < stop; k++) code[k] = false;
      i = stop;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') stack.push(i);
    else if (ch === ')' || ch === ']' || ch === '}') {
      const open = stack.pop();
      if (open !== undefined) match.set(i, open);
    }
    i++;
  }
  return { code, match };
}

/**
 * The member/call expression that ends right before `end` (exclusive).
 * `expressionBefore("x = data.items.map(f)", 14)` → `"data.items"`.
 */
export function expressionBefore(line: string, end: number): string | undefined {
  if (line.length > MAX_LINE || end <= 0 || end > line.length) return undefined;
  const { code, match } = scanLine(line);
  let i = end - 1;
  while (i >= 0) {
    const ch = line[i] ?? '';
    if (!code[i]) {
      // A string literal receiver, e.g. "abc".foo — include it whole.
      let j = i;
      while (j > 0 && !code[j - 1]) j--;
      i = j - 1;
      continue;
    }
    if (ch === ')' || ch === ']') {
      const open = match.get(i);
      if (open === undefined) break;
      i = open - 1;
      continue;
    }
    if (IDENT.test(ch) || ch === '!') {
      i--;
      continue;
    }
    if (ch === '.') {
      i -= line[i - 1] === '?' ? 2 : 1;
      continue;
    }
    break;
  }
  let expr = line.slice(i + 1, end).trim();
  if (expr.startsWith('...')) expr = expr.slice(3);
  if (!expr || expr.startsWith('.') || KEYWORDS.has(expr) || /^\d/.test(expr)) return undefined;
  return expr;
}

function isIdentBoundary(line: string, start: number, length: number): boolean {
  return !IDENT.test(line[start - 1] ?? '') && !IDENT.test(line[start + length] ?? '');
}

/** Index where the receiver of an accessor ends, given the position of `.prop` / `?.prop` / `[`. */
function accessorStart(line: string, propStart: number): number | undefined {
  if (line[propStart - 1] === '.')
    return line[propStart - 2] === '?' ? propStart - 2 : propStart - 1;
  return undefined;
}

/**
 * Find the expression whose property `prop` was being read when V8 threw
 * "Cannot read properties of undefined (reading 'prop')". `column` is V8's 1-based column.
 */
export function receiverOf(
  line: string,
  column: number | undefined,
  prop: string,
): string | undefined {
  if (line.length > MAX_LINE) return undefined;
  const { code } = scanLine(line);
  const candidates: number[] = [];

  // Dot access: .prop / ?.prop
  if (/^[\w$]+$/.test(prop)) {
    let from = 0;
    for (;;) {
      const idx = line.indexOf(prop, from);
      if (idx === -1) break;
      from = idx + 1;
      if (!code[idx] || !isIdentBoundary(line, idx, prop.length)) continue;
      const end = accessorStart(line, idx);
      if (end !== undefined) candidates.push(end);
    }
  }
  // Bracket access with a literal key: ['prop'] / ["prop"] / [0]
  for (const literal of [`['${prop}']`, `["${prop}"]`, `[${prop}]`]) {
    let from = 0;
    for (;;) {
      const idx = line.indexOf(literal, from);
      if (idx === -1) break;
      from = idx + 1;
      if (code[idx])
        candidates.push(line[idx - 1] === '.' && line[idx - 2] === '?' ? idx - 2 : idx);
    }
  }
  // Computed access with a variable key: obj[key] — only when nothing more specific matched.
  if (candidates.length === 0) {
    for (let idx = 1; idx < line.length; idx++) {
      if (line[idx] === '[' && code[idx] && /[\w$)\]]/.test(line[idx - 1] ?? ''))
        candidates.push(idx);
    }
  }
  if (candidates.length === 0) return undefined;

  const target = column !== undefined ? column - 1 : 0;
  let best = candidates[0] as number;
  for (const c of candidates) {
    // V8 points at the property (reads) or just after it (writes); prefer accessors at or before it.
    const score = c <= target + 1 ? target - c : (c - target) * 4;
    const bestScore = best <= target + 1 ? target - best : (best - target) * 4;
    if (score < bestScore) best = c;
  }
  return expressionBefore(line, best);
}

/** The callee at a V8 call-site column, e.g. the `lib.default` in `lib.default()`. */
export function calleeAt(line: string, column: number | undefined): string | undefined {
  if (column === undefined || line.length > MAX_LINE) return undefined;
  const idx = column - 1;
  if (line[idx] === '(') return expressionBefore(line, idx);
  // `new Foo()` points at `new`.
  const rest = line.slice(idx);
  const m = /^new\s+([\w$.]+)/.exec(rest);
  if (m?.[1]) return m[1];
  return undefined;
}

/** Truncate long expressions for display. */
export function shorten(expr: string, max = 60): string {
  if (expr.length <= max) return expr;
  const half = Math.floor((max - 1) / 2);
  return `${expr.slice(0, half)}…${expr.slice(-half)}`;
}
