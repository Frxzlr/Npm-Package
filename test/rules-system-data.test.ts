import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { explain } from '../src/index.js';
import { caught, crash, info, project } from './helpers.js';

describe('spawn-not-found', () => {
  it('diagnoses a real missing command', () => {
    const { diagnosis } = crash(
      { 'a.cjs': "require('child_process').spawn('definitely-not-a-real-cmd-xyz');\n" },
      'a.cjs',
    );
    expect(diagnosis?.title).toBe('Command `definitely-not-a-real-cmd-xyz` was not found');
  });

  it('explains the Windows .cmd EINVAL change', () => {
    const err = Object.assign(new Error('spawn EINVAL'), {
      code: 'EINVAL',
      syscall: 'spawn npm.cmd',
      path: 'npm.cmd',
    });
    expect(explain(err, { platform: 'win32' })?.title).toBe(
      'Windows refuses to spawn .cmd/.bat files without a shell',
    );
  });
});

describe('file-not-found', () => {
  it('notices paths resolved from the working directory instead of the file', () => {
    const { diagnosis } = crash(
      {
        'src/config.json': '{}',
        'src/load.cjs': "require('fs').readFileSync('./config.json', 'utf8');\n",
      },
      'src/load.cjs',
    );
    expect(diagnosis?.title).toBe(
      '`./config.json` is resolved from the working directory, not from your file',
    );
    expect(diagnosis?.fixes[0]).toContain("path.join(import.meta.dirname, './config.json')");
  });

  it('detects letter-case mismatches', () => {
    const dir = project({ 'Data.json': '{}' });
    const err = Object.assign(
      new Error(`ENOENT: no such file or directory, open '${path.join(dir, 'data.json')}'`),
      {
        code: 'ENOENT',
        syscall: 'open',
        path: path.join(dir, 'data.json'),
      },
    );
    expect(explain(err)?.title).toBe('`data.json` has different letter case on disk: `Data.json`');
  });

  it('suggests creating .env from a template', () => {
    const dir = project({ '.env.example': 'A=1\n' });
    const err = Object.assign(new Error("ENOENT: no such file or directory, open '.env'"), {
      code: 'ENOENT',
      syscall: 'open',
      path: '.env',
    });
    const d = explain(err, { cwd: dir });
    expect(d?.fixes[0]).toContain('cp .env.example .env');
  });

  it('notices missing parent folders when writing', () => {
    const { diagnosis } = crash(
      { 'w.cjs': "require('fs').writeFileSync('out/report.txt', 'x');\n" },
      'w.cjs',
    );
    expect(diagnosis?.title).toBe("The folder `out` doesn't exist");
    expect(diagnosis?.fixes[0]).toContain('mkdirSync');
  });

  it('suggests similar filenames and falls back to a generic message', () => {
    const dir = project({ 'settings.json': '{}' });
    const typo = Object.assign(new Error('ENOENT'), {
      code: 'ENOENT',
      syscall: 'open',
      path: path.join(dir, 'setings.json'),
    });
    expect(explain(typo)?.title).toContain('did you mean `settings.json`?');
    const none = Object.assign(new Error('ENOENT'), {
      code: 'ENOENT',
      syscall: 'open',
      path: path.join(dir, 'zzz.bin'),
    });
    expect(explain(none)).toMatchObject({ id: 'file-not-found', confidence: 'medium' });
  });
});

