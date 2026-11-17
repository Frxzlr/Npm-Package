import { describe, expect, it } from 'vitest';
import { findSourceHint, isFrameLine, parseFrame, parseStack } from '../src/stack.js';

describe('parseFrame', () => {
  it('parses a named frame', () => {
    expect(parseFrame('    at Server.listen (/app/server.js:10:5)')).toEqual({
      fn: 'Server.listen',
      file: '/app/server.js',
      line: 10,
      column: 5,
      isInternal: false,
      isDependency: false,
    });
  });

  it('parses an anonymous frame', () => {
    expect(parseFrame('    at /app/index.js:3:7')).toMatchObject({
      file: '/app/index.js',
      line: 3,
      column: 7,
    });
  });

  it('strips `async` from named and anonymous frames', () => {
    expect(parseFrame('    at async loadUser (/app/a.js:1:2)')).toMatchObject({
      fn: 'loadUser',
      file: '/app/a.js',
    });
    expect(parseFrame('    at async file:///app/a.mjs:4:9 {')).toMatchObject({
      file: '/app/a.mjs',
      line: 4,
      column: 9,
    });
  });

  it('keeps constructor and alias names', () => {
    expect(parseFrame('at new Foo (/a.js:1:1)')?.fn).toBe('new Foo');
    expect(parseFrame('at Socket.emit [as foo] (node:events:1:2)')).toMatchObject({
      fn: 'Socket.emit [as foo]',
      isInternal: true,
    });
  });

  it('marks Node.js internals and native frames as internal', () => {
    expect(parseFrame('at node:internal/modules/cjs/loader:1:2')?.isInternal).toBe(true);
    expect(parseFrame('at JSON.parse (<anonymous>)')).toMatchObject({
      file: '<anonymous>',
      isInternal: true,
    });
    expect(parseFrame('at async Promise.all (index 0)')?.isInternal).toBe(true);
  });

  it('marks node_modules frames as dependencies', () => {
    expect(
      parseFrame('at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)'),
    ).toMatchObject({
      isDependency: true,
      isInternal: false,
    });
    expect(parseFrame('at x (C:\\app\\node_modules\\lib\\a.js:1:1)')?.isDependency).toBe(true);
  });

  it('handles Windows paths', () => {
    expect(parseFrame('    at C:\\app\\index.js:3:7')).toMatchObject({
      file: 'C:\\app\\index.js',
      line: 3,
      column: 7,
    });
  });

  it('uses the outer location of eval frames', () => {
    expect(parseFrame('at eval (eval at run (/app/a.js:1:2), <anonymous>:1:1)')).toMatchObject({
      file: '/app/a.js',
      line: 1,
    });
  });

  it('parses Vitest-style frames', () => {
    expect(parseFrame(' ❯ src/a.ts:3:7')).toMatchObject({ file: 'src/a.ts', line: 3, column: 7 });
    expect(parseFrame(' ❯ loadUser src/a.ts:3:7')).toMatchObject({
      fn: 'loadUser',
      file: 'src/a.ts',
    });
  });

  it('returns undefined for non-frames', () => {
    expect(parseFrame('Error: boom')).toBeUndefined();
    expect(parseFrame('')).toBeUndefined();
    expect(isFrameLine('  code: "X"')).toBe(false);
    expect(isFrameLine('    at x (y.js:1:1)')).toBe(true);
  });
});

describe('findSourceHint', () => {
  it('finds the closest non-internal arrow block', () => {
    const lines = [
      'node:internal/modules/run_main:107',
      '    triggerUncaughtException(',
      '    ^',
      '',
      'file:///app/en.ts:1',
      'enum E { A }',
      '^^^^^^^^^^^^',
      '',
    ];
    expect(findSourceHint(lines)).toEqual({
      file: '/app/en.ts',
      line: 1,
      column: 1,
      snippet: 'enum E { A }',
    });
  });

  it('ignores internal-only arrows', () => {
    expect(
      findSourceHint(['node:fs:559', '  return binding.open(', '                 ^', '']),
    ).toBeUndefined();
  });
});

describe('parseStack', () => {
  it('returns frames and the source hint of a decorated stack', () => {
    const stack = [
      '/app/a.cjs:1',
      'import fs from "fs"',
      '^^^^^^',
      '',
      'SyntaxError: Cannot use import statement outside a module',
      '    at wrapSafe (node:internal/modules/cjs/loader:1:1)',
    ].join('\n');
    const parsed = parseStack(stack);
    expect(parsed.sourceHint).toMatchObject({ file: '/app/a.cjs', line: 1, column: 1 });
    expect(parsed.frames).toHaveLength(1);
  });

  it('handles empty input', () => {
    expect(parseStack(undefined)).toEqual({ frames: [] });
    expect(parseStack('')).toEqual({ frames: [] });
  });
});
