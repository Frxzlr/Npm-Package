import { findSourceHint, isFrameLine, parseFrame, toPath } from './stack.js';
import type { ErrorInfo } from './types.js';

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Remove ANSI color and hyperlink escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * An error header line as printed by Node.js / util.inspect:
 * `TypeError: msg`, `Error [ERR_X]: msg`, `AggregateError [ECONNREFUSED]: `,
 * `DOMException [TimeoutError]: msg`, `Uncaught TypeError: msg`, ` ⨯ TypeError: msg`.
 */
const HEADER =
  /^(?<prefix>.*?)(?<![\w$.])(?<name>[A-Z][\w$]*(?:Error|Exception|Rejection)|Error|DOMException)(?: \[(?<tag>[^\]\s]+)\])?:(?: (?<message>.*))?$/;
const CODE_TAG = /^(?:E[A-Z0-9]+|ERR_[A-Z0-9_]+|[A-Z0-9]+(?:_[A-Z0-9]+)+)$/;
const CODE_IN_TEXT = /\b(?:E[A-Z]{3,}|ERR_[A-Z0-9_]+)\b/;
const PROP_LINE = /^\s*(?:[\w$]+|'[^']+'|\[[^\]]+\]): /;
const CODE_FRAME_LINE = /^\s*(?:>\s*)?\d+\s*\||^\s*\|/;

interface Cursor {
  readonly lines: string[];
  i: number;
}

