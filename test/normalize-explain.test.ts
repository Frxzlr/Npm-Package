import { describe, expect, it } from 'vitest';
import { builtinRules, defineRule, explain, explainAll } from '../src/index.js';
import type { Rule } from '../src/index.js';
import { fromThrown, toErrorInfo } from '../src/normalize.js';
import { info } from './helpers.js';

describe('fromThrown / toErrorInfo', () => {
  it('normalizes Error objects with codes, props and causes', () => {
    const cause = Object.assign(new Error('inner'), { code: 'ENOENT', path: '/x' });
    const err = Object.assign(new TypeError('outer', { cause }), {
      status: 500,
      nested: { a: 1 },
      list: ['a'],
    });
    const result = fromThrown(err);
    expect(result).toMatchObject({
      name: 'TypeError',
      message: 'outer',
      props: { status: 500, list: ['a'] },
    });
    expect(result.props).not.toHaveProperty('nested');
    expect(result.cause).toMatchObject({ message: 'inner', code: 'ENOENT', props: { path: '/x' } });
    expect(result.frames.length).toBeGreaterThan(0);
    expect(result.original).toBe(err);
    expect(Object.keys(result)).not.toContain('original');
  });

  it('normalizes AggregateError members', () => {
    const result = fromThrown(new AggregateError([new Error('a'), 'b'], 'many'));
    expect(result.errors.map((e) => [e.name, e.message])).toEqual([
      ['Error', 'a'],
      ['NonError', 'b'],
    ]);
  });

  it('survives cause cycles', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;
    expect(fromThrown(err).cause).toBeUndefined();
  });

  it('turns thrown non-errors into NonError', () => {
    for (const [value, message] of [
      ['oops', 'oops'],
      [42, '42'],
      [null, 'null'],
      [undefined, 'undefined'],
      [{ a: 1 }, '{"a":1}'],
    ] as const) {
      expect(fromThrown(value)).toMatchObject({ name: 'NonError', message });
    }
    expect(fromThrown(Symbol('s')).message).toBe('Symbol(s)');
  });

  it('accepts error-like plain objects', () => {
    expect(fromThrown({ message: 'm', code: 'EPIPE' })).toMatchObject({
      name: 'Error',
      message: 'm',
      code: 'EPIPE',
    });
  });

  it('never throws on hostile objects', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('nope');
        },
        ownKeys() {
          throw new Error('nope');
        },
      },
    );
    expect(() => fromThrown(hostile)).not.toThrow();
    const getter = Object.defineProperty(new Error('g'), 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter');
      },
    });
    expect(() => fromThrown(getter)).not.toThrow();
  });

  it('parses strings as error text, codes or messages', () => {
    expect(toErrorInfo('TypeError: fetch failed')).toMatchObject({
      name: 'TypeError',
      message: 'fetch failed',
    });
    expect(toErrorInfo('ECONNREFUSED')).toMatchObject({ code: 'ECONNREFUSED', message: '' });
    expect(toErrorInfo('ERR_REQUIRE_ESM').code).toBe('ERR_REQUIRE_ESM');
    expect(toErrorInfo('something odd happened')).toMatchObject({
      name: 'Error',
      message: 'something odd happened',
    });
  });

  it('passes ErrorInfo through unchanged', () => {
    const value = info({ message: 'x' });
    expect(toErrorInfo(value)).toBe(value);
  });
});

