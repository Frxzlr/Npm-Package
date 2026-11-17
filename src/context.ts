import fs from 'node:fs';
import path from 'node:path';
import type {
  ErrorInfo,
  ExplainOptions,
  PackageManager,
  RuleContext,
  SourceLocation,
  StackFrame,
} from './types.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILES = 2000;
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx|vue|svelte|astro)$/;
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'tmp',
  'temp',
]);

/** Parse `v22.12.0` into numbers. */
export function parseVersion(version: string): [number, number, number] {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  return [Number(m?.[1] ?? 0), Number(m?.[2] ?? 0), Number(m?.[3] ?? 0)];
}

export function versionAtLeast(version: string, major: number, minor = 0, patch = 0): boolean {
  const [a, b, c] = parseVersion(version);
  if (a !== major) return a > major;
  if (b !== minor) return b > minor;
  return c >= patch;
}

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    // The working directory was deleted. Fall back to the entry script's folder.
    return path.dirname(path.resolve(process.argv[1] ?? '/'));
  }
}

/** Shared, cached, never-throwing filesystem helpers. */
export class Context implements RuleContext {
  readonly cwd: string;
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  root: ErrorInfo;
  parent?: ErrorInfo;

  private readonly files = new Map<string, string | null>();
  private readonly dirs = new Map<string, string[]>();
  private readonly containerOverride: boolean | undefined;
  private container: boolean | undefined;

  constructor(root: ErrorInfo, options: ExplainOptions = {}) {
    this.root = root;
    this.cwd = path.resolve(options.cwd ?? safeCwd());
    this.nodeVersion = options.nodeVersion ?? process.version;
    this.platform = options.platform ?? process.platform;
    this.containerOverride = options.inContainer;
  }

  /** A view of this context for a specific error in the chain. */
  forError(parent: ErrorInfo | undefined): RuleContext {
    const view = Object.create(this) as Context;
    view.parent = parent;
    return view;
  }

  resolve(file: string): string {
    return path.resolve(this.cwd, file);
  }

  nodeAtLeast(major: number, minor = 0, patch = 0): boolean {
    return versionAtLeast(this.nodeVersion, major, minor, patch);
  }

  readFile(file: string): string | undefined {
    const abs = this.resolve(file);
    const cached = this.files.get(abs);
    if (cached !== undefined) return cached ?? undefined;
    let content: string | null = null;
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile() && stat.size <= MAX_FILE_BYTES) content = fs.readFileSync(abs, 'utf8');
    } catch {
      content = null;
    }
    this.files.set(abs, content);
    return content ?? undefined;
  }

  readJson(file: string): unknown {
    const text = this.readFile(file);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
    } catch {
      return undefined;
    }
  }

  exists(file: string): boolean {
    try {
      fs.accessSync(this.resolve(file));
      return true;
    } catch {
      return false;
    }
  }

  isFile(file: string): boolean {
    try {
      return fs.statSync(this.resolve(file)).isFile();
    } catch {
      return false;
    }
  }

  isDirectory(file: string): boolean {
    try {
      return fs.statSync(this.resolve(file)).isDirectory();
    } catch {
      return false;
    }
  }

  readDir(dir: string): string[] {
    const abs = this.resolve(dir);
    const cached = this.dirs.get(abs);
    if (cached) return cached;
    let entries: string[];
    try {
      entries = fs.readdirSync(abs);
    } catch {
      entries = [];
    }
    this.dirs.set(abs, entries);
    return entries;
  }

  findUp(name: string, fromDir: string = this.cwd): string | undefined {
    let dir = this.resolve(fromDir);
    for (let i = 0; i < 64; i++) {
      const candidate = path.join(dir, name);
      if (this.exists(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
    return undefined;
  }

  realpath(file: string): string | undefined {
    try {
      return fs.realpathSync(this.resolve(file));
    } catch {
      return undefined;
    }
  }

  findInProject(literal: string, limit = 3): SourceLocation[] {
    const results: SourceLocation[] = [];
    if (!literal || !this.isFile(path.join(this.cwd, 'package.json'))) return results;
    let visited = 0;
    const walk = (dir: string, depth: number): void => {
      if (depth > 8 || results.length >= limit || visited >= MAX_SEARCH_FILES) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= limit || visited >= MAX_SEARCH_FILES) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile() || !SOURCE_FILE.test(entry.name)) continue;
        visited++;
        let text: string;
        try {
          if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
          text = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        const idx = text.indexOf(literal);
        if (idx === -1) continue;
        const before = text.slice(0, idx);
        const line = before.split('\n').length;
        const column = idx - before.lastIndexOf('\n');
        results.push({ file: full, line, column });
      }
    };
    walk(this.cwd, 0);
    return results;
  }

  userFrame(error: ErrorInfo = this.root): StackFrame | undefined {
    for (const frame of error.frames) {
      if (frame.isInternal || frame.isDependency || frame.line === undefined) continue;
      if (this.isFile(frame.file)) return { ...frame, file: this.resolve(frame.file) };
    }
    return undefined;
  }

  sourceLine(file: string, line: number): string | undefined {
    const text = this.readFile(file);
    if (text === undefined || line < 1) return undefined;
    return text.split(/\r?\n/)[line - 1];
  }

  packageManager(fromDir: string = this.cwd): PackageManager {
    const pkgPath = this.findUp('package.json', fromDir);
    const pkg = pkgPath ? this.readJson(pkgPath) : undefined;
    if (pkg && typeof pkg === 'object') {
      const field = (pkg as { packageManager?: unknown }).packageManager;
      if (typeof field === 'string') {
        const name = field.split('@')[0];
        if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name;
      }
    }
    const locks: Array<[string, PackageManager]> = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lock', 'bun'],
      ['bun.lockb', 'bun'],
      ['package-lock.json', 'npm'],
    ];
    let best: { depth: number; pm: PackageManager } | undefined;
    for (const [file, pm] of locks) {
      const found = this.findUp(file, fromDir);
      if (!found) continue;
      const depth = found.split(path.sep).length;
      if (!best || depth > best.depth) best = { depth, pm };
    }
    return best?.pm ?? 'npm';
  }

  inContainer(): boolean {
    if (this.containerOverride !== undefined) return this.containerOverride;
    if (this.container === undefined) {
      let result = false;
      if (this.platform === 'linux') {
        result =
          this.exists('/.dockerenv') ||
          this.exists('/run/.containerenv') ||
          /docker|containerd|kubepods|podman/.test(this.readFile('/proc/1/cgroup') ?? '');
      }
      this.container = result;
    }
    return this.container;
  }
}
