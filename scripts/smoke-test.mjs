// Packs the package, installs the tarball into a fresh consumer project, and exercises every
// public entry point the way a user would: ESM import, CommonJS require, the register hook
// (--import and -r), the CLI bin, and the TypeScript declarations.
//
// Usage: npm run build && node scripts/smoke-test.mjs
// Works on Node.js 18+ (no dev dependencies needed; the TypeScript check is skipped if
// `typescript` is not installed in the repo).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const isWindows = process.platform === 'win32';
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'whycrash-smoke-')));
let failures = 0;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: isWindows && /^(npm|npx|tsc)$|\.cmd$/.test(command),
    timeout: 120_000,
    ...options,
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: undefined,
      NODE_OPTIONS: '',
      ...options.env,
    },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function check(name, fn) {
  try {
    const detail = fn();
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures++;
    console.log(
      `  ✗ ${name}\n      ${String(error && error.message ? error.message : error)
        .split('\n')
        .join('\n      ')}`,
    );
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log(`whycrash smoke test — Node.js ${process.version} on ${process.platform}`);

// 1. Pack ------------------------------------------------------------------------------------
const packed = run('npm', ['pack', '--json', '--pack-destination', work], { cwd: root });
if (packed.status !== 0) {
  console.error(packed.stderr);
  process.exit(1);
}
const packInfo = JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[')))[0];
const tarball = path.join(work, packInfo.filename);
const files = packInfo.files.map((f) => f.path);

check('tarball contains exactly the published files', () => {
  const required = [
    'package.json',
    'README.md',
    'LICENSE',
    'dist/index.js',
    'dist/index.cjs',
    'dist/index.d.ts',
    'dist/index.d.cts',
    'dist/register.js',
    'dist/register.cjs',
    'dist/register.d.ts',
    'dist/register.d.cts',
    'dist/cli.js',
  ];
  for (const file of required) assert(files.includes(file), `missing ${file}`);
  const forbidden = files.filter((f) =>
    /^(src|test|scripts|docs|demo|\.github|node_modules)\/|\.map$|^dist\/cli\.cjs$|tsconfig|vitest|tsup|eslint/.test(
      f,
    ),
  );
  assert(forbidden.length === 0, `unexpected files: ${forbidden.join(', ')}`);
  return `${files.length} files, ${(packInfo.size / 1024).toFixed(1)} kB packed, ${(packInfo.unpackedSize / 1024).toFixed(1)} kB unpacked`;
});

check('package has zero runtime dependencies', () => {
  assert(
    !pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
    'dependencies is not empty',
  );
});

// 2. Install into a fresh consumer ------------------------------------------------------------
const consumer = path.join(work, 'consumer');
fs.mkdirSync(consumer);
fs.writeFileSync(
  path.join(consumer, 'package.json'),
  JSON.stringify({ name: 'consumer', private: true }, null, 2),
);
const install = run('npm', ['install', tarball, '--no-audit', '--no-fund', '--ignore-scripts'], {
  cwd: consumer,
});
if (install.status !== 0) {
  console.error(install.stderr);
  process.exit(1);
}

check('installs without pulling in other packages', () => {
  const installed = fs
    .readdirSync(path.join(consumer, 'node_modules'))
    .filter((n) => !n.startsWith('.'));
  assert(installed.join() === 'whycrash', `node_modules contains: ${installed.join(', ')}`);
});

const write = (name, content) => fs.writeFileSync(path.join(consumer, name), content);
const node = (args, options) => run(process.execPath, args, { cwd: consumer, ...options });

// 3. Library entry points ----------------------------------------------------------------------
const apiCheck = (load) => `
${load}
const names = ['explain', 'explainAll', 'format', 'report', 'register', 'parseErrorText', 'defineRule', 'supportsColor'];
for (const n of names) if (typeof api[n] !== 'function') throw new Error('missing export ' + n);
if (!Array.isArray(api.builtinRules) || api.builtinRules.length < 40) throw new Error('builtinRules missing');
const d = api.explain(Object.assign(new Error('listen EADDRINUSE: address already in use :::3000'), { code: 'EADDRINUSE', port: 3000 }));
if (!d || d.id !== 'address-in-use') throw new Error('unexpected diagnosis: ' + JSON.stringify(d));
const text = api.format(d, { color: false });
if (!text.includes('whycrash: Port 3000 is already in use')) throw new Error('format() output: ' + text);
console.log('ok');
`;

check('ESM: import { explain, format, ... } from "whycrash"', () => {
  write('esm.mjs', apiCheck("import * as api from 'whycrash';"));
  const r = node(['esm.mjs']);
  assert(r.status === 0 && r.stdout.trim() === 'ok', r.stderr || r.stdout);
});

check('CommonJS: require("whycrash")', () => {
  write('cjs.cjs', apiCheck("const api = require('whycrash');"));
  const r = node(['cjs.cjs']);
  assert(r.status === 0 && r.stdout.trim() === 'ok', r.stderr || r.stdout);
});

// 4. Register hook -----------------------------------------------------------------------------
write('crash.cjs', 'const data = {};\ndata.items.map(Boolean);\n');
check('node --import whycrash/register', () => {
  const r = node(['--import', 'whycrash/register', 'crash.cjs']);
  assert(r.status === 1, `exit code ${r.status}`);
  assert(r.stderr.includes('whycrash: `data.items` is undefined'), r.stderr);
  assert(
    r.stderr.includes("TypeError: Cannot read properties of undefined (reading 'map')"),
    'original error missing',
  );
});

check('node -r whycrash/register', () => {
  const r = node(['-r', 'whycrash/register', 'crash.cjs']);
  assert(r.status === 1 && r.stderr.includes('whycrash: `data.items` is undefined'), r.stderr);
});

check('NODE_OPTIONS=--import=whycrash/register', () => {
  const r = node(['crash.cjs'], { env: { NODE_OPTIONS: '--import=whycrash/register' } });
  assert(r.stderr.includes('whycrash: `data.items` is undefined'), r.stderr);
});

// 5. CLI -----------------------------------------------------------------------------------------
const bin = path.join(consumer, 'node_modules', '.bin', isWindows ? 'whycrash.cmd' : 'whycrash');
check('CLI bin is linked and reports the version', () => {
  assert(fs.existsSync(bin), `${bin} not found`);
  const r = run(bin, ['--version'], { cwd: consumer, shell: isWindows });
  assert(r.status === 0 && r.stdout.trim() === pkg.version, r.stderr || r.stdout);
});

check('CLI: whycrash -- node crash.cjs', () => {
  const r = run(bin, ['--', process.execPath, 'crash.cjs'], { cwd: consumer, shell: isWindows });
  assert(r.status === 1, `exit code ${r.status}`);
  assert(r.stderr.includes('whycrash: `data.items` is undefined'), r.stderr);
});

check('CLI: piped input with --json', () => {
  const r = run(bin, ['--json'], {
    cwd: consumer,
    shell: isWindows,
    input: 'Error: connect ECONNREFUSED 127.0.0.1:5432\n    at x (node:net:1:1)\n',
  });
  const out = JSON.parse(r.stdout);
  assert(out[0] && out[0].id === 'connection-refused', r.stdout);
});

// 6. TypeScript declarations --------------------------------------------------------------------
let tsc;
try {
  tsc = createRequire(path.join(root, 'package.json')).resolve('typescript/bin/tsc');
} catch {
  tsc = undefined;
}
if (tsc) {
  const tsSource = `
import { defineRule, explain, explainAll, format, register, report, builtinRules } from 'whycrash';
import type { Diagnosis, ErrorInfo, Finding, Rule, RuleContext, ExplainOptions } from 'whycrash';

const rule: Rule = defineRule({
  id: 'acme/db',
  summary: 'Local database is down',
  diagnose(error: ErrorInfo, ctx: RuleContext): Finding | undefined {
    if (error.code !== 'ECONNREFUSED' || error.props.port !== 5432) return undefined;
    return { title: 'Start the database', explanation: ctx.cwd, fixes: ['docker compose up -d db'], confidence: 'high' };
  },
});
const options: ExplainOptions = { rules: [rule], cwd: process.cwd() };
const d: Diagnosis | undefined = explain(new Error('x'), options);
const all: Diagnosis[] = explainAll('ECONNREFUSED', options);
const text: string = format(d, { color: false, width: 80 });
const stop: () => void = register({ rules: [rule] });
report(new Error('y'), { stream: { write: (s: string) => s.length } });
const ids: readonly string[] = builtinRules.map((r) => r.id);
// @ts-expect-error confidence must be high | medium | low
const bad: Finding = { title: 't', explanation: 'e', confidence: 'certain' };
void [d, all, text, stop, ids, bad];
`;
  for (const [ext, type] of [
    ['mts', 'module'],
    ['cts', 'commonjs'],
  ]) {
    check(`TypeScript types resolve (${type}, moduleResolution nodenext)`, () => {
      const dir = path.join(consumer, `ts-${type}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `usage.${ext}`), tsSource);
      fs.writeFileSync(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            module: 'nodenext',
            moduleResolution: 'nodenext',
            target: 'es2022',
            types: ['node'],
            typeRoots: [path.join(root, 'node_modules', '@types')],
            skipLibCheck: false,
          },
          files: [`usage.${ext}`],
        }),
      );
      const r = run(process.execPath, [tsc, '-p', dir], { cwd: consumer });
      assert(r.status === 0, r.stdout + r.stderr);
    });
  }
} else {
  console.log('  - TypeScript check skipped (typescript not installed)');
}

fs.rmSync(work, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll smoke checks passed');
