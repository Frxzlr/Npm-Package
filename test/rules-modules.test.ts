import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { explain } from '../src/index.js';
import { crash, info, project, stripsTypes } from './helpers.js';

describe('module-path-not-found', () => {
  it('suggests the missing extension and points at the import line', () => {
    const { diagnosis, dir } = crash(
      {
        'package.json': '{"type":"module"}',
        'src/utils.js': 'export const x = 1;\n',
        'src/index.js': "// entry\nimport { x } from './utils';\nconsole.log(x);\n",
      },
      'src/index.js',
    );
    expect(diagnosis?.id).toBe('module-path-not-found');
    expect(diagnosis?.title).toBe('`./utils` is missing its file extension — use `./utils.js`');
    expect(diagnosis?.location).toMatchObject({ file: path.join(dir, 'src/index.js'), line: 2 });
  });

  it('explains directory imports', () => {
    const { diagnosis } = crash(
      {
        'package.json': '{"type":"module"}',
        'lib/index.js': 'export default 1;\n',
        'main.js': "import x from './lib';\nconsole.log(x);\n",
      },
      'main.js',
    );
    expect(diagnosis?.title).toContain(
      "Directory imports don't work in ES modules — import `./lib/index.js`",
    );
  });

  it.runIf(stripsTypes)(
    'explains .js imports of TypeScript sources when running .ts directly',
    () => {
      const { diagnosis } = crash(
        {
          'package.json': '{"type":"module"}',
          'src/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
          'src/main.ts': "import { add } from './math.js';\nconsole.log(add(1, 2));\n",
        },
        'src/main.ts',
      );
      expect(diagnosis?.title).toBe("`./math.js` doesn't exist — the file is `./math.ts`");
      expect(diagnosis?.fixes.join('\n')).toContain('rewriteRelativeImportExtensions');
    },
  );

  it('suggests a similarly named file', () => {
    const { diagnosis } = crash(
      {
        'package.json': '{"type":"module"}',
        'utils.js': 'export const x = 1;\n',
        'index.js': "import { x } from './utlis.js';\n",
      },
      'index.js',
    );
    expect(diagnosis?.title).toBe("`./utlis.js` doesn't exist — did you mean `./utils.js`?");
    expect(diagnosis?.confidence).toBe('high');
  });

  it('detects letter-case mismatches', () => {
    const dir = project({ 'utils.js': '', 'index.js': '' });
    const d = explain(
      info({
        code: 'ERR_MODULE_NOT_FOUND',
        message: `Cannot find module '${path.join(dir, 'Utils.js')}' imported from ${path.join(dir, 'index.js')}`,
      }),
    );
    expect(d?.title).toBe('`./Utils.js` has the wrong letter case — the file is `./utils.js`');
  });

  it('handles require() of a missing relative file and of a TypeScript-only file', () => {
    const missing = crash({ 'a.cjs': "require('./nothing-here');\n" }, 'a.cjs');
    expect(missing.diagnosis).toMatchObject({ id: 'module-path-not-found', confidence: 'medium' });
    expect(missing.diagnosis?.title).toBe("`./nothing-here` doesn't exist");

    const tsOnly = crash(
      { 'helper.ts': 'module.exports = 1;\n', 'a.cjs': "require('./helper');\n" },
      'a.cjs',
    );
    expect(tsOnly.diagnosis?.title).toBe("`./helper` doesn't exist — the file is `./helper.ts`");
  });
});

