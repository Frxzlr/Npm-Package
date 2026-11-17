import { Context } from './context.js';
import { toErrorInfo } from './normalize.js';
import { builtinRules } from './rules/index.js';
import type { Confidence, Diagnosis, ErrorInfo, ExplainOptions, Finding, Rule } from './types.js';

const RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
const MAX_DEPTH = 10;

function assertRules(rules: unknown): Rule[] {
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) {
    throw new TypeError(`whycrash: \`rules\` must be an array of rules, got ${typeof rules}`);
  }
  rules.forEach((rule: unknown, i) => {
    const r = rule as Partial<Rule> | null;
    if (
      !r ||
      typeof r !== 'object' ||
      typeof r.id !== 'string' ||
      !r.id ||
      typeof r.diagnose !== 'function'
    ) {
      throw new TypeError(
        `whycrash: rules[${i}] must be an object with a non-empty string \`id\` and a \`diagnose(error, context)\` function`,
      );
    }
  });
  return rules as Rule[];
}

function toDiagnosis(id: string, result: Finding, error: ErrorInfo): Diagnosis | undefined {
  if (
    !result ||
    typeof result !== 'object' ||
    typeof result.title !== 'string' ||
    !result.title.trim()
  ) {
    return undefined;
  }
  const confidence: Confidence =
    result.confidence === 'medium' || result.confidence === 'low' ? result.confidence : 'high';
  const diagnosis: Diagnosis = {
    id,
    title: result.title.trim(),
    explanation: typeof result.explanation === 'string' ? result.explanation.trim() : '',
    fixes: Array.isArray(result.fixes)
      ? result.fixes.filter((f): f is string => typeof f === 'string' && f.trim() !== '')
      : [],
    confidence,
    error,
  };
  const loc = result.location;
  if (loc && typeof loc.file === 'string' && typeof loc.line === 'number' && loc.line > 0) {
    diagnosis.location =
      typeof loc.column === 'number' && loc.column > 0
        ? { file: loc.file, line: loc.line, column: loc.column }
        : { file: loc.file, line: loc.line };
  }
  if (typeof result.docs === 'string' && result.docs) diagnosis.docs = result.docs;
  return diagnosis;
}

/**
 * Every diagnosis for an error and its `cause` chain, best first.
 *
 * Accepts an `Error`, any thrown value, or error text (a pasted stack trace, terminal output).
 * Never throws for bad input; throws `TypeError` only for invalid `options.rules`.
 */
export function explainAll(input: unknown, options: ExplainOptions = {}): Diagnosis[] {
  const custom = assertRules(options.rules);
  const rules = options.builtins === false ? custom : [...custom, ...builtinRules];
  let root: ErrorInfo;
  try {
    root = toErrorInfo(input);
  } catch {
    return [];
  }
  const ctx = new Context(root, options);
  const found: Array<{ diagnosis: Diagnosis; depth: number; order: number }> = [];
  const seen = new Set<ErrorInfo>();

  const visit = (error: ErrorInfo, parent: ErrorInfo | undefined, depth: number): void => {
    if (seen.has(error) || depth > MAX_DEPTH) return;
    seen.add(error);
    const view = ctx.forError(parent);
    rules.forEach((rule, order) => {
      let result: Finding | null | undefined | false;
      try {
        result = rule.diagnose(error, view);
      } catch {
        return; // A broken rule must never break diagnosis (or a crash handler).
      }
      if (!result) return;
      const diagnosis = toDiagnosis(rule.id, result, error);
      if (diagnosis) found.push({ diagnosis, depth, order });
    });
    if (error.cause) visit(error.cause, error, depth + 1);
    for (const child of error.errors) visit(child, error, depth + 1);
  };
  visit(root, undefined, 0);

  // Most confident first; then custom rules; then the deepest cause (closest to the root cause).
  found.sort(
    (a, b) =>
      RANK[b.diagnosis.confidence] - RANK[a.diagnosis.confidence] ||
      Number(b.order < custom.length) - Number(a.order < custom.length) ||
      b.depth - a.depth ||
      a.order - b.order,
  );
  const ids = new Set<string>();
  const out: Diagnosis[] = [];
  for (const { diagnosis } of found) {
    if (ids.has(diagnosis.id)) continue;
    ids.add(diagnosis.id);
    out.push(diagnosis);
  }
  return out;
}

/** The best diagnosis for an error, or `undefined` when no rule recognises it. */
export function explain(input: unknown, options: ExplainOptions = {}): Diagnosis | undefined {
  return explainAll(input, options)[0];
}
