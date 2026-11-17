import { describe, expect, it } from 'vitest';
import { calleeAt, expressionBefore, receiverOf, shorten } from '../src/source.js';
import {
  closest,
  displayPath,
  distance,
  installCommand,
  isBareSpecifier,
  nodeMajorForAbi,
  packageFromPath,
  packageName,
  relativeSpecifier,
  serviceForPort,
} from '../src/util.js';
import { parseVersion, versionAtLeast } from '../src/context.js';

/** V8-style 1-based column of the first occurrence of `needle` (after `from`). */
function col(line: string, needle: string, from = 0): number {
  return line.indexOf(needle, from) + 1;
}

describe('receiverOf', () => {
  it('finds a member chain', () => {
    const line = 'const y = data.items.map((x) => x);';
    expect(receiverOf(line, col(line, 'map'), 'map')).toBe('data.items');
  });

  it('handles optional chaining, calls and indexes', () => {
    const a = 'const n = a?.b.c.d;';
    expect(receiverOf(a, col(a, 'd;'), 'd')).toBe('a?.b.c');
    const b = 'return getUser(id).profile.name;';
    expect(receiverOf(b, col(b, 'profile'), 'profile')).toBe('getUser(id)');
    const c = 'const first = users[0].name;';
    expect(receiverOf(c, col(c, 'name'), 'name')).toBe('users[0]');
    const d = 'const v = (await res.json()).data.map(f);';
    expect(receiverOf(d, col(d, 'map'), 'map')).toBe('(await res.json()).data');
  });

  it('handles `this`', () => {
    const line = 'this.setState({ open: !this.state.open });';
    expect(receiverOf(line, col(line, 'setState'), 'setState')).toBe('this');
  });

  it('handles assignments where V8 points at `=`', () => {
    const line = 'let u; u.name = 1';
    expect(receiverOf(line, col(line, '='), 'name')).toBe('u');
  });

  it('chooses the occurrence closest to the column', () => {
    const line = 'a.items.length && b.items.map(f)';
    expect(receiverOf(line, col(line, 'items', 20), 'items')).toBe('b');
    expect(receiverOf(line, col(line, 'items'), 'items')).toBe('a');
  });

  it('ignores matches inside strings and comments', () => {
    const line = 'log("data.map"); data.list.map(f) // other.map';
    expect(receiverOf(line, col(line, 'map', 20), 'map')).toBe('data.list');
  });

  it('supports bracket access with literal and computed keys', () => {
    const a = "const v = obj['key'].x;";
    expect(receiverOf(a, col(a, "['key']"), 'key')).toBe('obj');
    const b = 'const v = cache[id].value;';
    expect(receiverOf(b, col(b, '['), 'abc')).toBe('cache');
  });

  it('returns undefined when nothing matches or the line is huge', () => {
    expect(receiverOf('const a = 1;', 1, 'map')).toBeUndefined();
    expect(receiverOf(`x.y.map(f)${' '.repeat(3000)}`, 5, 'map')).toBeUndefined();
  });
});

describe('expressionBefore / calleeAt / shorten', () => {
  it('extracts the callee at a call-site column', () => {
    const line = 'const lib = {}; lib.default()';
    expect(calleeAt(line, col(line, '('))).toBe('lib.default');
    expect(calleeAt('const f = new Foo()', col('const f = new Foo()', 'new'))).toBe('Foo');
    expect(calleeAt('x()', undefined)).toBeUndefined();
  });

  it('stops at operators and rejects keywords', () => {
    expect(expressionBefore('a + b.c', 7)).toBe('b.c');
    expect(expressionBefore('return', 6)).toBeUndefined();
    expect(expressionBefore('', 0)).toBeUndefined();
    expect(expressionBefore('x', 99)).toBeUndefined();
  });

  it('shortens long expressions in the middle', () => {
    const long = 'a'.repeat(100);
    expect(shorten(long, 20)).toHaveLength(19);
    expect(shorten('short', 20)).toBe('short');
  });
});

describe('util', () => {
  it('computes edit distance with transpositions', () => {
    expect(distance('lodash', 'lodash')).toBe(0);
    expect(distance('lodahs', 'lodash')).toBe(1);
    expect(distance('', 'abc')).toBe(3);
    expect(distance('kitten', 'sitting')).toBe(3);
  });

  it('suggests close matches only', () => {
    expect(closest('lodahs', ['express', 'lodash', 'zod'])).toBe('lodash');
    expect(closest('react', ['vue', 'svelte'])).toBeUndefined();
    expect(closest('a', ['b'])).toBe('b');
    expect(closest('same', ['same'])).toBeUndefined();
  });

  it('recognises bare specifiers', () => {
    for (const spec of ['lodash', '@scope/pkg', 'lodash/fp'])
      expect(isBareSpecifier(spec)).toBe(true);
    for (const spec of ['./a', '../a', '/abs', 'C:\\x', 'node:fs', 'file:///x', 'https://x', ''])
      expect(isBareSpecifier(spec)).toBe(false);
  });

  it('extracts package names', () => {
    expect(packageName('@scope/pkg/sub/path')).toBe('@scope/pkg');
    expect(packageName('lodash/fp')).toBe('lodash');
    expect(packageFromPath('/app/node_modules/a/node_modules/@s/b/dist/x.js')).toEqual({
      name: '@s/b',
      root: '/app/node_modules/a/node_modules/@s/b',
    });
    expect(packageFromPath('C:\\app\\node_modules\\chalk\\index.js')?.name).toBe('chalk');
    expect(packageFromPath('/app/src/x.js')).toBeUndefined();
  });

  it('builds paths and specifiers', () => {
    expect(relativeSpecifier('/app/src/index.js', '/app/src/utils.js')).toBe('./utils.js');
    expect(relativeSpecifier('/app/src/index.js', '/app/lib/a.js')).toBe('../lib/a.js');
    expect(displayPath('/app/src/a.js', '/app')).toBe('src/a.js');
    expect(displayPath('/other/a.js', '/app')).toBe('/other/a.js');
    expect(displayPath('relative.js', '/app')).toBe('relative.js');
  });

  it('formats install commands for each package manager', () => {
    expect(installCommand('npm', 'zod')).toBe('npm install zod');
    expect(installCommand('pnpm', 'zod')).toBe('pnpm add zod');
    expect(installCommand('yarn', 'zod')).toBe('yarn add zod');
    expect(installCommand('bun', 'zod')).toBe('bun add zod');
  });

  it('knows common ports and Node ABI versions', () => {
    expect(serviceForPort(5432)).toBe('PostgreSQL');
    expect(serviceForPort(12345)).toBeUndefined();
    expect(serviceForPort(undefined)).toBeUndefined();
    expect(nodeMajorForAbi(115)).toBe(20);
    expect(nodeMajorForAbi(137)).toBe(24);
    expect(nodeMajorForAbi(1)).toBeUndefined();
    expect(nodeMajorForAbi(Number(process.versions.modules))).toBe(
      Number(process.versions.node.split('.')[0]),
    );
  });

  it('compares versions', () => {
    expect(parseVersion('v22.12.0')).toEqual([22, 12, 0]);
    expect(parseVersion('garbage')).toEqual([0, 0, 0]);
    expect(versionAtLeast('v22.12.0', 22, 12)).toBe(true);
    expect(versionAtLeast('v22.11.9', 22, 12)).toBe(false);
    expect(versionAtLeast('v23.0.0', 22, 12)).toBe(true);
    expect(versionAtLeast('v20.19.1', 20, 19, 1)).toBe(true);
  });
});
