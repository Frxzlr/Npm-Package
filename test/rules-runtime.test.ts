import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { explain } from '../src/index.js';
import { _internal } from '../src/rules/runtime.js';
import { caught, crash, info } from './helpers.js';

describe('property-of-undefined', () => {
  it('names the undefined expression and points at it', () => {
    const { diagnosis, dir } = crash(
      { 'a.cjs': 'const data = { list: [] };\n\nconst names = data.items.map((x) => x.name);\n' },
      'a.cjs',
    );
    expect(diagnosis?.title).toBe('`data.items` is undefined');
    expect(diagnosis?.explanation).toBe(
      'Your code reads `.map` from `data.items`, but `data.items` is `undefined` at that point.',
    );
    expect(diagnosis?.fixes[0]).toBe('Default it to an empty array: `(data.items ?? []).map`');
    expect(diagnosis?.location).toEqual({ file: path.join(dir, 'a.cjs'), line: 3, column: 26 });
  });

  it('explains lost `this` in callbacks', () => {
    const { diagnosis } = crash(
      {
        'a.cjs':
          'class Counter {\n  count = 0;\n  increment() {\n    this.count += 1;\n  }\n}\nconst c = new Counter();\nconst fn = c.increment;\nfn();\n',
      },
      'a.cjs',
    );
    expect(diagnosis?.title).toBe('`this` is undefined');
    expect(diagnosis?.fixes[0]).toContain('arrow function');
  });

  it('spots missing express.json()', () => {
    const { diagnosis } = crash(
      {
        'a.cjs':
          'const req = {};\nfunction handler(req) {\n  const { name } = req.body;\n}\nhandler(req);\n',
      },
      'a.cjs',
    );
    expect(diagnosis?.title).toBe('Destructuring `name` from `req.body`, which is undefined');
    expect(diagnosis?.fixes[0]).toContain('app.use(express.json())');
  });

  it('explains functions that return nothing, indexes and null', () => {
    const call = crash(
      { 'a.cjs': 'function getUser() {}\nconsole.log(getUser().profile.name);\n' },
      'a.cjs',
    );
    expect(call.diagnosis?.title).toBe('`getUser()` is undefined');
    expect(call.diagnosis?.fixes[0]).toContain('returns a value on every code path');

    const index = crash({ 'a.cjs': 'const users = [];\nconsole.log(users[0].name);\n' }, 'a.cjs');
    expect(index.diagnosis?.title).toBe('`users[0]` is undefined');

    const nul = crash({ 'a.cjs': 'const el = null;\nel.textContent = "hi";\n' }, 'a.cjs');
    expect(nul.diagnosis?.title).toBe('`el` is null');
  });

  it('blames the call site when the error happens inside a dependency', () => {
    const { diagnosis } = crash(
      {
        'node_modules/fmt/package.json': '{"name":"fmt","main":"index.js"}',
        'node_modules/fmt/index.js': 'module.exports = (opts) => opts.locale.toUpperCase();\n',
        'a.cjs': "const fmt = require('fmt');\nfmt(undefined);\n",
      },
      'a.cjs',
    );
    expect(diagnosis?.title).toBe('`fmt` read `.locale` of undefined');
    expect(diagnosis?.location?.line).toBe(2);
  });

  it('degrades gracefully without source', () => {
    const d = explain(
      info({ name: 'TypeError', message: "Cannot read properties of undefined (reading 'x')" }),
    );
    expect(d).toMatchObject({ title: 'Tried to read `.x` on undefined', confidence: 'medium' });
    expect(explain("TypeError: Cannot read property 'x' of undefined")?.id).toBe(
      'property-of-undefined',
    );
  });
});

