import type { Rule } from '../types.js';
import { dataRules } from './data.js';
import { moduleRules } from './modules.js';
import { networkRules } from './network.js';
import { runtimeRules } from './runtime.js';
import { systemRules } from './system.js';

/** Every built-in rule, in evaluation order. */
export const builtinRules: readonly Rule[] = Object.freeze([
  ...moduleRules,
  ...networkRules,
  ...systemRules,
  ...dataRules,
  ...runtimeRules,
]);
