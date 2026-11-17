import path from 'node:path';
import util from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseErrorText, stripAnsi } from '../src/parse.js';
import { project, runNode } from './helpers.js';

/** Real `util.inspect` output — exactly what Node prints for uncaught errors. */
function inspect(error: unknown): string {
  return util.inspect(error, { colors: false, depth: 10 });
}

describe('parseErrorText — util.inspect round trips', () => {
  it('recovers name, message, code and primitive props', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
      errno: -61,
      syscall: 'connect',
      address: '127.0.0.1',
      port: 5432,
    });
    const [parsed] = parseErrorText(inspect(err));
    expect(parsed).toMatchObject({
      name: 'Error',
      message: 'connect ECONNREFUSED 127.0.0.1:5432',
      code: 'ECONNREFUSED',
      props: { errno: -61, syscall: 'connect', address: '127.0.0.1', port: 5432 },
    });
    expect(parsed?.frames.length).toBeGreaterThan(0);
    expect(parsed?.props).not.toHaveProperty('code');
  });

  it('recovers [cause] chains', () => {
    const inner = Object.assign(new Error('getaddrinfo ENOTFOUND db'), {
      code: 'ENOTFOUND',
      hostname: 'db',
    });
    const outer = new TypeError('fetch failed', { cause: inner });
    const [parsed] = parseErrorText(inspect(outer));
    expect(parsed?.name).toBe('TypeError');
    expect(parsed?.cause).toMatchObject({
      message: 'getaddrinfo ENOTFOUND db',
      code: 'ENOTFOUND',
      props: { hostname: 'db' },
    });
  });

  it('recovers AggregateError [errors]', () => {
    const a = Object.assign(new Error('connect ECONNREFUSED ::1:3000'), {
      code: 'ECONNREFUSED',
      address: '::1',
      port: 3000,
    });
    const b = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 3000,
    });
    const agg = Object.assign(new AggregateError([a, b], ''), { code: 'ECONNREFUSED' });
    const [parsed] = parseErrorText(inspect(new TypeError('fetch failed', { cause: agg })));
    expect(parsed?.cause?.name).toBe('AggregateError');
    expect(parsed?.cause?.code).toBe('ECONNREFUSED');
    expect(parsed?.cause?.errors.map((e) => e.props.address)).toEqual(['::1', '127.0.0.1']);
  });

  it('keeps arrays of strings and skips nested objects', () => {
    const err = Object.assign(new Error("Cannot find module 'x'"), {
      code: 'MODULE_NOT_FOUND',
      requireStack: ['/app/a.js', '/app/b.js'],
      response: { status: 500, data: { nested: true } },
      after: 'kept',
    });
    const [parsed] = parseErrorText(inspect(err));
    expect(parsed?.props.requireStack).toEqual(['/app/a.js', '/app/b.js']);
    expect(parsed?.props.after).toBe('kept');
    expect(parsed?.props).not.toHaveProperty('response');
  });

  it('treats a non-Error cause as a NonError', () => {
    const [parsed] = parseErrorText(inspect(new Error('outer', { cause: 'just a string' })));
    expect(parsed?.cause).toMatchObject({ name: 'NonError', message: 'just a string' });
  });

  it('reads DOMException tags as names and code tags as codes', () => {
    const [timeout] = parseErrorText(
      'DOMException [TimeoutError]: The operation was aborted due to timeout\n    at x (/a.js:1:1)',
    );
    expect(timeout?.name).toBe('TimeoutError');
    const [coded] = parseErrorText(
      'Error [ERR_REQUIRE_ESM]: require() of ES Module /x.js not supported.\n    at y (/b.js:1:1)',
    );
    expect(coded?.code).toBe('ERR_REQUIRE_ESM');
  });
});

describe('parseErrorText — real Node.js output', () => {
  it('parses an uncaught error with a multi-line message, source arrow and props', () => {
    const dir = project({ 'index.cjs': "require('./missing')\n" });
    const { stderr } = runNode(dir, 'index.cjs');
    const [parsed] = parseErrorText(stderr);
    expect(parsed?.code).toBe('MODULE_NOT_FOUND');
    expect(parsed?.message).toMatch(/^Cannot find module '\.\/missing'\nRequire stack:\n- /);
    expect(parsed?.props.requireStack).toEqual([path.join(dir, 'index.cjs')]);
  });

  it('ignores the "Emitted \'error\' event" frames but keeps the props', () => {
    const dir = project({
      'index.cjs':
        "const http = require('http');\nconst a = http.createServer().listen(0, () => {\n  http.createServer().listen(a.address().port);\n});\n",
    });
    const { stderr } = runNode(dir, 'index.cjs');
    const [parsed] = parseErrorText(stderr);
    expect(parsed?.code).toBe('EADDRINUSE');
    expect(typeof parsed?.props.port).toBe('number');
    expect(parsed?.frames.every((f) => !/emitErrorNT/.test(f.fn ?? ''))).toBe(true);
  });

  it('captures the source hint of syntax errors', () => {
    const dir = project({ 'bad.mjs': 'const x = ;\n' });
    const { stderr } = runNode(dir, 'bad.mjs');
    const [parsed] = parseErrorText(stderr);
    expect(parsed?.name).toBe('SyntaxError');
    expect(parsed?.sourceHint).toMatchObject({ file: path.join(dir, 'bad.mjs'), line: 1 });
  });

  it('parses the unsettled top-level await warning', () => {
    const dir = project({ 'tla.mjs': 'await new Promise(() => {});\n' });
    const { stderr, status } = runNode(dir, 'tla.mjs');
    expect(status).toBe(13);
    const [parsed] = parseErrorText(stderr);
    expect(parsed).toMatchObject({
      name: 'Warning',
      message: 'Detected unsettled top-level await',
    });
    expect(parsed?.sourceHint?.line).toBe(1);
  });
});

