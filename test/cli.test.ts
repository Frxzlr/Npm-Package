import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinRules } from '../src/index.js';
import { cleanEnv, distDir, project, repoRoot } from './helpers.js';

const cli = path.join(distDir, 'cli.js');

function run(args: string[], options: { input?: string; cwd?: string } = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd ?? repoRoot,
    input: options.input ?? '',
    encoding: 'utf8',
    env: cleanEnv(),
    timeout: 30_000,
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe('whycrash CLI', () => {
  it('prints help and version', () => {
    expect(run(['--help']).stdout).toContain('Usage');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(run(['--version']).stdout.trim()).toBe(pkg.version);
  });

  it('lists built-in diagnoses', () => {
    const out = run(['--list']).stdout.trim().split('\n');
    expect(out).toHaveLength(builtinRules.length);
    expect(out.some((l) => l.startsWith('connection-refused'))).toBe(true);
  });

  it('diagnoses error text passed as an argument', () => {
    const r = run(['Error: listen EADDRINUSE: address already in use :::3000']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('whycrash: Port 3000 is already in use');
  });

  it('diagnoses bare error codes', () => {
    expect(run(['ERR_REQUIRE_ESM']).stdout).toContain("can't be loaded with `require()`");
  });

  it('exits 1 with a hint when nothing matches', () => {
    const r = run(['Error: totally app specific']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no known diagnosis');
  });

  it('prints JSON for piped input', () => {
    const r = run(['--json'], {
      input:
        'SyntaxError: Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON\n    at JSON.parse (<anonymous>)\n',
    });
    const parsed = JSON.parse(r.stdout) as Array<{ id: string; error: { name: string } }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: 'json-parse-html', error: { name: 'SyntaxError' } });
  });

  it('passes piped input through and appends diagnoses to stderr', () => {
    const input =
      "building...\nTypeError: fetch failed\n    at a (/x.js:1:1) {\n  [cause]: Error: getaddrinfo ENOTFOUND db\n      at b (node:dns:1:1) {\n    code: 'ENOTFOUND',\n    hostname: 'db'\n  }\n}\n";
    const r = run([], { input });
    expect(r.stdout).toBe(input);
    expect(r.stderr).toContain("whycrash: Can't resolve `db` — is that a Docker service name?");
  });

  it('runs a command, forwards its output and exit code, then diagnoses', () => {
    const dir = project({
      'package.json': '{"type":"module"}',
      'app.js': "console.log('hello');\nJSON.parse(undefined);\n",
    });
    const r = run(['--', process.execPath, 'app.js'], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('hello\n');
    const errorAt = r.stderr.indexOf('SyntaxError');
    const diagnosisAt = r.stderr.indexOf('whycrash: `JSON.parse()` was given `undefined`');
    expect(errorAt).toBeGreaterThanOrEqual(0);
    expect(diagnosisAt).toBeGreaterThan(errorAt);
  });

  it('runs a command without -- and keeps a zero exit code', () => {
    const dir = project({ 'ok.cjs': "console.log('fine');\n" });
    const r = run([process.execPath, 'ok.cjs'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('fine\n');
    expect(r.stderr).toBe('');
  });

  // On Windows the command runs through cmd.exe, which reports a missing command itself.
  it.skipIf(process.platform === 'win32')('diagnoses a command that does not exist', () => {
    const r = run(['--', 'definitely-not-a-command-xyz']);
    expect(r.status).toBe(127);
    expect(r.stderr).toContain('whycrash: Command `definitely-not-a-command-xyz` was not found');
  });

  it('rejects unknown options and --json with a command', () => {
    expect(run(['--nope']).status).toBe(2);
    const r = run(['--json', '--', 'node', '-v']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--json works with error text or piped input');
  });
});
