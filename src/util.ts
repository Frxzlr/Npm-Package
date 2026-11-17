import path from 'node:path';
import type { PackageManager } from './types.js';

/** Wrap text in backticks (rendered as code by `format()`). */
export function code(text: string | number): string {
  return `\`${text}\``;
}

/** Edit distance with transpositions (optimal string alignment). */
export function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[] = new Array<number>(rows * cols).fill(0);
  const at = (i: number, j: number) => d[i * cols + j] as number;
  for (let i = 0; i < rows; i++) d[i * cols] = i;
  for (let j = 0; j < cols; j++) d[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, at(i - 2, j - 2) + 1);
      }
      d[i * cols + j] = v;
    }
  }
  return at(a.length, b.length);
}

/** The closest candidate within a sensible edit distance, if any. */
export function closest(input: string, candidates: Iterable<string>): string | undefined {
  const limit = Math.max(1, Math.min(3, Math.floor(input.length / 3)));
  let best: string | undefined;
  let bestScore = Infinity;
  const lower = input.toLowerCase();
  for (const candidate of candidates) {
    if (candidate === input) continue;
    const score = distance(lower, candidate.toLowerCase());
    if (score <= limit && score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** `true` for package specifiers such as `lodash`, `@scope/pkg/sub` (not paths or URLs). */
export function isBareSpecifier(spec: string): boolean {
  return (
    !!spec &&
    !spec.startsWith('.') &&
    !spec.startsWith('/') &&
    !spec.startsWith('\\') &&
    !/^[a-zA-Z]:[\\/]/.test(spec) &&
    !/^[a-z][a-z0-9+.-]*:/i.test(spec)
  );
}

/** `@scope/pkg/sub/path` → `@scope/pkg`, `lodash/fp` → `lodash`. */
export function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec);
}

/** The package that contains `file` (based on its last `node_modules` segment). */
export function packageFromPath(file: string): { name: string; root: string } | undefined {
  const normalized = file.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/node_modules/');
  if (idx === -1) return undefined;
  const rest = normalized.slice(idx + '/node_modules/'.length).split('/');
  const name = rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1] ?? ''}` : (rest[0] ?? '');
  if (!name) return undefined;
  return { name, root: `${normalized.slice(0, idx)}/node_modules/${name}` };
}

/** A short, readable path: relative to `cwd` when inside it. */
export function displayPath(file: string, cwd: string): string {
  if (!path.isAbsolute(file)) return file;
  const rel = path.relative(cwd, file);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return file;
}

/** A relative import specifier from `fromFile` to `toFile` (always starting with `./` or `../`). */
export function relativeSpecifier(fromFile: string, toFile: string): string {
  let rel = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

export function installCommand(pm: PackageManager, pkg: string): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm add ${pkg}`;
    case 'yarn':
      return `yarn add ${pkg}`;
    case 'bun':
      return `bun add ${pkg}`;
    default:
      return `npm install ${pkg}`;
  }
}

export function installAllCommand(pm: PackageManager): string {
  return pm === 'yarn' ? 'yarn install' : `${pm} install`;
}

const SERVICES: Record<number, string> = {
  1433: 'SQL Server',
  2181: 'ZooKeeper',
  3306: 'MySQL/MariaDB',
  4317: 'an OpenTelemetry collector',
  5432: 'PostgreSQL',
  5672: 'RabbitMQ',
  6333: 'Qdrant',
  6379: 'Redis',
  7700: 'Meilisearch',
  8123: 'ClickHouse',
  8983: 'Solr',
  9092: 'Kafka',
  9200: 'Elasticsearch/OpenSearch',
  9229: 'the Node.js inspector',
  11434: 'Ollama',
  26257: 'CockroachDB',
  27017: 'MongoDB',
  54321: 'the local Supabase API',
  54322: 'the local Supabase database',
};

/** The service that conventionally listens on `port`, if well known. */
export function serviceForPort(port: number | undefined): string | undefined {
  return port === undefined ? undefined : SERVICES[port];
}

/** Read a numeric property that may be a number or a numeric string. */
export function numberProp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

export function stringProp(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Major Node.js version for a NODE_MODULE_VERSION (ABI), from nodejs/node's abi_version_registry.json. */
const ABI_TO_NODE: Record<number, number> = {
  64: 10,
  67: 11,
  72: 12,
  79: 13,
  83: 14,
  88: 15,
  93: 16,
  102: 17,
  108: 18,
  111: 19,
  115: 20,
  120: 21,
  127: 22,
  131: 23,
  137: 24,
  141: 25,
  147: 26, // verified against the Node.js 26 binary (the registry still lists it as a pre-release)
};

export function nodeMajorForAbi(abi: number): number | undefined {
  return ABI_TO_NODE[abi];
}
