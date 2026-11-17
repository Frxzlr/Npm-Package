import fs from 'node:fs';
import { explain } from './explain.js';
import { format, supportsColor } from './format.js';
import { fromThrown } from './normalize.js';
import type { Diagnosis, ExplainOptions, FormatOptions } from './types.js';

/** Anything with a `write(text)` method, such as `process.stderr`. */
export interface OutputStream {
  write(text: string): unknown;
  isTTY?: boolean;
}

export interface ReportOptions extends ExplainOptions, FormatOptions {
  /** Where to write the diagnosis. Default `process.stderr`. */
  stream?: OutputStream;
}

export type RegisterOptions = ReportOptions;

const STATE = Symbol.for('whycrash.register');

function writeOut(stream: OutputStream, text: string): void {
  if (stream === process.stderr) {
    try {
      // Synchronous, so the text is out before the process exits.
      fs.writeSync(2, text);
      return;
    } catch {
      // fall through to the stream (e.g. EAGAIN on a non-blocking pipe)
    }
  }
  stream.write(text);
}

function render(diagnosis: Diagnosis, options: ReportOptions, stream: OutputStream): string {
  const formatOptions: FormatOptions = { color: options.color ?? supportsColor(stream) };
  if (options.width !== undefined) formatOptions.width = options.width;
  if (options.codeFrame !== undefined) formatOptions.codeFrame = options.codeFrame;
  if (options.cwd !== undefined) formatOptions.cwd = options.cwd;
  return format(diagnosis, formatOptions);
}

/** True when `WHYCRASH` is set to `0`, `false`, `off` or `no`. */
export function isDisabled(): boolean {
  const value = process.env.WHYCRASH;
  return value !== undefined && /^(?:0|false|off|no)$/i.test(value.trim());
}

/**
 * Diagnose an error you caught and print the diagnosis (to stderr by default).
 * Returns the diagnosis, or `undefined` when no rule recognised the error.
 *
 * ```js
 * app.use((err, req, res, next) => { report(err); next(err); });
 * ```
 */
export function report(error: unknown, options: ReportOptions = {}): Diagnosis | undefined {
  const diagnosis = explain(fromThrown(error), options);
  if (diagnosis) {
    const stream = options.stream ?? process.stderr;
    writeOut(stream, render(diagnosis, options, stream));
  }
  return diagnosis;
}

/**
 * Print a diagnosis whenever the process crashes from an uncaught exception or unhandled
 * rejection. It only observes (via `uncaughtExceptionMonitor`): Node's own error output, exit
 * code and any handlers you registered behave exactly as before.
 *
 * Returns a function that removes the hook. Calling `register()` twice is a no-op.
 * Set `WHYCRASH=0` to disable it without touching code.
 */
export function register(options: RegisterOptions = {}): () => void {
  if (isDisabled()) return () => undefined;
  const store = process as unknown as Record<symbol, (() => void) | undefined>;
  const existing = store[STATE];
  if (existing) return existing;

  const stream = options.stream ?? process.stderr;
  const seen = new WeakSet<object>();
  const listener = (error: unknown): void => {
    try {
      if (typeof error === 'object' && error !== null) {
        if (seen.has(error)) return;
        seen.add(error);
      }
      const diagnosis = explain(fromThrown(error), options);
      if (!diagnosis) return;
      let text = render(diagnosis, options, stream);
      // Node prints the original error right after us unless the app handles it itself.
      if (process.listenerCount('uncaughtException') === 0) {
        const color = options.color ?? supportsColor(stream);
        text += `${color ? '\u001b[2m' : ''}  ↓ original error${color ? '\u001b[22m' : ''}\n\n`;
      }
      writeOut(stream, text);
    } catch {
      // Never interfere with crash handling.
    }
  };
  process.on('uncaughtExceptionMonitor', listener);
  const unregister = (): void => {
    process.off('uncaughtExceptionMonitor', listener);
    if (store[STATE] === unregister) store[STATE] = undefined;
  };
  store[STATE] = unregister;
  return unregister;
}