describe('package-not-found', () => {
  it('suggests a typo fix from installed and declared packages', () => {
    const { diagnosis, dir } = crash(
      {
        'package.json': '{"type":"module","dependencies":{"lodash":"^4.0.0"}}',
        'node_modules/lodash/package.json': '{"name":"lodash","main":"index.js"}',
        'node_modules/lodash/index.js': 'module.exports = {};\n',
        'index.js': "import _ from 'lodahs';\n",
      },
      'index.js',
    );
    expect(diagnosis?.title).toBe("`lodahs` isn't installed — did you mean `lodash`?");
    expect(diagnosis?.fixes[0]).toBe('Fix the import to use `lodash`');
    expect(diagnosis?.location).toMatchObject({ file: path.join(dir, 'index.js'), line: 1 });
  });

  it('notices a declared but uninstalled dependency and uses the right package manager', () => {
    const { diagnosis } = crash(
      {
        'package.json': '{"dependencies":{"zod":"^3.0.0"}}',
        'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
        'index.cjs': "require('zod');\n",
      },
      'index.cjs',
    );
    expect(diagnosis?.title).toBe("`zod` is in package.json but isn't installed");
    expect(diagnosis?.explanation).toContain("there's no `node_modules` folder at all");
    expect(diagnosis?.fixes).toEqual(['Install dependencies: `pnpm install`']);
  });

  it('blames a dependency that is missing its own dependency', () => {
    const { diagnosis } = crash(
      {
        'package.json': '{"dependencies":{"a":"1.0.0"}}',
        'node_modules/a/package.json': '{"name":"a","main":"index.js"}',
        'node_modules/a/index.js': "require('peer-thing');\n",
        'index.cjs': "require('a');\n",
      },
      'index.cjs',
    );
    expect(diagnosis?.title).toBe('`peer-thing` is missing — `a` needs it');
    expect(diagnosis?.confidence).toBe('medium');
  });

  it('notices when only @types are installed', () => {
    const { diagnosis } = crash(
      {
        'package.json': '{}',
        'node_modules/@types/express/package.json': '{"name":"@types/express"}',
        'index.cjs': "require('express');\n",
      },
      'index.cjs',
    );
    expect(diagnosis?.explanation).toContain(
      'Only its type definitions (`@types/express`) are installed',
    );
  });

  it('handles unknown built-ins', () => {
    const d = explain(
      info({
        message: "Cannot find module 'node:nonexistent'",
        code: 'ERR_UNKNOWN_BUILTIN_MODULE',
      }),
    );
    expect(d?.id).toBe('package-not-found');
  });
});

describe('package-subpath-not-exported', () => {
  it('lists entry points and suggests the closest one', () => {
    const { diagnosis } = crash(
      {
        'node_modules/expkg/package.json':
          '{"name":"expkg","exports":{".":"./index.js","./feature":"./lib/feature.js","./package.json":"./package.json"}}',
        'node_modules/expkg/index.js': 'module.exports = 1;\n',
        'node_modules/expkg/lib/feature.js': 'module.exports = 2;\n',
        'index.cjs': "require('expkg/lib/feature');\n",
      },
      'index.cjs',
    );
    expect(diagnosis?.title).toBe("`expkg` doesn't export `expkg/lib/feature`");
    expect(diagnosis?.fixes[0]).toBe('Import `expkg/feature` instead');
    expect(diagnosis?.fixes[1]).toBe('Available entry points: `expkg`, `expkg/feature`');
  });

  it('explains ESM-only packages loaded with require()', () => {
    const { diagnosis } = crash(
      {
        'node_modules/esmonly/package.json':
          '{"name":"esmonly","type":"module","exports":{"import":"./index.js"}}',
        'node_modules/esmonly/index.js': 'export default 1;\n',
        'index.cjs': "require('esmonly');\n",
      },
      'index.cjs',
    );
    expect(diagnosis?.title).toBe("`esmonly` is ESM-only and can't be loaded with `require()`");
    expect(diagnosis?.fixes[0]).toContain("await import('esmonly')");
  });
});