describe('explain / explainAll', () => {
  it('returns undefined for errors no rule recognises', () => {
    expect(explain(new Error('Something specific to my app'))).toBeUndefined();
    expect(explainAll(new Error('nope'))).toEqual([]);
  });

  it('never throws on unusual input', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const value of [
      undefined,
      null,
      0,
      '',
      {},
      [],
      Symbol('x'),
      circular,
      () => 1,
      new Error(),
      10n,
    ]) {
      expect(() => explainAll(value)).not.toThrow();
    }
  });

  it('diagnoses a bare error code', () => {
    expect(explain('EADDRINUSE')?.id).toBe('address-in-use');
  });

  it('prefers the deepest cause and keeps one diagnosis per rule', () => {
    const inner = Object.assign(new Error("ENOENT: no such file or directory, open 'x.json'"), {
      code: 'ENOENT',
      syscall: 'open',
      path: 'x.json',
    });
    const outer = new Error('Failed to load config', { cause: inner });
    const all = explainAll(outer);
    expect(all[0]?.id).toBe('file-not-found');
    expect(all[0]?.error.message).toContain('ENOENT');
    expect(new Set(all.map((d) => d.id)).size).toBe(all.length);
  });

  it('runs custom rules first and lets them win ties', () => {
    const rule = defineRule({
      id: 'acme/db-down',
      diagnose: (error) =>
        error.code === 'ECONNREFUSED' && error.props.port === 5432
          ? {
              title: 'The local database is not running',
              explanation: 'Start it.',
              fixes: ['docker compose up -d db'],
            }
          : undefined,
    });
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 5432,
    });
    const all = explainAll(err, { rules: [rule] });
    expect(all[0]).toMatchObject({
      id: 'acme/db-down',
      confidence: 'high',
      fixes: ['docker compose up -d db'],
    });
    expect(all.map((d) => d.id)).toContain('connection-refused');
  });

  it('can run custom rules only', () => {
    const rule: Rule = { id: 'only', diagnose: () => ({ title: 'mine', explanation: '' }) };
    expect(explainAll('EADDRINUSE', { rules: [rule], builtins: false }).map((d) => d.id)).toEqual([
      'only',
    ]);
  });

  it('ignores rules that throw or return junk', () => {
    const throwing: Rule = {
      id: 'throws',
      diagnose: () => {
        throw new Error('bug in rule');
      },
    };
    const junk = { id: 'junk', diagnose: () => ({ title: '   ' }) } as unknown as Rule;
    const result = explainAll('EADDRINUSE', { rules: [throwing, junk] });
    expect(result.map((d) => d.id)).toEqual(['address-in-use']);
  });

  it('sanitises findings', () => {
    const rule = {
      id: 'loose',
      diagnose: () => ({
        title: '  T  ',
        explanation: 42,
        fixes: ['ok', '', 3, '  '],
        location: { file: '/x.js', line: 0 },
        confidence: 'certain',
        docs: '',
      }),
    } as unknown as Rule;
    const [d] = explainAll('x', { rules: [rule], builtins: false });
    expect(d).toMatchObject({ title: 'T', explanation: '', fixes: ['ok'], confidence: 'high' });
    expect(d).not.toHaveProperty('location');
    expect(d).not.toHaveProperty('docs');
  });

  it('ranks by confidence before depth', () => {
    const low: Rule = {
      id: 'low',
      diagnose: () => ({ title: 'low', explanation: '', confidence: 'low' }),
    };
    const high: Rule = {
      id: 'high',
      diagnose: (e) => (e.message === 'outer' ? { title: 'high', explanation: '' } : undefined),
    };
    const err = new Error('outer', { cause: new Error('inner') });
    expect(explainAll(err, { rules: [low, high], builtins: false }).map((d) => d.id)).toEqual([
      'high',
      'low',
    ]);
  });

  it('rejects invalid rule options with a clear TypeError', () => {
    expect(() => explain('x', { rules: 'nope' as unknown as Rule[] })).toThrow(
      /`rules` must be an array/,
    );
    expect(() => explain('x', { rules: [{ id: '', diagnose: () => undefined }] })).toThrow(
      /rules\[0\]/,
    );
    expect(() => explain('x', { rules: [{ id: 'a' } as unknown as Rule] })).toThrow(/diagnose/);
  });

  it('exposes built-in rules with unique ids and summaries', () => {
    const ids = builtinRules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(builtinRules.length).toBeGreaterThanOrEqual(40);
    for (const rule of builtinRules) expect(rule.summary, rule.id).toBeTruthy();
    expect(Object.isFrozen(builtinRules)).toBe(true);
  });
});