describe('permission-denied / too-many-open-files / out-of-memory', () => {
  it('explains privileged ports, global npm folders and Windows locks', () => {
    const port = Object.assign(new Error('listen EACCES: permission denied 0.0.0.0:80'), {
      code: 'EACCES',
      syscall: 'listen',
      port: 80,
    });
    expect(explain(port)?.title).toBe('Port 80 needs administrator privileges');
    const npm = Object.assign(
      new Error("EACCES: permission denied, mkdir '/usr/local/lib/node_modules/x'"),
      {
        code: 'EACCES',
        syscall: 'mkdir',
        path: '/usr/local/lib/node_modules/x',
      },
    );
    expect(explain(npm)?.title).toBe("npm can't write to the global packages folder");
    const win = Object.assign(new Error('EPERM: operation not permitted'), {
      code: 'EPERM',
      syscall: 'rename',
      path: 'C:\\app\\dist',
    });
    expect(explain(win, { platform: 'win32' })?.title).toContain('Windows blocked access');
    const generic = Object.assign(new Error('EACCES'), {
      code: 'EACCES',
      syscall: 'open',
      path: '/etc/shadow',
    });
    expect(explain(generic, { platform: 'linux' })?.title).toBe('Permission denied: `/etc/shadow`');
  });

  it('explains EMFILE', () => {
    expect(
      explain(Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }))?.title,
    ).toBe('Too many open files');
  });

  it('explains heap exhaustion from terminal output', () => {
    const d = explain(
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    );
    expect(d?.title).toBe('Node.js ran out of memory (JavaScript heap limit reached)');
    expect(d?.fixes[0]).toContain('--max-old-space-size=4096');
  });

  it('explains strings that grew too long', () => {
    const error = caught(() => 'x'.repeat(2 ** 30));
    expect(explain(error)?.title).toBe("A string grew past JavaScript's maximum length");
  });

  it('explains unsettled top-level await', () => {
    const { diagnosis } = crash({ 'a.mjs': 'await new Promise(() => {});\n' }, 'a.mjs');
    expect(diagnosis?.title).toBe('Top-level `await` never finished');
    expect(diagnosis?.location?.line).toBe(1);
  });
});

describe('data rules', () => {
  it('explains HTML parsed as JSON', () => {
    expect(explain(caught(() => JSON.parse('<!DOCTYPE html><html>')))?.title).toBe(
      'Expected JSON but received an HTML page',
    );
    expect(explain('SyntaxError: Unexpected token < in JSON at position 0')?.id).toBe(
      'json-parse-html',
    );
  });

  it('explains undefined, objects and empty input', () => {
    expect(explain(caught(() => JSON.parse(undefined as unknown as string)))?.title).toBe(
      '`JSON.parse()` was given `undefined`',
    );
    expect(explain(caught(() => JSON.parse({} as unknown as string)))?.title).toBe(
      '`JSON.parse()` was given an object, not a JSON string',
    );
    expect(explain(caught(() => JSON.parse('')))?.title).toBe(
      '`JSON.parse()` got empty or truncated input',
    );
    expect(explain('SyntaxError: Unexpected token u in JSON at position 0')?.id).toBe(
      'json-parse-invalid',
    );
  });

  it('explains malformed JSON with a position', () => {
    const d = explain(caught(() => JSON.parse('{"a": 1,}')));
    expect(d).toMatchObject({ id: 'json-parse-invalid', confidence: 'medium' });
  });

  it('explains circular structures, including HTTP objects', () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    const plain = explain(caught(() => JSON.stringify(o)));
    expect(plain?.title).toBe("The value you're serializing contains a circular reference");
    expect(plain?.explanation).toContain('`self`');
    const http = explain(
      "TypeError: Converting circular structure to JSON\n    --> starting at object with constructor 'Socket'\n    |     property 'parser' -> object with constructor 'HTTPParser'\n    --- property 'socket' closes the circle\n    at JSON.stringify (<anonymous>)",
    );
    expect(http?.title).toBe("Can't JSON-serialize an HTTP request, response or socket");
  });

  it('explains BigInt, invalid dates and structuredClone', () => {
    expect(explain(caught(() => JSON.stringify({ n: 10n })))?.id).toBe('bigint-json');
    expect(explain(caught(() => new Date('31/12/2024').toISOString()))?.id).toBe('invalid-date');
    const clone = explain(caught(() => structuredClone({ f() {} })));
    expect(clone?.id).toBe('structured-clone-failed');
    expect(clone?.explanation).toContain('The culprit is');
  });

  it('leaves unrelated syntax errors alone', () => {
    expect(explain(info({ name: 'SyntaxError', message: "Unexpected token ';'" }))).toBeUndefined();
  });
});
