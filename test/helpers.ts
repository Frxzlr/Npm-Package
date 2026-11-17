import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { explain } from '../src/index.js';
import type { Diagnosis, ErrorInfo, ExplainOptions } from '../src/index.js';

const created: string[] = [];

afterAll(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Create a throwaway project folder with the given files. Returns its real path. */
export function project(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'whycrash-test-')));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export function cleanEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  delete env.NODE_OPTIONS;
  delete env.WHYCRASH;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Run `node [...nodeArgs] entry` inside `cwd`. */
export function runNode(
  cwd: string,
  entry: string,
  nodeArgs: string[] = [],
  env: Record<string, string | undefined> = {},
): RunResult {
  const r = spawnSync(process.execPath, [...nodeArgs, entry], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(env),
    timeout: 30_000,
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/**
 * Write a project, run `entry` with real Node.js, and diagnose its stderr exactly like the
 * CLI does. Returns the diagnosis plus the raw output for debugging.
 */
export function crash(
  files: Record<string, string>,
  entry: string,
  options: { nodeArgs?: string[]; runIn?: string; explain?: ExplainOptions } = {},
): { diagnosis: Diagnosis | undefined; stderr: string; dir: string } {
  const dir = project(files);
  const cwd = options.runIn ? path.join(dir, options.runIn) : dir;
  const { stderr } = runNode(
    cwd,
    path.relative(cwd, path.join(dir, entry)) || entry,
    options.nodeArgs,
  );
  return { diagnosis: explain(stderr, { cwd, ...options.explain }), stderr, dir };
}

/** Build a synthetic ErrorInfo. */
export function info(partial: Partial<ErrorInfo> & { message: string }): ErrorInfo {
  return { name: 'Error', frames: [], props: {}, errors: [], ...partial };
}

/** Throw inside `fn` and return what was thrown. */
export function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected fn to throw');
}

export const nodeMajor = Number(process.versions.node.split('.')[0]);
export const [, nodeMinor] = process.versions.node.split('.').map(Number) as [
  number,
  number,
  number,
];
export const stripsTypes =
  nodeMajor >= 24 || (nodeMajor === 23 && nodeMinor >= 6) || (nodeMajor === 22 && nodeMinor >= 18);

export const repoRoot = path.resolve(import.meta.dirname, '..');
export const distDir = path.join(repoRoot, 'dist');