describe('not-a-function / not-a-constructor', () => {
  it('explains default-import interop mix-ups', () => {
    expect(explain(new TypeError('(0 , _chalk.default) is not a function'))?.title).toBe(
      "The module's default export isn't a function",
    );
    expect(explain(new TypeError('(0 , utils_1.formatDate) is not a function'))?.title).toBe(
      'The imported `formatDate` is not a function',
    );
    expect(explain(new TypeError('_foo.default is not a constructor'))?.title).toBe(
      "The module's default export isn't a class",
    );
  });

  it('explains non-arrays, non-strings, non-numbers and non-promises', () => {
    const { diagnosis } = crash(
      { 'a.cjs': 'const res = { data: [] };\nres.map((x) => x);\n' },
      'a.cjs',
    );
    expect(diagnosis?.title).toBe('`res` is not an array');
    expect(explain(new TypeError('name.toUpperCase is not a function'))?.title).toBe(
      '`name` is not a string',
    );
    expect(explain(new TypeError('price.toFixed is not a function'))?.title).toBe(
      '`price` is not a number',
    );
    expect(explain(new TypeError('loadUser(...).then is not a function'))?.title).toBe(
      '`loadUser(...)` is not a Promise',
    );
  });

  it('explains axios-style .json() and Express next()', () => {
    expect(explain(new TypeError('response.json is not a function'))?.fixes[0]).toBe(
      'With axios, use `response.data`',
    );
    expect(explain(new TypeError('next is not a function'))?.title).toContain(
      'middleware signature',
    );
  });

  it('recovers the callee for (intermediate value)', () => {
    const { diagnosis } = crash(
      { 'a.cjs': 'const api = {};\n(api.client || {}).send();\n' },
      'a.cjs',
    );
    expect(diagnosis?.id).toBe('not-a-function');
    expect(diagnosis?.title).toBe('`(api.client || {}).send` is not a function');
    expect(diagnosis?.confidence).toBe('low');
  });

  it('explains arrow functions used with new', () => {
    const { diagnosis } = crash({ 'a.cjs': 'const Foo = () => {};\nnew Foo();\n' }, 'a.cjs');
    expect(diagnosis?.title).toBe("`Foo` can't be used with `new`");
  });
});

describe('before-initialization', () => {
  it('spots use before a later declaration', () => {
    const { diagnosis } = crash({ 'a.cjs': 'console.log(total);\nconst total = 1;\n' }, 'a.cjs');
    expect(diagnosis?.title).toBe('`total` is used on line 1 but declared on line 2');
    const same = crash({ 'b.cjs': 'console.log(foo); const foo = 1;\n' }, 'b.cjs');
    expect(same.diagnosis?.title).toBe('`foo` is used before its declaration later on line 1');
  });

  it('spots circular imports', () => {
    const { diagnosis, dir } = crash(
      {
        'a.mjs': "import { b } from './b.mjs';\nexport const a = 1;\nconsole.log(b);\n",
        'b.mjs': "import { a } from './a.mjs';\nexport const b = a + 1;\n",
      },
      'a.mjs',
    );
    expect(diagnosis?.title).toBe(
      '`a` was used before its module finished loading — circular import?',
    );
    expect(diagnosis?.location).toEqual({ file: path.join(dir, 'b.mjs'), line: 1 });
  });
});

describe('browser-global-on-server / missing-global', () => {
  it('explains browser globals during SSR', () => {
    const { diagnosis } = crash(
      { 'a.cjs': "window.addEventListener('resize', () => {});\n" },
      'a.cjs',
    );
    expect(diagnosis?.title).toBe('`window` is not defined — browser-only code ran in Node.js');
  });

  it('blames libraries that touch the DOM on import', () => {
    const { diagnosis } = crash(
      {
        'node_modules/chartlib/package.json': '{"name":"chartlib","main":"index.js"}',
        'node_modules/chartlib/index.js': "module.exports = document.createElement('canvas');\n",
        'a.cjs': "require('chartlib');\n",
      },
      'a.cjs',
    );
    expect(diagnosis?.explanation).toContain('inside `chartlib`');
    expect(diagnosis?.fixes[2]).toContain("await import('chartlib')");
  });

  it('distinguishes old Node.js from replaced globals', () => {
    const err = info({ name: 'ReferenceError', message: 'fetch is not defined' });
    expect(explain(err, { nodeVersion: 'v16.20.0' })?.title).toBe(
      '`fetch` needs Node.js 18+, but this is v16.20.0',
    );
    expect(explain(err, { nodeVersion: 'v22.0.0' })?.explanation).toContain('jsdom');
    expect(
      explain(info({ name: 'ReferenceError', message: 'notAGlobal is not defined' })),
    ).toBeUndefined();
  });
});