type HeaderMatch = { name: string; tag?: string; message: string };

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function matchHeader(text: string): HeaderMatch | undefined {
  if (isFrameLine(text)) return undefined;
  const m = HEADER.exec(text);
  if (!m?.groups?.name) return undefined;
  const prefix = m.groups.prefix ?? '';
  // Avoid matching inside quoted strings or code such as `new TypeError(`.
  if (/['"`(]\s*$/.test(prefix)) return undefined;
  let message = m.groups.message ?? '';
  // util.inspect prints errors without a stack in brackets: `[TypeError: fetch failed] {`.
  if (/\[\s*$/.test(prefix)) message = message.replace(/\](?=(?: \{)?$)/, '');
  const out: HeaderMatch = { name: m.groups.name, message };
  if (m.groups.tag) out.tag = m.groups.tag;
  return out;
}

function unquote(raw: string): string | undefined {
  const q = raw[0];
  if ((q === "'" || q === '"' || q === '`') && raw.endsWith(q) && raw.length >= 2) {
    return raw
      .slice(1, -1)
      .replace(/\\(['"`\\])/g, '$1')
      .replace(/\\n/g, '\n');
  }
  return undefined;
}

/** `[ 'a', 'b' ]` → ['a', 'b'] (only arrays of quoted strings). */
function parseInlineArray(raw: string): string[] | undefined {
  const inner = /^\[\s*(.*?)\s*\]$/.exec(raw)?.[1];
  if (inner === undefined) return undefined;
  if (inner === '') return [];
  const items: string[] = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
  let rest = inner;
  for (const m of inner.matchAll(re)) {
    items.push((m[1] ?? m[2] ?? '').replace(/\\(['"\\])/g, '$1'));
    rest = rest.replace(m[0], '');
  }
  return /^[\s,]*$/.test(rest) ? items : undefined;
}

function parseScalar(raw: string): unknown {
  const s = unquote(raw);
  if (s !== undefined) return s;
  if (raw.startsWith('[')) return parseInlineArray(raw);
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  return undefined;
}

/** Skip a `{ ... }` or `[ ... ]` structure that opened on the current line. */
function skipStructure(cur: Cursor, indent: number): void {
  cur.i++;
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? '';
    const t = line.trim();
    if (indentOf(line) <= indent && /^[}\]]/.test(t)) {
      cur.i++;
      return;
    }
    if (t === '') return;
    cur.i++;
  }
}

function parseStringArray(cur: Cursor, indent: number): string[] | undefined {
  const items: string[] = [];
  let ok = true;
  cur.i++;
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? '';
    const t = line.trim();
    if (indentOf(line) <= indent && /^\]/.test(t)) {
      cur.i++;
      break;
    }
    if (t === '') break;
    const s = unquote(t.replace(/,$/, ''));
    if (s === undefined) ok = false;
    else items.push(s);
    cur.i++;
  }
  return ok ? items : undefined;
}

function parseErrorsArray(cur: Cursor, info: ErrorInfo, indent: number): void {
  cur.i++;
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? '';
    const t = line.trim();
    const ind = indentOf(line);
    if (ind <= indent && /^\],?$/.test(t)) {
      cur.i++;
      return;
    }
    if (t === '') return;
    const header = ind > indent ? matchHeader(t) : undefined;
    if (header) {
      info.errors.push(parseBlock(cur, header, ind, true));
      continue;
    }
    cur.i++;
  }
}

function parseProps(cur: Cursor, info: ErrorInfo, blockIndent: number): void {
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? '';
    const t = line.trim();
    const ind = indentOf(line);
    if (t === '') return;
    if (ind <= blockIndent) {
      if (/^},?$/.test(t)) cur.i++;
      return;
    }
    const cause = /^\[cause\]: (.*)$/.exec(t);
    if (cause) {
      const causeText = cause[1] ?? '';
      const header = matchHeader(causeText);
      if (header) {
        info.cause = parseBlock(cur, header, ind, true);
      } else {
        const value = parseScalar(causeText);
        info.cause = {
          name: 'NonError',
          message: value === undefined ? causeText : String(value),
          frames: [],
          props: {},
          errors: [],
        };
        if (/[{[]$/.test(causeText)) skipStructure(cur, ind);
        else cur.i++;
      }
      continue;
    }
    if (/^\[errors\]: \[$/.test(t)) {
      parseErrorsArray(cur, info, ind);
      continue;
    }
    const kv = /^([\w$]+|'[^']+'): (.*?),?$/.exec(t);
    if (kv?.[1] !== undefined && kv[2] !== undefined) {
      const key = unquote(kv[1]) ?? kv[1];
      const raw = kv[2];
      if (raw === '[') {
        const arr = parseStringArray(cur, ind);
        if (arr) info.props[key] = arr;
        continue;
      }
      if (/[{[]$/.test(raw)) {
        skipStructure(cur, ind);
        continue;
      }
      const value = parseScalar(raw);
      if (value !== undefined) info.props[key] = value;
      cur.i++;
      continue;
    }
    if (/[{[]$/.test(t)) skipStructure(cur, ind);
    else cur.i++;
  }
}

/** After a blank line, look past a Jest-style code frame to see whether stack frames follow. */
function framesAfterCodeFrame(cur: Cursor): number | undefined {
  for (let j = cur.i; j < Math.min(cur.lines.length, cur.i + 20); j++) {
    const line = cur.lines[j] ?? '';
    if (isFrameLine(line)) return j;
    if (line.trim() === '' || CODE_FRAME_LINE.test(line)) continue;
    return undefined;
  }
  return undefined;
}

function parseBlock(
  cur: Cursor,
  header: HeaderMatch,
  blockIndent: number,
  nested: boolean,
): ErrorInfo {
  const info: ErrorInfo = { name: header.name, message: '', frames: [], props: {}, errors: [] };
  if (header.tag) {
    if (CODE_TAG.test(header.tag)) info.code = header.tag;
    else info.name = header.tag;
  }
  let message = header.message;
  cur.i++;

  let openProps = false;
  const next = cur.lines[cur.i] ?? '';
  if (message.endsWith(' {') && PROP_LINE.test(next) && indentOf(next) > blockIndent) {
    message = message.slice(0, -2);
    openProps = true;
  }

  const messageLines = [message.trimEnd()];
  if (!openProps) {
    // Continuation lines belong to the message only if stack frames follow them.
    const start = cur.i;
    const extra: string[] = [];
    let j = cur.i;
    let framesAt: number | undefined;
    while (j < cur.lines.length && j - start < 25) {
      const line = cur.lines[j] ?? '';
      if (isFrameLine(line)) {
        framesAt = j;
        break;
      }
      if (line.trim() === '') {
        framesAt = framesAfterCodeFrame({ lines: cur.lines, i: j });
        break;
      }
      if (nested && indentOf(line) <= blockIndent) break;
      if (/^\s*[}\]],?$/.test(line) || /^\s*Node\.js v\d/.test(line)) break;
      if (matchHeader(line.trim()) && indentOf(line) <= blockIndent) break;
      extra.push(line.slice(Math.min(indentOf(line), nested ? blockIndent + 2 : 0)).trimEnd());
      j++;
    }
    if (framesAt !== undefined) {
      messageLines.push(...extra);
      cur.i = framesAt;
    }
  }
  info.message = messageLines.join('\n').trimEnd();

  if (!openProps) {
    let emitted = false;
    while (cur.i < cur.lines.length) {
      const line = cur.lines[cur.i] ?? '';
      if (isFrameLine(line)) {
        if (!emitted) {
          const frame = parseFrame(line);
          if (frame) info.frames.push(frame);
        }
        cur.i++;
        if (line.trimEnd().endsWith(' {')) {
          openProps = true;
          break;
        }
        continue;
      }
      if (/^\s*Emitted 'error' event .* at:\s*$/.test(line)) {
        emitted = true;
        cur.i++;
        continue;
      }
      if (/^\s*\.\.\. \d+ lines? matching cause stack trace \.\.\.\s*$/.test(line)) {
        cur.i++;
        continue;
      }
      break;
    }
  }

  if (openProps) parseProps(cur, info, blockIndent);
  if (!info.code && typeof info.props.code === 'string') info.code = info.props.code;
  delete info.props.code;
  return info;
}

function parseSpecial(cur: Cursor): ErrorInfo | undefined {
  const line = (cur.lines[cur.i] ?? '').trim();
  // A thrown non-Error: Node prints the source arrow, the raw value, then this hint line.
  if (
    /^\(Use `node --trace-uncaught \.\.\.` to show where the exception was thrown\)$/.test(line)
  ) {
    let caret = cur.i - 1;
    while (caret >= 0 && caret >= cur.i - 30 && !/^\s*\^+\s*$/.test(cur.lines[caret] ?? ''))
      caret--;
    const value = cur.lines
      .slice(caret + 1, cur.i)
      .join('\n')
      .trim();
    cur.i++;
    if (caret < 0 || !value) return undefined;
    const info: ErrorInfo = { name: 'NonError', message: value, frames: [], props: {}, errors: [] };
    const hint = findSourceHint(cur.lines.slice(Math.max(0, caret - 11), caret + 1));
    if (hint) info.sourceHint = hint;
    return info;
  }
  const fatal = /^FATAL ERROR: (.+)$/.exec(line);
  if (fatal?.[1]) {
    cur.i++;
    return { name: 'FatalError', message: fatal[1], frames: [], props: {}, errors: [] };
  }
  const tla = /Warning: Detected unsettled top-level await at (.+):(\d+)$/.exec(line);
  if (tla?.[1] && tla[2]) {
    cur.i++;
    const info: ErrorInfo = {
      name: 'Warning',
      message: 'Detected unsettled top-level await',
      frames: [],
      props: {},
      errors: [],
      sourceHint: { file: toPath(tla[1]), line: Number(tla[2]) },
    };
    const snippet = cur.lines[cur.i];
    if (snippet !== undefined && snippet.trim() && info.sourceHint)
      info.sourceHint.snippet = snippet;
    return info;
  }
  return undefined;
}

/**
 * Find every error in a block of text: terminal output, a log file or a pasted stack trace.
 * Understands Node's uncaught-error output, `util.inspect` formatting (including `[cause]` and
 * `AggregateError` `[errors]`), Node's source arrow, and Jest/Vitest-style frames.
 */
export function parseErrorText(text: string): ErrorInfo[] {
  const lines = stripAnsi(text).replace(/\r\n?/g, '\n').split('\n');
  const standalone = lines.filter((l) => l.trim()).length <= 3;
  const cur: Cursor = { lines, i: 0 };
  const results: ErrorInfo[] = [];

  while (cur.i < lines.length) {
    const special = parseSpecial(cur);
    if (special) {
      results.push(special);
      continue;
    }
    const line = lines[cur.i] ?? '';
    const header = matchHeader(line);
    if (!header) {
      cur.i++;
      continue;
    }
    const start = cur.i;
    const info = parseBlock(cur, header, indentOf(line), false);
    if (cur.i === start) cur.i++;
    const hint = findSourceHint(lines.slice(Math.max(0, start - 12), start));
    if (hint) info.sourceHint = hint;
    const accepted =
      standalone ||
      info.frames.length > 0 ||
      info.code !== undefined ||
      info.cause !== undefined ||
      info.errors.length > 0 ||
      CODE_IN_TEXT.test(info.message);
    if (accepted) results.push(info);
  }
  return results;
}