describe('require-esm / require-async-module', () => {
  const message =
    'require() of ES Module /app/node_modules/chalk/source/index.js from /app/index.js not supported.\nInstead change the require of index.js in /app/index.js to a dynamic import() which is available in all CommonJS modules.';

  it('recommends upgrading on Node.js versions without require(esm)', () => {
    const d = explain(info({ code: 'ERR_REQUIRE_ESM', message }), { nodeVersion: 'v18.20.4' });
    expect(d?.title).toBe("`chalk` is an ES module and can't be loaded with `require()` here");
    expect(d?.fixes[0]).toContain('Upgrade Node.js to 20.19+ or 22.12+');
    expect(d?.confidence).toBe('high');
  });

  it('points at tooling when Node.js itself supports require(esm)', () => {
    const d = explain(info({ code: 'ERR_REQUIRE_ESM', message }), { nodeVersion: 'v22.12.0' });
    expect(d?.explanation).toContain('Jest');
    expect(d?.confidence).toBe('medium');
    expect(d?.fixes.join()).not.toContain('Upgrade Node.js');
  });

  it('names the module in the Node.js 26 message format', () => {
    const d = explain(
      info({
        code: 'ERR_REQUIRE_ASYNC_MODULE',
        message:
          'require() cannot be used on an ESM graph with top-level await. Use import() instead.\nRequired module: /app/node_modules/tlapkg/index.js\nRequire stack:\n- /app/tla.cjs',
      }),
    );
    expect(d?.title).toBe("`tlapkg` uses top-level `await`, so it can't be `require()`d");
  });

  it.runIf(Number(process.versions.node.split('.')[0]) >= 22)(
    'names the package that uses top-level await',
    () => {
      const { diagnosis } = crash(
        {
          'node_modules/tlapkg/package.json': '{"name":"tlapkg","type":"module","main":"index.js"}',
          'node_modules/tlapkg/index.js': 'await Promise.resolve();\nexport default 1;\n',
          'index.cjs': "require('tlapkg');\n",
        },
        'index.cjs',
      );
      expect(diagnosis?.title).toBe("`tlapkg` uses top-level `await`, so it can't be `require()`d");
    },
  );
});

describe('import-in-commonjs', () => {
  it('explains .cjs files', () => {
    const { diagnosis } = crash({ 'a.cjs': "import fs from 'fs';\n" }, 'a.cjs');
    expect(diagnosis?.title).toBe("`a.cjs` is a `.cjs` file, so it can't use `import`");
  });

  it('names the package.json "type" that made the file CommonJS', () => {
    const { diagnosis } = crash(
      {
        'package.json': '{"type":"commonjs"}',
        'index.js': "import fs from 'fs';\nconsole.log(fs);\n",
      },
      'index.js',
    );
    expect(diagnosis?.title).toBe('`index.js` uses `import`, but Node.js loads it as CommonJS');
    expect(diagnosis?.explanation).toContain('`package.json` sets `"type": "commonjs"`');
    expect(diagnosis?.fixes[0]).toBe('Add `"type": "module"` to `package.json`');
  });

  it('gives Jest-specific advice for ESM dependencies', () => {
    const d = explain(
      info({
        name: 'SyntaxError',
        message: 'Cannot use import statement outside a module',
        frames: [
          {
            file: '/app/node_modules/jest-runtime/build/index.js',
            line: 1,
            isInternal: false,
            isDependency: true,
          },
        ],
        sourceHint: { file: '/app/node_modules/nanoid/index.js', line: 1 },
      }),
    );
    expect(d?.title).toBe("Jest can't load `nanoid` because it ships ES modules");
    expect(d?.fixes[0]).toContain('transformIgnorePatterns');
  });
});

describe('commonjs-in-esm', () => {
  it('replaces __dirname with import.meta.dirname on modern Node.js', () => {
    const { diagnosis } = crash(
      { 'package.json': '{"type":"module"}', 'a.js': 'console.log(__dirname);\n' },
      'a.js',
    );
    expect(diagnosis?.title).toBe("`__dirname` doesn't exist in ES modules");
    expect(diagnosis?.fixes[0]).toBe('Use `import.meta.dirname`');
  });

  it('falls back to fileURLToPath on older Node.js', () => {
    const d = explain(
      info({ name: 'ReferenceError', message: '__dirname is not defined in ES module scope' }),
      {
        nodeVersion: 'v20.5.0',
      },
    );
    expect(d?.fixes[0]).toContain('fileURLToPath(import.meta.url)');
  });

  it('explains require in ES modules', () => {
    const { diagnosis } = crash({ 'a.mjs': "const fs = require('fs');\n" }, 'a.mjs');
    expect(diagnosis?.title).toBe("`require` doesn't exist in ES modules");
    expect(diagnosis?.fixes.join('\n')).toContain('createRequire(import.meta.url)');
  });
});