describe('stack-overflow', () => {
  it('shows the recursion cycle', () => {
    const { diagnosis } = crash(
      {
        'a.cjs':
          'function ping() { return pong(); }\nfunction pong() { return ping(); }\nping();\n',
      },
      'a.cjs',
    );
    expect(diagnosis?.title).toMatch(/^Infinite recursion: `(ping|pong)` → `(ping|pong)` → …$/);
  });

  it('explains self-calling setters', () => {
    const { diagnosis } = crash(
      { 'a.cjs': 'class User {\n  set name(v) { this.name = v; }\n}\nnew User().name = "x";\n' },
      'a.cjs',
    );
    expect(diagnosis?.title).toBe('The `name` setter calls itself forever');
  });

  it('explains huge spreads', () => {
    const { diagnosis } = crash(
      { 'a.cjs': 'const big = new Array(2e7).fill(1);\nMath.max(...big);\n' },
      'a.cjs',
    );
    expect(diagnosis?.title).toBe('A huge array was spread into function arguments');
  });

  it('finds the smallest repeating period', () => {
    const f = (fn: string, line: number) => ({
      fn,
      file: '/a.js',
      line,
      isInternal: false,
      isDependency: false,
    });
    expect(
      _internal.findCycle([f('a', 1), f('b', 2), f('a', 1), f('b', 2)])?.map((x) => x.fn),
    ).toEqual(['a', 'b']);
    expect(
      _internal.findCycle([f('x', 9), f('a', 1), f('a', 1), f('a', 1)])?.map((x) => x.fn),
    ).toEqual(['a']);
    expect(_internal.findCycle([f('a', 1), f('b', 2), f('c', 3)])).toBeUndefined();
  });
});

describe('headers-already-sent', () => {
  it('finds the earlier response without return', () => {
    const { diagnosis, dir } = crash(
      {
        'server.cjs': [
          "const http = require('http');",
          'const server = http.createServer((req, res) => {',
          "  if (req.url === '/') {",
          "    res.end('home');",
          '  }',
          "  res.setHeader('x-extra', '1');",
          '});',
          'server.listen(0, async () => {',
          '  await fetch(`http://127.0.0.1:${server.address().port}/`).catch(() => {});',
          '});',
          '',
        ].join('\n'),
      },
      'server.cjs',
    );
    expect(diagnosis?.title).toBe('A response was sent twice for the same request');
    expect(diagnosis?.explanation).toContain('Line 4 sends a response without `return`');
    expect(diagnosis?.location).toEqual({ file: path.join(dir, 'server.cjs'), line: 4 });
  });
});

describe('non-error-thrown / invalid-argument', () => {
  it('finds where a thrown string came from', () => {
    const { diagnosis, dir } = crash(
      {
        'package.json': '{"name":"app"}',
        'src/db.cjs': "module.exports = () => {\n  throw 'db-connection-lost';\n};\n",
        'index.cjs': "require('./src/db.cjs')();\n",
      },
      'index.cjs',
    );
    expect(diagnosis?.title).toBe('A non-Error value was thrown: `db-connection-lost`');
    expect(diagnosis?.location).toMatchObject({ file: path.join(dir, 'src/db.cjs'), line: 2 });
  });

  it('explains unhandled rejections with non-Error reasons', () => {
    const { diagnosis } = crash({ 'a.mjs': "Promise.reject('nope-123');\n" }, 'a.mjs');
    expect(diagnosis?.title).toBe('A promise was rejected with a non-Error value: `nope-123`');
  });

  it('explains undefined arguments and un-awaited promises', () => {
    const undef = explain(caught(() => fs.readFileSync(undefined as unknown as string)));
    expect(undef?.title).toBe('`path` is undefined');
    const promise = explain(
      caught(() =>
        fs.writeFileSync(
          path.join(os.tmpdir(), 'whycrash-never-written'),
          Promise.resolve('x') as unknown as string,
        ),
      ),
    );
    expect(promise?.title).toBe('A Promise was passed as `data` — missing `await`?');
    expect(explain(caught(() => fs.readFileSync(42n as unknown as string)))).toBeUndefined();
  });
});
