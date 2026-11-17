import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { format, supportsColor } from '../src/index.js';
import type { Diagnosis } from '../src/index.js';
import { info, project } from './helpers.js';

function diagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    id: 'demo',
    title: '`data.items` is undefined',
    explanation: 'Your code reads `.map` from `data.items`, but it is `undefined`.',
    fixes: [
      'Guard the access: `data.items?.map`',
      'Use a helper:\nconst list = data.items ?? [];\nlist.map(f);',
    ],
    confidence: 'high',
    error: info({ message: 'x' }),
    ...overrides,
  };
}

describe('format', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders a readable plain-text diagnosis', () => {
    const out = format(diagnosis({ docs: 'https://example.com/docs' }), {
      color: false,
      width: 80,
    });
    expect(out).toBe(
      [
        '',
        'whycrash: `data.items` is undefined',
        '',
        '  Your code reads `.map` from `data.items`, but it is `undefined`.',
        '',
        '  Try',
        '  › Guard the access: `data.items?.map`',
        '  › Use a helper:',
        '      const list = data.items ?? [];',
        '      list.map(f);',
        '',
        '  Docs https://example.com/docs',
        '',
      ].join('\n'),
    );
  });

  it('renders a code frame with a caret under the column', () => {
    const dir = project({
      'src/a.js': 'const data = {};\nconst y = data.items.map((x) => x);\nexport {};\n',
    });
    const out = format(
      diagnosis({ location: { file: path.join(dir, 'src/a.js'), line: 2, column: 22 } }),
      {
        color: false,
        cwd: dir,
      },
    );
    const lines = out.split('\n');
    const at = lines.indexOf(`  ${path.join('src', 'a.js')}:2:22`);
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 5)).toEqual([
      '    1 │ const data = {};',
      '  › 2 │ const y = data.items.map((x) => x);',
      '      │                      ^',
      '    3 │ export {};',
    ]);
  });

  it('keeps long lines readable around the column', () => {
    const dir = project({ 'long.js': `${'x'.repeat(200)}.boom();\n` });
    const out = format(
      diagnosis({ location: { file: path.join(dir, 'long.js'), line: 1, column: 202 } }),
      {
        color: false,
        width: 60,
        cwd: dir,
      },
    );
    const frame = out.split('\n').filter((l) => l.includes('│'));
    const caretLine = frame[1] ?? '';
    const codeLine = frame[0] ?? '';
    expect(codeLine.startsWith('  › 1 │ …')).toBe(true);
    expect(codeLine[caretLine.indexOf('^')]).toBe('b');
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
  });

  it('wraps text to the requested width', () => {
    const out = format(diagnosis({ explanation: 'word '.repeat(60).trim() }), {
      color: false,
      width: 50,
    });
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(50);
  });

  it('keeps short inline code spans on one line', () => {
    const out = format(
      diagnosis({
        explanation: 'aaaa bbbb cccc dddd eeee ffff `const value = something ?? []` gggg',
      }),
      { color: false, width: 50 },
    );
    expect(out).toContain('`const value = something ?? []`');
  });

  it('notes lower confidence and skips missing files or disabled frames', () => {
    expect(format(diagnosis({ confidence: 'medium' }), { color: false })).toContain(
      '· likely cause',
    );
    expect(format(diagnosis({ confidence: 'low' }), { color: false })).toContain(
      '· possible cause',
    );
    const missing = format(diagnosis({ location: { file: '/does/not/exist.js', line: 3 } }), {
      color: false,
      cwd: '/',
    });
    expect(missing).toContain(`${path.join('does', 'not', 'exist.js')}:3`);
    expect(missing).not.toContain('│');
    const dir = project({ 'a.js': 'x\n' });
    const off = format(diagnosis({ location: { file: path.join(dir, 'a.js'), line: 1 } }), {
      color: false,
      codeFrame: false,
    });
    expect(off).not.toContain('a.js:1');
  });

  it('colors output and hides backticks when color is on', () => {
    const out = format(diagnosis(), { color: true });
    expect(out).toContain('\u001b[');
    expect(out).toContain('\u001b[36mdata.items\u001b[39m');
    expect(out).not.toContain('`');
  });

  it('returns an empty string for no diagnosis', () => {
    expect(format(undefined)).toBe('');
  });

  it('detects color support from the environment', () => {
    vi.stubEnv('NO_COLOR', '1');
    vi.stubEnv('FORCE_COLOR', '1');
    expect(supportsColor({ isTTY: true })).toBe(false);
    vi.stubEnv('NO_COLOR', '');
    expect(supportsColor({ isTTY: false })).toBe(true);
    vi.stubEnv('FORCE_COLOR', '0');
    expect(supportsColor({ isTTY: true })).toBe(false);
    vi.unstubAllEnvs();
    vi.stubEnv('NO_COLOR', undefined);
    vi.stubEnv('FORCE_COLOR', undefined);
    vi.stubEnv('TERM', 'dumb');
    expect(supportsColor({ isTTY: true })).toBe(false);
    vi.stubEnv('TERM', 'xterm-256color');
    expect(supportsColor({ isTTY: true })).toBe(true);
    expect(supportsColor(undefined)).toBe(false);
  });
});