describe('parseErrorText — other formats and edge cases', () => {
  it('strips ANSI colors and handles CRLF', () => {
    expect(stripAnsi('\u001b[31mred\u001b[39m')).toBe('red');
    const [parsed] = parseErrorText(
      '\u001b[31mTypeError: boom\u001b[39m\r\n    at a (/x.js:1:1)\r\n',
    );
    expect(parsed).toMatchObject({ name: 'TypeError', message: 'boom' });
  });

  it('accepts prefixes such as Next.js markers and "Uncaught"', () => {
    expect(parseErrorText(' ⨯ TypeError: fetch failed\n    at a (/x.js:1:1)')[0]?.message).toBe(
      'fetch failed',
    );
    expect(parseErrorText('Uncaught ReferenceError: window is not defined')[0]?.name).toBe(
      'ReferenceError',
    );
  });

  it('parses stackless errors that util.inspect prints in brackets (Node.js 26)', () => {
    const text = [
      '[TypeError: fetch failed] {',
      '  [cause]: Error: connect ECONNREFUSED 127.0.0.1:3000',
      '      at createConnectionError (node:net:1678:14) {',
      "    code: 'ECONNREFUSED',",
      '    port: 3000',
      '  }',
      '}',
    ].join('\n');
    const [parsed] = parseErrorText(text);
    expect(parsed).toMatchObject({ name: 'TypeError', message: 'fetch failed' });
    expect(parsed?.cause).toMatchObject({ code: 'ECONNREFUSED', props: { port: 3000 } });
  });

  it('parses ERR_REQUIRE_ASYNC_MODULE from Node.js 26', () => {
    const text = [
      'Error [ERR_REQUIRE_ASYNC_MODULE]: require() cannot be used on an ESM graph with top-level await. Use import() instead.',
      'Required module: /app/node_modules/tlapkg/index.js',
      'Require stack:',
      '- /app/tla.cjs',
      '    at ModuleJobSync.throwIfAsyncGraph (node:internal/modules/esm/module_job:314:11)',
    ].join('\n');
    const [parsed] = parseErrorText(text);
    expect(parsed?.code).toBe('ERR_REQUIRE_ASYNC_MODULE');
    expect(parsed?.message).toContain('Required module: /app/node_modules/tlapkg/index.js');
  });

  it('parses Jest-style output with a code frame between message and frames', () => {
    const text = [
      "    TypeError: Cannot read properties of undefined (reading 'map')",
      '',
      '      3 | const data = {};',
      '    > 4 | data.items.map((x) => x);',
      '        |            ^',
      '',
      '      at Object.<anonymous> (src/foo.test.js:4:12)',
    ].join('\n');
    const [parsed] = parseErrorText(text);
    expect(parsed?.message).toBe("Cannot read properties of undefined (reading 'map')");
    expect(parsed?.frames[0]).toMatchObject({ file: 'src/foo.test.js', line: 4 });
  });

  it('parses Vitest-style frames', () => {
    const [parsed] = parseErrorText(
      'TypeError: x is not a function\n ❯ src/a.ts:3:7\n ❯ src/b.ts:9:1',
    );
    expect(parsed?.frames.map((f) => f.line)).toEqual([3, 9]);
  });

  it('parses FATAL ERROR lines', () => {
    const [parsed] = parseErrorText(
      '<--- JS stacktrace --->\n\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n',
    );
    expect(parsed).toMatchObject({ name: 'FatalError' });
  });

  it('finds several errors in one log', () => {
    const text =
      'TypeError: one\n    at a (/a.js:1:1)\nsome log line\nRangeError: two\n    at b (/b.js:2:2)\n';
    expect(parseErrorText(text).map((e) => e.message)).toEqual(['one', 'two']);
  });

  it('ignores error-looking log lines without a stack in longer output', () => {
    const text = 'starting\nError: retrying request\nstill going\nok\ndone\n';
    expect(parseErrorText(text)).toEqual([]);
  });

  it('accepts a single pasted error line', () => {
    expect(
      parseErrorText('Error: listen EADDRINUSE: address already in use :::3000')[0]?.message,
    ).toBe('listen EADDRINUSE: address already in use :::3000');
  });

  it('does not swallow following lines into the message when no frames follow', () => {
    const text =
      'Error: connect ECONNREFUSED 127.0.0.1:5432\n[nodemon] app crashed\nwaiting for changes\nmore\n';
    expect(parseErrorText(text)[0]?.message).toBe('connect ECONNREFUSED 127.0.0.1:5432');
  });

  it('handles empty and garbage input', () => {
    expect(parseErrorText('')).toEqual([]);
    expect(parseErrorText('\n\n   \n')).toEqual([]);
    expect(parseErrorText('}}}]]] {{{ [[[')).toEqual([]);
    expect(() => parseErrorText('Error: x {\n  a: {\n    b: [\n')).not.toThrow();
  });

  it('does not match `new TypeError(` inside code', () => {
    expect(parseErrorText("throw new TypeError('x')")).toEqual([]);
  });
});
