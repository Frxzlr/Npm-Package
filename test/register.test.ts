import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { register, report } from '../src/index.js';
import { distDir, project, runNode } from './helpers.js';

const esmHook = path.join(distDir, 'register.js');
const cjsHook = path.join(distDir, 'register.cjs');
const hookUrl = pathToFileURL(esmHook).href;

describe('whycrash/register (built)', () => {
  const files = {
    'package.json': '{"type":"module"}',
    'utils.js': 'export const x = 1;\n',
    'main.js': "import { x } from './utils';\nconsole.log(x);\n",
  };

  it('prints the diagnosis, then Node prints the original error; exit code is unchanged', () => {
    const dir = project(files);
    const withHook = runNode(dir, 'main.js', ['--import', hookUrl]);
    const without = runNode(dir, 'main.js');
    expect(withHook.status).toBe(1);
    expect(without.status).toBe(1);
    const at = withHook.stderr.indexOf('whycrash: `./utils` is missing its file extension');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(withHook.stderr.indexOf('↓ original error')).toBeGreaterThan(at);
    expect(withHook.stderr.indexOf('ERR_MODULE_NOT_FOUND')).toBeGreaterThan(at);
    expect(withHook.stderr.endsWith(without.stderr)).toBe(true);
  });

  it('works with -r for CommonJS', () => {
    const dir = project({ 'a.cjs': 'const data = {};\ndata.items.map(Boolean);\n' });
    const r = runNode(dir, 'a.cjs', ['-r', cjsHook]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('whycrash: `data.items` is undefined');
  });

  it('stays silent for errors it does not recognise', () => {
    const dir = project({ 'a.cjs': "throw new Error('app-specific failure');\n" });
    const without = runNode(dir, 'a.cjs');
    // -r keeps Node's loading path identical, so the output must match byte for byte.
    const required = runNode(dir, 'a.cjs', ['-r', cjsHook]);
    expect(required.stderr).toBe(without.stderr);
    expect(required.status).toBe(without.status);
    // --import routes the entry through the ESM loader (different internal frames), so only check silence.
    const imported = runNode(dir, 'a.cjs', ['--import', hookUrl]);
    expect(imported.stderr).not.toContain('whycrash:');
    expect(imported.status).toBe(without.status);
  });

  it('can be disabled with WHYCRASH=0', () => {
    const dir = project(files);
    const r = runNode(dir, 'main.js', ['--import', hookUrl], { WHYCRASH: '0' });
    expect(r.stderr).not.toContain('whycrash:');
  });

  it('does not change behaviour when the app handles uncaught exceptions', () => {
    const dir = project({
      'a.cjs':
        "process.on('uncaughtException', () => console.log('handled'));\nsetTimeout(() => JSON.parse('<html>'), 1);\nsetTimeout(() => console.log('still alive'), 30);\n",
    });
    const r = runNode(dir, 'a.cjs', ['-r', cjsHook]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('handled\nstill alive\n');
    expect(r.stderr).toContain('whycrash: Expected JSON but received an HTML page');
    expect(r.stderr).not.toContain('original error');
  });

  it('is idempotent when loaded twice', () => {
    const dir = project(files);
    const r = runNode(dir, 'main.js', ['--import', hookUrl, '-r', cjsHook]);
    expect(r.stderr.split('whycrash:').length - 1).toBe(1);
  });

  it('finds the source of thrown strings in the project', () => {
    const dir = project({
      'package.json': '{"name":"app"}',
      'lib/jobs.cjs': "setTimeout(() => {\n  throw 'queue-exploded-42';\n}, 1);\n",
    });
    const r = runNode(dir, 'lib/jobs.cjs', ['-r', cjsHook]);
    expect(r.stderr).toContain('whycrash: A non-Error value was thrown: `queue-exploded-42`');
    expect(r.stderr).toContain(`${path.join('lib', 'jobs.cjs')}:2`);
  });
});

describe('register() / report() in-process', () => {
  it('registers once and unregisters', () => {
    const before = process.listenerCount('uncaughtExceptionMonitor');
    const off = register({ stream: { write: () => true } });
    expect(register()).toBe(off);
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before + 1);
    off();
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before);
  });

  it('writes diagnoses for caught errors to the given stream', () => {
    let written = '';
    const d = report(new SyntaxError('"undefined" is not valid JSON'), {
      stream: { write: (t: string) => (written += t) },
      color: false,
    });
    expect(d?.id).toBe('json-parse-invalid');
    expect(written).toContain('whycrash: `JSON.parse()` was given `undefined`');
    expect(report(new Error('unknown'), { stream: { write: () => true } })).toBeUndefined();
  });
});
