/** A single parsed V8 stack frame. */
export interface StackFrame {
  /** Function name as printed by V8, e.g. `Server.listen` or `async loadUser`. */
  fn?: string;
  /** File path (file: URLs are converted to paths), `node:...` for internals, or `<anonymous>`. */
  file: string;
  /** 1-based line number. */
  line?: number;
  /** 1-based column number. */
  column?: number;
  /** True for frames inside Node.js itself (`node:` modules, `<anonymous>`, native code). */
  isInternal: boolean;
  /** True for frames inside a `node_modules` folder. */
  isDependency: boolean;
}

/** A position in a source file. */
export interface SourceLocation {
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column?: number;
}

/**
 * A normalized view of an error, built either from a live `Error` object or from error text
 * (a pasted stack trace or a process's stderr). Rules only ever see this shape.
 */
export interface ErrorInfo {
  /** `TypeError`, `Error`, `AggregateError`, ... (`NonError` when a non-Error value was thrown). */
  name: string;
  message: string;
  /** Node.js error code such as `ECONNREFUSED` or `ERR_REQUIRE_ESM`. */
  code?: string;
  stack?: string;
  frames: StackFrame[];
  /** Extra primitive properties: `errno`, `syscall`, `address`, `port`, `path`, `hostname`, ... */
  props: Record<string, unknown>;
  /** The error's `cause`, if any. */
  cause?: ErrorInfo;
  /** Errors grouped by an `AggregateError`. */
  errors: ErrorInfo[];
  /**
   * Source position Node.js printed above the error ("file.js:3" + code + caret). Present for
   * syntax errors, which often have no useful stack frames.
   */
  sourceHint?: SourceLocation & { snippet?: string };
  /** The original thrown value when diagnosing a live error. Non-enumerable. */
  readonly original?: unknown;
}

/** How sure a rule is about its diagnosis. */
export type Confidence = 'high' | 'medium' | 'low';

/** What a rule returns when it recognises an error. */
export interface Finding {
  /** One line, specific, e.g. "Nothing is listening on localhost:5432". */
  title: string;
  /** Why it happened, in a sentence or three. Use `backticks` for code. */
  explanation: string;
  /** Concrete next steps, most likely fix first. A line break starts a code example. */
  fixes?: string[];
  /** The location in the user's code that matters most. */
  location?: SourceLocation;
  /** A link to relevant documentation. */
  docs?: string;
  /** Defaults to `'high'`. */
  confidence?: Confidence;
}

/** A finished diagnosis. */
export interface Diagnosis {
  /** Id of the rule that produced it, e.g. `connection-refused`. */
  id: string;
  title: string;
  explanation: string;
  fixes: string[];
  confidence: Confidence;
  location?: SourceLocation;
  docs?: string;
  /** The error in the cause chain that the rule matched. */
  error: ErrorInfo;
}

/** A diagnosis rule. Built-in rules use exactly this interface, and so can yours. */
export interface Rule {
  /** Unique id. Prefix your own rules, e.g. `acme/db-not-running`. */
  id: string;
  /** One-line description shown by `whycrash --list`. */
  summary?: string;
  /** Return a finding when the rule recognises `error`; return nothing otherwise. */
  diagnose(error: ErrorInfo, context: RuleContext): Finding | null | undefined | false;
}

/** Read-only helpers available to rules. Every helper is safe: it never throws. */
export interface RuleContext {
  /** Working directory used to resolve relative paths. */
  readonly cwd: string;
  /** Node.js version, e.g. `v22.12.0`. */
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  /** The outermost error being diagnosed. */
  readonly root: ErrorInfo;
  /** The error that wraps the current one (through `cause` or `AggregateError#errors`). */
  readonly parent?: ErrorInfo;
  /** True when the Node.js version is at least `major.minor.patch`. */
  nodeAtLeast(major: number, minor?: number, patch?: number): boolean;
  /** UTF-8 file contents, or `undefined` if unreadable. Results are cached. */
  readFile(file: string): string | undefined;
  /** Parsed JSON file, or `undefined`. */
  readJson(file: string): unknown;
  exists(file: string): boolean;
  isFile(file: string): boolean;
  isDirectory(file: string): boolean;
  /** Directory entries, or `[]`. */
  readDir(dir: string): string[];
  /** Walk up from `fromDir` and return the first path where `name` exists. */
  findUp(name: string, fromDir?: string): string | undefined;
  /** Resolve symlinks, or `undefined` if the path doesn't exist. */
  realpath(file: string): string | undefined;
  /**
   * Search the project's own source files (never `node_modules`, build output or dot-folders)
   * for a literal string. Only runs when `cwd` contains a package.json. Bounded and uncached.
   */
  findInProject(literal: string, limit?: number): SourceLocation[];
  /** First stack frame in the user's own code whose file exists on disk. */
  userFrame(error?: ErrorInfo): StackFrame | undefined;
  /** A single 1-based source line, if the file can be read. */
  sourceLine(file: string, line: number): string | undefined;
  /** The package manager the project uses, detected from lockfiles. */
  packageManager(fromDir?: string): PackageManager;
  /** True when the process appears to be running inside a container. */
  inContainer(): boolean;
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface ExplainOptions {
  /** Extra rules. They run before the built-in rules and win ties. */
  rules?: Rule[];
  /** Set to `false` to use only your own rules. Default `true`. */
  builtins?: boolean;
  /** Working directory used to resolve relative paths. Default `process.cwd()`. */
  cwd?: string;
  /** Override the Node.js version the diagnosis is written for. Default `process.version`. */
  nodeVersion?: string;
  /** Override the platform. Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Override container detection. */
  inContainer?: boolean;
}

export interface FormatOptions {
  /** Force colors on or off. Default: auto-detected from the output stream and environment. */
  color?: boolean;
  /** Maximum line width used for wrapping. Default: terminal width, capped at 100. */
  width?: number;
  /** Show a code frame for the diagnosis location. Default `true`. */
  codeFrame?: boolean;
  /** Working directory used to shorten file paths. Default `process.cwd()`. */
  cwd?: string;
}
