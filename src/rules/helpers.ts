import type { ErrorInfo, Finding, Rule, RuleContext, SourceLocation } from '../types.js';
import { numberProp, stringProp } from '../util.js';

/** Identity helper that gives rule objects full type inference. */
export function defineRule(rule: Rule): Rule {
  return rule;
}

const API = 'https://nodejs.org/api';

export const DOCS = {
  error: (code: string) => `${API}/errors.html#${code.toLowerCase()}`,
  systemErrors: `${API}/errors.html#common-system-errors`,
  mandatoryExtensions: `${API}/esm.html#mandatory-file-extensions`,
  requireEsm: `${API}/modules.html#loading-ecmascript-modules-using-require`,
  noDirname: `${API}/esm.html#no-__filename-or-__dirname`,
  noRequire: `${API}/esm.html#no-require-exports-or-moduleexports`,
  importAttributes: `${API}/esm.html#import-attributes`,
  moduleSystem: `${API}/packages.html#determining-module-system`,
  typeStripping: `${API}/typescript.html#type-stripping`,
  typescriptFeatures: `${API}/typescript.html#typescript-features`,
  extraCaCerts: `${API}/cli.html#node_extra_ca_certsfile`,
  maxOldSpace: `${API}/cli.html#--max-old-space-sizesize-in-mib`,
  opensslLegacy: `${API}/cli.html#--openssl-legacy-provider`,
} as const;

/** The most useful location for an error: the user's own frame, or Node's source arrow. */
export function locate(error: ErrorInfo, ctx: RuleContext): SourceLocation | undefined {
  const frame = ctx.userFrame(error) ?? (error !== ctx.root ? ctx.userFrame(ctx.root) : undefined);
  if (frame?.line !== undefined) {
    const loc: SourceLocation = { file: frame.file, line: frame.line };
    if (frame.column !== undefined) loc.column = frame.column;
    return loc;
  }
  const hint = error.sourceHint ?? ctx.root.sourceHint;
  if (hint && ctx.isFile(hint.file)) {
    const loc: SourceLocation = { file: hint.file, line: hint.line };
    if (hint.column !== undefined) loc.column = hint.column;
    return loc;
  }
  return undefined;
}

/** Find the first line in `file` matching `pattern`. */
export function findLine(
  ctx: RuleContext,
  file: string,
  pattern: RegExp,
): SourceLocation | undefined {
  const text = ctx.readFile(file);
  if (text === undefined) return undefined;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = pattern.exec(lines[i] ?? '');
    if (m) return { file, line: i + 1, column: m.index + 1 };
  }
  return undefined;
}

/** True when this error is one of several grouped by a parent with the same code. */
export function isAggregateChild(error: ErrorInfo, ctx: RuleContext): boolean {
  const parent = ctx.parent;
  return !!parent && parent.errors.includes(error) && !!error.code && parent.code === error.code;
}

/** True when the error chain came from `fetch()`. */
export function fromFetch(ctx: RuleContext): boolean {
  const isFetch = (e: ErrorInfo | undefined) =>
    !!e &&
    (e.message === 'fetch failed' ||
      e.message.startsWith('Failed to parse URL from') ||
      e.frames.some((f) => /undici/.test(f.file)));
  return isFetch(ctx.root) || isFetch(ctx.parent);
}

export interface Endpoint {
  address?: string;
  port?: number;
}

/** Network endpoints mentioned by an error and the errors it groups. */
export function endpoints(error: ErrorInfo): Endpoint[] {
  const out: Endpoint[] = [];
  const add = (e: ErrorInfo) => {
    let address = stringProp(e.props.address) ?? stringProp(e.props.host);
    let port = numberProp(e.props.port);
    if (!address) {
      const m =
        /\b(?:connect|E[A-Z]+)\s+(?:E[A-Z]+\s+)?([\w.:%-]+?):(\d+)\s*$/m.exec(e.message) ??
        /attempted address: ([\w.:%-]+?):(\d+)/.exec(e.message);
      if (m?.[1]) {
        address = m[1].replace(/^\[|\]$/g, '');
        port ??= numberProp(m[2]);
      }
    }
    if (!address && port === undefined) return;
    if (out.some((o) => o.address === address && o.port === port)) return;
    const ep: Endpoint = {};
    if (address) ep.address = address;
    if (port !== undefined) ep.port = port;
    out.push(ep);
  };
  add(error);
  for (const child of error.errors) add(child);
  return out.filter((ep, _i, all) => ep.address || all.length === 1);
}

const LOOPBACK = new Set(['::1', '127.0.0.1', 'localhost', '0.0.0.0', '::']);

export function isLoopback(address: string | undefined): boolean {
  return !!address && (LOOPBACK.has(address) || address.startsWith('127.'));
}

export function hostPort(address: string | undefined, port: number | undefined): string {
  const host = address?.includes(':') ? `[${address}]` : (address ?? 'localhost');
  return port === undefined ? host : `${host}:${port}`;
}

/** Compact helper so rule bodies read like prose. */
export function finding(f: Finding): Finding {
  if (f.fixes) f.fixes = f.fixes.filter((x): x is string => typeof x === 'string' && !!x);
  return f;
}

/** Fixes list that tolerates conditional entries. */
export function fixes(...items: Array<string | false | null | undefined>): string[] {
  return items.filter((x): x is string => typeof x === 'string' && !!x);
}
