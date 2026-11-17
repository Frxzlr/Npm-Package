import { parseErrorText } from './parse.js';
import { parseStack } from './stack.js';
import type { ErrorInfo } from './types.js';

const SKIP_PROPS = new Set(['message', 'stack', 'name', 'cause', 'errors', 'code']);
const MAX_DEPTH = 8;

function isPrimitive(value: unknown): value is string | number | boolean | bigint {
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint';
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (isPrimitive(value) || typeof value === 'symbol') return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return `[${typeof value}]`;
    }
  }
}

function withOriginal(info: ErrorInfo, original: unknown): ErrorInfo {
  Object.defineProperty(info, 'original', { value: original, enumerable: false });
  return info;
}

/** True if `value` already has the `ErrorInfo` shape. */
export function isErrorInfo(value: unknown): value is ErrorInfo {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<ErrorInfo>;
  return (
    typeof v.name === 'string' &&
    typeof v.message === 'string' &&
    Array.isArray(v.frames) &&
    Array.isArray(v.errors) &&
    typeof v.props === 'object' &&
    v.props !== null
  );
}

function nonError(value: unknown): ErrorInfo {
  return withOriginal(
    {
      name: 'NonError',
      message: describeValue(value),
      frames: [],
      props: { valueType: value === null ? 'null' : typeof value },
      errors: [],
    },
    value,
  );
}

function fromObject(value: object, depth: number, seen: WeakSet<object>): ErrorInfo {
  seen.add(value);
  const err = value as Record<string, unknown>;
  const ctorName = (value as { constructor?: { name?: unknown } }).constructor?.name;
  const name =
    typeof err.name === 'string' && err.name
      ? err.name
      : typeof ctorName === 'string' && ctorName !== 'Object'
        ? ctorName
        : 'Error';
  const message = typeof err.message === 'string' ? err.message : '';
  const stack = typeof err.stack === 'string' ? err.stack : undefined;
  const { frames, sourceHint } = parseStack(stack);

  const props: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    keys = [];
  }
  for (const key of keys) {
    if (SKIP_PROPS.has(key)) continue;
    let v: unknown;
    try {
      v = err[key];
    } catch {
      continue;
    }
    if (isPrimitive(v)) props[key] = v;
    else if (Array.isArray(v) && v.length <= 50 && v.every(isPrimitive)) props[key] = [...v];
  }

  const info: ErrorInfo = { name, message, frames, props, errors: [] };
  if (typeof err.code === 'string' && err.code) info.code = err.code;
  if (stack) info.stack = stack;
  if (sourceHint) info.sourceHint = sourceHint;

  if (depth < MAX_DEPTH) {
    let cause: unknown;
    try {
      cause = err.cause;
    } catch {
      cause = undefined;
    }
    if (cause !== undefined && !(typeof cause === 'object' && cause !== null && seen.has(cause))) {
      info.cause = fromThrown(cause, depth + 1, seen);
    }
    let errors: unknown;
    try {
      errors = err.errors;
    } catch {
      errors = undefined;
    }
    if (Array.isArray(errors)) {
      for (const item of errors.slice(0, 20)) {
        if (typeof item === 'object' && item !== null && seen.has(item)) continue;
        info.errors.push(fromThrown(item, depth + 1, seen));
      }
    }
  }
  return withOriginal(info, value);
}

/**
 * Normalize a thrown value. Strings and other primitives become a `NonError`: they were
 * thrown as-is, so they carry no stack trace.
 */
export function fromThrown(value: unknown, depth = 0, seen = new WeakSet<object>()): ErrorInfo {
  try {
    if (isErrorInfo(value)) return value;
    if (typeof value === 'object' && value !== null) {
      const v = value as Record<string, unknown>;
      const looksLikeError =
        value instanceof Error ||
        typeof v.message === 'string' ||
        typeof v.stack === 'string' ||
        typeof v.code === 'string';
      if (looksLikeError) return fromObject(value, depth, seen);
    }
  } catch {
    // Hostile objects (throwing getters, revoked proxies) fall through to NonError.
  }
  return nonError(value);
}

/**
 * Normalize anything `explain()` accepts: an `Error`, any thrown value, an `ErrorInfo`, or
 * error text such as a pasted stack trace.
 */
export function toErrorInfo(input: unknown): ErrorInfo {
  if (typeof input === 'string') {
    const parsed = parseErrorText(input);
    if (parsed[0]) return parsed[0];
    const text = input.trim();
    // A bare error code ("ECONNREFUSED", "ERR_REQUIRE_ESM") is a useful query on its own.
    if (/^(?:E[A-Z0-9]+|ERR_[A-Z0-9_]+|[A-Z][A-Z0-9_]{3,})$/.test(text)) {
      return { name: 'Error', message: '', code: text, frames: [], props: {}, errors: [] };
    }
    return { name: 'Error', message: text, frames: [], props: {}, errors: [] };
  }
  return fromThrown(input);
}
