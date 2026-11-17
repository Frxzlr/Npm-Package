import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinRules } from '../src/index.js';
import { repoRoot } from './helpers.js';

describe('documentation', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

  it('lists every built-in diagnosis in the README', () => {
    const missing = builtinRules.map((r) => r.id).filter((id) => !readme.includes(`\`${id}\``));
    expect(missing).toEqual([]);
  });

  it('states the right number of built-in diagnoses', () => {
    expect(readme).toContain(`${builtinRules.length} built-in diagnoses`);
  });
});