describe('unknown-file-extension / TypeScript', () => {
  it('explains .jsx files', () => {
    const { diagnosis } = crash(
      {
        'package.json': '{"type":"module"}',
        'comp.jsx': 'export default 1;\n',
        'a.js': "import c from './comp.jsx';\n",
      },
      'a.js',
    );
    expect(diagnosis?.title).toBe("Node.js can't run `.jsx` files");
  });

  it('explains asset imports and old Node.js without type stripping', () => {
    const css = explain(
      info({
        code: 'ERR_UNKNOWN_FILE_EXTENSION',
        message: 'Unknown file extension ".css" for /app/a.css',
      }),
    );
    expect(css?.title).toBe("Node.js can't import `.css` files");
    const ts = explain(
      info({
        code: 'ERR_UNKNOWN_FILE_EXTENSION',
        message: 'Unknown file extension ".ts" for /app/src/a.ts',
      }),
      {
        nodeVersion: 'v20.10.0',
        cwd: '/app',
      },
    );
    expect(ts?.title).toBe("Node.js v20.10.0 can't run TypeScript files directly");
    expect(ts?.fixes[0]).toBe('Run it with tsx: `npx tsx src/a.ts`');
  });

  it.runIf(stripsTypes)('explains TypeScript in node_modules', () => {
    const { diagnosis } = crash(
      {
        'package.json': '{"type":"module"}',
        'node_modules/tspkg/package.json':
          '{"name":"tspkg","type":"module","exports":"./index.ts"}',
        'node_modules/tspkg/index.ts': 'export const a: number = 1;\n',
        'a.js': "import { a } from 'tspkg';\n",
      },
      'a.js',
    );
    expect(diagnosis?.title).toBe(
      "`tspkg` ships TypeScript source, which Node.js won't run from node_modules",
    );
  });

  it.runIf(stripsTypes)('explains enums under type stripping', () => {
    const { diagnosis } = crash(
      {
        'package.json': '{"type":"module"}',
        'e.ts': 'enum Color { Red }\nconsole.log(Color.Red);\n',
      },
      'e.ts',
    );
    expect(diagnosis?.title).toBe("Node.js can't run TypeScript enum syntax without compiling");
    expect(diagnosis?.fixes[0]).toContain('as const');
  });
});

describe('json-import-attribute', () => {
  it('explains missing JSON import attributes', () => {
    const { diagnosis } = crash(
      {
        'package.json': '{"type":"module"}',
        'data.json': '{"a":1}',
        'a.js': "import d from './data.json';\n",
      },
      'a.js',
    );
    expect(diagnosis?.title).toBe("JSON imports need `with { type: 'json' }`");
    expect(diagnosis?.fixes[0]).toContain("import data from './data.json' with { type: 'json' };");
  });

  it('explains the removed `assert` syntax', () => {
    const { diagnosis } = crash(
      {
        'package.json': '{"type":"module"}',
        'data.json': '{"a":1}',
        'a.js': "import d from './data.json' assert { type: 'json' };\n",
      },
      'a.js',
    );
    expect(diagnosis?.id).toBe('json-import-attribute');
    expect(diagnosis?.confidence).toBe('high');
  });
});

describe('native-module-mismatch / openssl-legacy', () => {
  it('maps NODE_MODULE_VERSION to Node.js versions', () => {
    const message =
      "The module '/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\nwas compiled against a different Node.js version using\nNODE_MODULE_VERSION 115. This version of Node.js requires\nNODE_MODULE_VERSION 137. Please try re-compiling or re-installing\nthe module (for instance, using `npm rebuild` or `npm install`).";
    const d = explain(info({ code: 'ERR_DLOPEN_FAILED', message }), {
      nodeVersion: 'v24.1.0',
      cwd: '/',
    });
    expect(d?.title).toBe('`better-sqlite3` was compiled for Node.js 20, but this is Node.js 24');
    expect(d?.fixes[0]).toBe('Rebuild it: `npm rebuild better-sqlite3`');
  });

  it('detects binaries built for another OS', () => {
    const d = explain(
      info({
        code: 'ERR_DLOPEN_FAILED',
        message: '/app/node_modules/sharp/build/Release/sharp.node: invalid ELF header',
      }),
    );
    expect(d?.title).toBe('`sharp` was compiled for a different operating system');
    expect(d?.fixes.join()).toContain('.dockerignore');
  });

  it('explains ERR_OSSL_EVP_UNSUPPORTED', () => {
    const d = explain(
      info({
        code: 'ERR_OSSL_EVP_UNSUPPORTED',
        message: 'error:0308010C:digital envelope routines::unsupported',
      }),
    );
    expect(d?.id).toBe('openssl-legacy');
    expect(d?.fixes[1]).toContain('--openssl-legacy-provider');
  });
});
