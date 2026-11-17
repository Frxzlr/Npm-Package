import fs from 'node:fs';
import type { Diagnosis, FormatOptions, SourceLocation } from './types.js';
import { displayPath } from './util.js';

type Style = (text: string) => string;

interface Palette {
  badge: Style;
  title: Style;
  dim: Style;
  code: Style;
  label: Style;
  error: Style;
  path: Style;
}

const sgr =
  (open: number, close: number): Style =>
  (text) =>
    `\u001b[${open}m${text}\u001b[${close}m`;
const identity: Style = (text) => text;

function palette(color: boolean): Palette {
  if (!color) {
    return {
      badge: identity,
      title: identity,
      dim: identity,
      code: identity,
      label: identity,
      error: identity,
      path: identity,
    };
  }
  const bold = sgr(1, 22);
  return {
    badge: (t) => `\u001b[1;37;41m${t}\u001b[0m`,
    title: bold,
    dim: sgr(2, 22),
    code: sgr(36, 39),
    label: (t) => bold(sgr(33, 39)(t)),
    error: sgr(31, 39),
    path: sgr(4, 24),
  };
}

/**
 * Should output to `stream` be colored? Honors `NO_COLOR`, `FORCE_COLOR` and `TERM=dumb`, then
 * falls back to whether the stream is a TTY.
 */
export function supportsColor(stream?: { isTTY?: boolean }): boolean {
  const env = process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined) return !['0', 'false'].includes(env.FORCE_COLOR);
  if (env.TERM === 'dumb') return false;
  return stream?.isTTY === true;
}

/** Length of text as displayed (backticks are hidden when colored). */
function visibleLength(text: string, color: boolean): number {
  return color ? text.replace(/`/g, '').length : text.length;
}

/** Split into words, keeping short `inline code` spans together so they don't break across lines. */
function tokens(paragraph: string, width: number, color: boolean): string[] {
  const out: string[] = [];
  let span: string[] | undefined;
  for (const word of paragraph.split(' ')) {
    if (span) {
      span.push(word);
      if ((word.match(/`/g) ?? []).length % 2 === 1) {
        const joined = span.join(' ');
        if (visibleLength(joined, color) <= width) out.push(joined);
        else out.push(...span);
        span = undefined;
      }
    } else if ((word.match(/`/g) ?? []).length % 2 === 1) {
      span = [word];
    } else {
      out.push(word);
    }
  }
  if (span) out.push(...span);
  return out;
}

function wrap(text: string, width: number, color: boolean): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let current = '';
    for (const word of tokens(paragraph, width, color)) {
      if (!current) current = word;
      else if (visibleLength(`${current} ${word}`, color) <= width) current += ` ${word}`;
      else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

/** Render `inline code` spans. State carries across wrapped lines. */
function renderInline(lines: string[], p: Palette, color: boolean): string[] {
  if (!color) return lines;
  let inCode = false;
  return lines.map((line) => {
    let out = '';
    let buf = '';
    for (const ch of line) {
      if (ch === '`') {
        out += inCode ? p.code(buf) : buf;
        buf = '';
        inCode = !inCode;
      } else buf += ch;
    }
    out += inCode ? p.code(buf) : buf;
    return out;
  });
}

function readLines(file: string): string[] | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return undefined;
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return undefined;
  }
}

function codeFrame(loc: SourceLocation, width: number, p: Palette): string[] {
  const lines = readLines(loc.file);
  if (!lines || loc.line > lines.length) return [];
  const start = Math.max(1, loc.line - 1);
  const end = Math.min(lines.length, loc.line + 1);
  const gutter = String(end).length;
  const maxText = Math.max(20, width - gutter - 8);
  // Keep the column visible on long lines.
  const col = Math.max(0, (loc.column ?? 1) - 1);
  const offset = col > maxText - 10 ? col - Math.floor(maxText / 2) : 0;
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    let text = (lines[n - 1] ?? '').replace(/\t/g, '  ');
    if (offset) text = text.length > offset + 1 ? `…${text.slice(offset + 1)}` : '';
    if (text.length > maxText) text = `${text.slice(0, maxText - 1)}…`;
    const num = String(n).padStart(gutter);
    const target = n === loc.line;
    const body = text.trimEnd();
    out.push(
      `  ${target ? p.error('›') : ' '} ${p.dim(`${num} │`)}${body ? ` ${target ? body : p.dim(body)}` : ''}`,
    );
    if (target && loc.column !== undefined) {
      const raw = (lines[n - 1] ?? '').slice(0, col);
      const tabs = (raw.match(/\t/g) ?? []).length;
      const caretCol = col + tabs - offset;
      out.push(
        `    ${p.dim(`${' '.repeat(gutter)} │`)} ${' '.repeat(Math.max(0, caretCol))}${p.error('^')}`,
      );
    }
  }
  return out;
}

const CONFIDENCE_NOTE: Record<string, string> = { medium: 'likely cause', low: 'possible cause' };

/**
 * Render a diagnosis for a terminal. Returns `''` for `undefined`, so
 * `console.error(format(explain(err)))` is always safe.
 */
export function format(diagnosis: Diagnosis | undefined, options: FormatOptions = {}): string {
  if (!diagnosis) return '';
  const color = options.color ?? supportsColor(process.stderr);
  const p = palette(color);
  const columns = (process.stderr as { columns?: number }).columns ?? 80;
  const width = Math.max(40, Math.min(options.width ?? columns, 100)) - 4;
  const cwd = options.cwd ?? safeCwd();

  const out: string[] = [''];
  const note = CONFIDENCE_NOTE[diagnosis.confidence];
  const titleLines = renderInline(wrap(diagnosis.title, width - 10, color), p, color);
  const badge = color ? p.badge(' whycrash ') : 'whycrash:';
  out.push(`${badge} ${p.title(titleLines[0] ?? '')}${note ? p.dim(` · ${note}`) : ''}`);
  for (const line of titleLines.slice(1))
    out.push(`${' '.repeat(color ? 11 : 10)}${p.title(line)}`);

  if (diagnosis.explanation) {
    out.push('');
    for (const line of renderInline(wrap(diagnosis.explanation, width, color), p, color))
      out.push(`  ${line}`);
  }

  if (diagnosis.fixes.length) {
    out.push('', `  ${p.label('Try')}`);
    for (const fix of diagnosis.fixes) {
      const [first = '', ...codeLines] = fix.split('\n');
      const wrapped = renderInline(wrap(first, width - 4, color), p, color);
      wrapped.forEach((line, i) => out.push(`  ${i === 0 ? p.dim('›') : ' '} ${line}`));
      for (const codeLine of codeLines) out.push(`      ${p.code(codeLine)}`);
    }
  }

  if (diagnosis.location && options.codeFrame !== false) {
    const loc = diagnosis.location;
    const where = `${displayPath(loc.file, cwd)}:${loc.line}${loc.column !== undefined ? `:${loc.column}` : ''}`;
    out.push('', `  ${p.path(where)}`);
    out.push(...codeFrame(loc, width, p));
  }

  if (diagnosis.docs) out.push('', `  ${p.dim('Docs')} ${p.dim(diagnosis.docs)}`);
  out.push('');
  return out.join('\n');
}

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return '/';
  }
}
