import path from 'node:path';
import { calleeAt, receiverOf, shorten } from '../source.js';
import type { ErrorInfo, Rule, RuleContext, SourceLocation, StackFrame } from '../types.js';
import { code, displayPath, packageFromPath } from '../util.js';
import { DOCS, defineRule, finding, fixes, locate } from './helpers.js';

/** The first frame (the throw site) and whether it is inside a dependency. */
function throwSite(error: ErrorInfo, ctx: RuleContext) {
  const top = error.frames.find((f) => !f.isInternal);
  const user = ctx.userFrame(error);
  const inDependency = !!top && top.isDependency;
  const library = inDependency && top ? packageFromPath(top.file)?.name : undefined;
  return { top, user, inDependency, library };
}

function frameLocation(frame: StackFrame | undefined): SourceLocation | undefined {
  if (!frame || frame.line === undefined) return undefined;
  const loc: SourceLocation = { file: frame.file, line: frame.line };
  if (frame.column !== undefined) loc.column = frame.column;
  return loc;
}

function lineAt(ctx: RuleContext, frame: StackFrame | undefined): string | undefined {
  return frame?.line === undefined ? undefined : ctx.sourceLine(frame.file, frame.line);
}

const ARRAY_PROPS = /^(?:map|filter|forEach|reduce|find|some|every|length|flatMap|join|includes)$/;

export const propertyOfUndefined = defineRule({
  id: 'property-of-undefined',
  summary:
    'Cannot read/set properties of undefined/null — names the exact expression that was undefined',
  diagnose(error, ctx) {
    if (error.name !== 'TypeError') return undefined;
    const msg = error.message;
    let kind: string | undefined;
    let prop: string | undefined;
    let op: 'read' | 'set' | 'destructure';
    let expr: string | undefined;

    let m =
      /^Cannot (read|set) properties of (undefined|null) \((?:reading|setting) '(.*)'\)$/.exec(msg);
    if (m) {
      op = m[1] === 'set' ? 'set' : 'read';
      kind = m[2];
      prop = m[3];
    } else if ((m = /^Cannot (read|set) property '(.*)' of (undefined|null)$/.exec(msg))) {
      op = m[1] === 'set' ? 'set' : 'read';
      prop = m[2];
      kind = m[3];
    } else if (
      (m = /^Cannot destructure property '(.*)' of '(.*)' as it is (undefined|null)\.?$/.exec(msg))
    ) {
      op = 'destructure';
      prop = m[1];
      kind = m[3];
      if (m[2] && m[2] !== 'undefined' && m[2] !== 'null' && !m[2].includes('intermediate value'))
        expr = m[2];
    } else {
      return undefined;
    }
    if (kind === undefined || prop === undefined) return undefined;

    const { top, user, inDependency, library } = throwSite(error, ctx);
    if (inDependency && library) {
      return finding({
        title: `${code(library)} read ${code(`.${prop}`)} of ${kind}`,
        explanation: `The error happened inside ${code(library)}, not in your code. Usually that means an argument or option you passed to it was ${code(kind)} — check the call${user ? ` at ${displayPath(user.file, ctx.cwd)}:${user.line}` : ''}.`,
        fixes: [
          `Log the arguments you pass to ${code(library)} right before the call`,
          `Check ${code(library)}'s documentation for required options (and the version you have installed)`,
        ],
        location: frameLocation(user),
        confidence: 'medium',
      });
    }

    const frame = user ?? top;
    if (!expr && op !== 'destructure') {
      const line = lineAt(ctx, frame);
      if (line !== undefined) expr = receiverOf(line, frame?.column, prop);
    }
    const location = frameLocation(frame) ?? locate(error, ctx);
    const shown = expr ? shorten(expr) : undefined;

    let title: string;
    let explanation: string;
    if (op === 'destructure') {
      title = shown
        ? `Destructuring ${code(prop)} from ${code(shown)}, which is ${kind}`
        : `Destructuring ${code(prop)} from a value that is ${kind}`;
      explanation = `${code(`const { ${prop} } = …`)} needs an object, but the value was ${code(kind)}.`;
    } else if (shown) {
      title = `${code(shown)} is ${kind}`;
      explanation =
        op === 'set'
          ? `Your code assigns ${code(`.${prop}`)} on ${code(shown)}, but ${code(shown)} is ${code(kind)} at that point.`
          : `Your code reads ${code(`.${prop}`)} from ${code(shown)}, but ${code(shown)} is ${code(kind)} at that point.`;
    } else {
      title = `Tried to ${op === 'set' ? 'set' : 'read'} ${code(`.${prop}`)} on ${kind}`;
      explanation = `The object you expected was ${code(kind)} when ${code(`.${prop}`)} was ${op === 'set' ? 'assigned' : 'read'}.`;
    }

    const isThis = expr === 'this';
    const isReqBody = !!expr && /(?:^|\.)req(?:uest)?\.body$/.test(expr);
    const isCall = !!expr && /\)$/.test(expr);
    const isIndex = !!expr && /\]$/.test(expr);
    const callee = isCall && expr ? expr.slice(0, expr.lastIndexOf('(')) : undefined;
    let fixList: string[];
    if (isThis) {
      explanation += ` ${code('this')} is lost when a method is passed as a callback (event handlers, ${code('setTimeout')}, ${code('.then')}, array methods).`;
      fixList = [
        `Wrap the callback in an arrow function: ${code('() => this.handle()')}`,
        `Or bind the method once in the constructor: ${code('this.handle = this.handle.bind(this)')}`,
        `Or define it as an arrow-function class field: ${code('handle = () => { … }')}`,
      ];
    } else if (isReqBody) {
      explanation += ` Express doesn't parse request bodies unless you add a body-parsing middleware.`;
      fixList = [
        `Register body parsers before your routes: ${code('app.use(express.json())')} (and ${code('express.urlencoded({ extended: true })')} for forms)`,
        `Make sure the client sends ${code('Content-Type: application/json')}`,
      ];
    } else if (isCall && callee) {
      fixList = [
        `Check that ${code(callee)} returns a value on every code path — a missing ${code('return')} gives ${code('undefined')}`,
        `If ${code(callee)} is async, add ${code('await')}`,
        `Guard the access: ${code(`${shorten(expr ?? '', 40)}?.${prop}`)}`,
      ];
    } else if (isIndex) {
      fixList = [
        'The array or object may not contain that index/key — check its length or keys first',
        `Use optional chaining: ${code(`${shorten(expr ?? '', 40)}?.${prop}`)}`,
      ];
    } else if (shown) {
      fixList = fixes(
        op === 'read'
          ? ARRAY_PROPS.test(prop)
            ? `Default it to an empty array: ${code(`(${shorten(expr ?? '', 40)} ?? []).${prop}`)}`
            : `Guard the access: ${code(`${shorten(expr ?? '', 40)}?.${prop}`)}`
          : op === 'set'
            ? `Initialise it first: ${code(`${shorten(expr ?? '', 40)} ??= {}`)}`
            : `Provide a default: ${code(`const { ${prop} } = ${shorten(expr ?? 'value', 40)} ?? {}`)}`,
        `Find where ${code(shown)} gets its value and log it just before this line`,
        `If it comes from an async call, check for a missing ${code('await')}`,
      );
    } else {
      fixList = [
        'Log the value just before this line to see what it really is',
        `Guard the access with optional chaining (${code('?.')}) or provide a default`,
        `Values from async code: check for a missing ${code('await')}`,
      ];
    }
    return finding({
      title,
      explanation,
      fixes: fixList,
      location,
      confidence: shown || isThis ? 'high' : 'medium',
    });
  },
});

const ARRAY_METHODS = new Set([
  'map',
  'forEach',
  'filter',
  'reduce',
  'find',
  'findIndex',
  'some',
  'every',
  'flatMap',
  'includes',
  'join',
  'push',
  'slice',
  'sort',
  'concat',
  'indexOf',
  'at',
  'flat',
  'fill',
  'findLast',
  'splice',
]);
const STRING_METHODS = new Set([
  'toUpperCase',
  'toLowerCase',
  'trim',
  'trimStart',
  'trimEnd',
  'split',
  'replace',
  'replaceAll',
  'startsWith',
  'endsWith',
  'padStart',
  'padEnd',
  'charAt',
  'substring',
  'match',
  'localeCompare',
]);

function interopDefault(expr: string): boolean {
  return /^\(0\s*,\s*[\w$]+\.default\)$|^[\w$]+\.default$|^[\w$]+_\d+\.default$/.test(expr);
}

export const notAFunction = defineRule({
  id: 'not-a-function',
  summary:
    'x is not a function — default/named import mix-ups, non-arrays, non-Promises, axios .json()',
  diagnose(error, ctx) {
    if (error.name !== 'TypeError') return undefined;
    const m = /^(.+?) is not a function(?: or its return value is not iterable)?$/.exec(
      error.message,
    );
    if (!m?.[1]) return undefined;
    const { top, user, inDependency, library } = throwSite(error, ctx);
    const frame = user ?? top;
    let expr = m[1];
    if (expr.includes('(intermediate value)') && !inDependency) {
      const line = lineAt(ctx, frame);
      expr = (line !== undefined ? calleeAt(line, frame?.column) : undefined) ?? expr;
    }
    const location = frameLocation(frame) ?? locate(error, ctx);
    const shown = shorten(expr);
    const dot = expr.lastIndexOf('.');
    const method = dot > 0 ? expr.slice(dot + 1) : undefined;
    const receiver = dot > 0 ? shorten(expr.slice(0, dot)) : undefined;

    if (interopDefault(expr)) {
      return finding({
        title: "The module's default export isn't a function",
        explanation: `Your code calls a default import (${code(shown)}), but the module doesn't provide a callable default export — the classic CommonJS/ES module interop mix-up (${code("import x from 'cjs-module'")} vs ${code('module.exports = { x }')}).`,
        fixes: [
          `Use a named import: ${code("import { thing } from 'module'")}`,
          `Or import the namespace and inspect it: ${code("import * as mod from 'module'")}`,
          `In TypeScript, check ${code('esModuleInterop')} in tsconfig.json`,
        ],
        location,
      });
    }
    const transpiledNamed = /^\(0\s*,\s*[\w$]+\.([\w$]+)\)$/.exec(expr);
    if (transpiledNamed?.[1]) {
      const name = transpiledNamed[1];
      return finding({
        title: `The imported ${code(name)} is not a function`,
        explanation: `The named import ${code(name)} is undefined or not a function — the module may not export that name (typo, renamed export, default vs named), or a circular import left it undefined at call time.`,
        fixes: [
          "Check the module's exports and the exact spelling of the import",
          'Look for circular imports between these modules',
        ],
        location,
        confidence: 'medium',
      });
    }
    if (method && receiver) {
      if (ARRAY_METHODS.has(method)) {
        return finding({
          title: `${code(receiver)} is not an array`,
          explanation: `${code(`.${method}()`)} is an array method, but ${code(receiver)} holds something else — often an object wrapping the array (${code('{ data: [...] }')}), a Promise (missing ${code('await')}), a string, or ${code('null')} from an API.`,
          fixes: [
            `Log its real shape: ${code(`console.log(${receiver})`)}`,
            `Guard it: ${code(`Array.isArray(${receiver}) ? … : …`)}`,
            `If it comes from an async call, add ${code('await')}`,
            `For plain objects, iterate with ${code('Object.values(obj)')} or ${code('Object.entries(obj)')}`,
          ],
          location,
        });
      }
      if (method === 'then') {
        return finding({
          title: `${code(receiver)} is not a Promise`,
          explanation: `${code('.then()')} only exists on Promises, but this value is something else — the function probably didn't ${code('return')} its Promise.`,
          fixes: [
            `Return the Promise from the function (${code('return fetch(…)')})`,
            `Or use ${code('await')}, which works on any value`,
          ],
          location,
        });
      }
      if (method === 'json') {
        const axios = ctx.findUp(
          path.join('node_modules', 'axios'),
          frame ? path.dirname(frame.file) : ctx.cwd,
        );
        return finding({
          title: `${code(receiver)} has no ${code('.json()')} method`,
          explanation: `${code('.json()')} exists on fetch ${code('Response')} objects. With axios (and similar clients), the body is already parsed for you.`,
          fixes: [
            `With axios, use ${code(`${receiver}.data`)}`,
            `With fetch, make sure ${code(receiver)} is the ${code('Response')} (not already-parsed data)`,
          ],
          location,
          confidence: axios ? 'high' : 'medium',
        });
      }
      if (STRING_METHODS.has(method)) {
        return finding({
          title: `${code(receiver)} is not a string`,
          explanation: `${code(`.${method}()`)} is a string method, but the value is something else (a number, array, object, or ${code('null')}).`,
          fixes: [
            `Check where it comes from — log ${code(`typeof ${receiver}`)}`,
            `Convert explicitly if needed: ${code(`String(${receiver}).${method}(…)`)}`,
          ],
          location,
        });
      }
      if (method === 'toFixed' || method === 'toPrecision') {
        return finding({
          title: `${code(receiver)} is not a number`,
          explanation: `${code(`.${method}()`)} only exists on numbers. Values from APIs, forms and query strings are often numeric strings.`,
          fixes: [`Convert first: ${code(`Number(${receiver}).${method}(2)`)}`],
          location,
        });
      }
    }
    if (expr === 'next') {
      return finding({
        title: `${code('next')} is not a function — check the middleware signature`,
        explanation: `Express passes ${code('next')} as the third argument to middleware and the fourth to error handlers. With the wrong number of parameters, ${code('next')} is something else.`,
        fixes: [
          `Middleware: ${code('(req, res, next) => { … }')}`,
          `Error handlers must declare all four parameters: ${code('(err, req, res, next) => { … }')}`,
          `Don't call middleware yourself without passing ${code('next')}`,
        ],
        location,
        confidence: 'medium',
      });
    }
    if (/^require\(.*\)$/.test(expr)) {
      return finding({
        title: "The required module isn't a function",
        explanation: `${code('require(…)')} returned the module's exports, which here is an object — not a function.`,
        fixes: [
          `Inspect what it exports: ${code(`console.log(${expr})`)}`,
          `Use the named export, or ${code('.default')} for transpiled ES modules`,
        ],
        location,
        confidence: 'medium',
      });
    }
    return finding({
      title: `${code(shown)} is not a function`,
      explanation: `The code calls ${code(`${shown}(…)`)}, but that value isn't a function — commonly a typo, an import/export name mismatch, or a value that is still ${code('undefined')} at that moment${library ? ` (the call happens inside ${code(library)})` : ''}.`,
      fixes: [
        'Check the spelling, and that the module really exports it under that name',
        `Log ${code(`typeof ${shorten(expr, 40)}`)} right before the call`,
        'Circular imports can leave an imported function undefined at call time',
      ],
      location,
      confidence: 'low',
    });
  },
});

export const notAConstructor = defineRule({
  id: 'not-a-constructor',
  summary: 'x is not a constructor — default/named import mix-ups and arrow functions',
  diagnose(error, ctx) {
    if (error.name !== 'TypeError') return undefined;
    const m = /^(.+?) is not a constructor$/.exec(error.message);
    if (!m?.[1]) return undefined;
    const expr = m[1];
    const location = locate(error, ctx);
    if (interopDefault(expr)) {
      return finding({
        title: "The module's default export isn't a class",
        explanation: `${code(`new ${expr}`)} uses a default import, but the module doesn't provide a constructible default export (CommonJS/ES module interop mix-up).`,
        fixes: [
          `Use the named export: ${code("import { Thing } from 'module'")}`,
          `In TypeScript, check ${code('esModuleInterop')}`,
        ],
        location,
      });
    }
    return finding({
      title: `${code(shorten(expr))} can't be used with ${code('new')}`,
      explanation: `${code('new')} needs a class or constructor function. This value is something else — often a default/named import mix-up (${code('import Foo')} vs ${code('import { Foo }')}), an object of exports, or an arrow function (arrow functions can't be constructed).`,
      fixes: [
        'Check how the module exports it and match the import style',
        `Log ${code(shorten(expr, 40))} to see what it actually is`,
      ],
      location,
      confidence: 'medium',
    });
  },
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const beforeInitialization = defineRule({
  id: 'before-initialization',
  summary: "Cannot access 'x' before initialization — temporal dead zone or a circular import",
  diagnose(error, ctx) {
    if (error.name !== 'ReferenceError') return undefined;
    const m = /^Cannot access '(.+?)' before initialization$/.exec(error.message);
    if (!m?.[1]) return undefined;
    const name = m[1];
    const frame = ctx.userFrame(error);
    const location = frameLocation(frame) ?? locate(error, ctx);
    const text = frame ? ctx.readFile(frame.file) : undefined;
    const lines = text?.split(/\r?\n/) ?? [];
    const id = escapeRegExp(name);
    const importIdx = lines.findIndex((l) =>
      new RegExp(`^\\s*import\\s+(?:type\\s+)?[^;]*\\b${id}\\b[^;]*from\\s*['"]`).test(l),
    );
    if (frame && importIdx !== -1) {
      const spec = /from\s*['"](.+?)['"]/.exec(lines[importIdx] ?? '')?.[1] ?? 'another module';
      return finding({
        title: `${code(name)} was used before its module finished loading — circular import?`,
        explanation: `${code(name)} is imported from ${code(spec)}. Hitting this error on an imported binding almost always means a circular import: ${code(path.basename(frame.file))} and ${code(spec)} import each other (directly or through other files), and one runs before the other has finished.`,
        fixes: [
          `Find the cycle: ${code('npx madge --circular --extensions ts,tsx,js,jsx src/')}`,
          'Move the shared code into a third module that both can import',
          'Or delay the access — use the binding inside a function instead of at module top level',
        ],
        location: { file: frame.file, line: importIdx + 1 },
        confidence: 'medium',
      });
    }
    const declRe = new RegExp(`\\b(?:const|let|class)\\s+${id}\\b`);
    const declIdx = lines.findIndex((l) => declRe.test(l));
    const declCol = declIdx === -1 ? -1 : (declRe.exec(lines[declIdx] ?? '')?.index ?? -1);
    const declaredLater =
      frame?.line !== undefined &&
      declIdx !== -1 &&
      (declIdx + 1 > frame.line ||
        (declIdx + 1 === frame.line && declCol > (frame.column ?? 1) - 1));
    if (frame?.line !== undefined && declaredLater) {
      return finding({
        title:
          declIdx + 1 === frame.line
            ? `${code(name)} is used before its declaration later on line ${frame.line}`
            : `${code(name)} is used on line ${frame.line} but declared on line ${declIdx + 1}`,
        explanation: `${code('let')}, ${code('const')} and ${code('class')} bindings can't be used before their declaration runs (the "temporal dead zone").`,
        fixes: [
          `Move the declaration of ${code(name)} above line ${frame.line}`,
          'Or move the code that uses it into a function that runs later',
        ],
        location,
      });
    }
    return finding({
      title: `${code(name)} was used before it was initialized`,
      explanation: `${code('let')}, ${code('const')} and ${code('class')} bindings can't be used before their declaration runs. If ${code(name)} is imported, a circular import is the usual cause.`,
      fixes: [
        'Move the declaration above its first use',
        `Check for circular imports: ${code('npx madge --circular src/')}`,
      ],
      location,
      confidence: 'medium',
    });
  },
});

const BROWSER_GLOBALS = new Set([
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'navigator',
  'location',
  'self',
  'HTMLElement',
  'Element',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'matchMedia',
  'IntersectionObserver',
  'ResizeObserver',
  'MutationObserver',
  'getComputedStyle',
  'alert',
  'XMLHttpRequest',
  'FileReader',
  'Image',
  'DOMParser',
  'history',
]);

export const browserGlobalOnServer = defineRule({
  id: 'browser-global-on-server',
  summary: 'window/document/localStorage used during SSR, in Node.js scripts or in tests',
  diagnose(error, ctx) {
    if (error.name !== 'ReferenceError') return undefined;
    const name = /^(\w+) is not defined$/.exec(error.message)?.[1];
    if (!name || !BROWSER_GLOBALS.has(name)) return undefined;
    const { user, library } = throwSite(error, ctx);
    return finding({
      title: `${code(name)} is not defined — browser-only code ran in Node.js`,
      explanation:
        `${code(name)} exists only in browsers. This code ran in Node.js: during server-side rendering (Next.js, Nuxt, SvelteKit, Remix, Astro), in a build script, or in tests.` +
        (library
          ? ` The access happens inside ${code(library)}, which expects a browser as soon as it's imported.`
          : ''),
      fixes: fixes(
        `Guard browser-only code: ${code("if (typeof window !== 'undefined') { … }")}`,
        `In components, move it into a client-only hook (React ${code('useEffect')}, Vue ${code('onMounted')}, Svelte ${code('onMount')})`,
        library
          ? `Load ${code(library)} only in the browser: ${code(`await import('${library}')`)} inside an effect, or Next.js ${code("dynamic(() => import('…'), { ssr: false })")}`
          : `Next.js: render the component only on the client with ${code("dynamic(() => import('./Component'), { ssr: false })")}`,
        `In tests, use a DOM environment (${code("environment: 'jsdom'")} or ${code("'happy-dom'")})`,
      ),
      location: frameLocation(user) ?? locate(error, ctx),
    });
  },
});

/** Node.js version in which each web global became available without a flag (from the Node.js docs). */
const GLOBAL_SINCE: Record<string, [number, number]> = {
  fetch: [18, 0],
  Headers: [18, 0],
  Request: [18, 0],
  Response: [18, 0],
  FormData: [18, 0],
  Blob: [18, 0],
  ReadableStream: [18, 0],
  WritableStream: [18, 0],
  TransformStream: [18, 0],
  BroadcastChannel: [18, 0],
  structuredClone: [17, 0],
  AbortController: [15, 0],
  AbortSignal: [15, 0],
  TextEncoder: [11, 0],
  TextDecoder: [11, 0],
  crypto: [19, 0],
  CustomEvent: [19, 0],
  File: [20, 0],
  WebSocket: [22, 0],
};

export const missingGlobal = defineRule({
  id: 'missing-global',
  summary:
    'fetch/structuredClone/WebSocket/... missing: Node.js too old, or a test environment hid it',
  diagnose(error, ctx) {
    if (error.name !== 'ReferenceError') return undefined;
    const name = /^(\w+) is not defined$/.exec(error.message)?.[1];
    const since = name ? GLOBAL_SINCE[name] : undefined;
    if (!name || !since) return undefined;
    const [major, minor] = since;
    const location = locate(error, ctx);
    if (!ctx.nodeAtLeast(major, minor)) {
      return finding({
        title: `${code(name)} needs Node.js ${major}+, but this is ${ctx.nodeVersion}`,
        explanation: `${code(name)} became a global in Node.js ${major}. This version doesn't have it.`,
        fixes: fixes(
          'Upgrade to a maintained Node.js LTS release',
          `Pin the version for everyone with an ${code('.nvmrc')} file and the ${code('engines')} field in package.json`,
          name === 'fetch' &&
            `Or install a fetch implementation such as ${code('undici')} for older Node.js`,
        ),
        location,
      });
    }
    return finding({
      title: `${code(name)} is missing from the global scope`,
      explanation: `Node.js ${ctx.nodeVersion} has ${code(name)}, so something replaced the global environment — most often a test environment such as Jest's ${code('jsdom')}, which doesn't expose Node's ${code(name)}.`,
      fixes: [
        `Run this test in the Node environment (${code('@jest-environment node')} docblock, or ${code("testEnvironment: 'node'")})`,
        `Or provide it in your test setup file (${code(`globalThis.${name} = …`)})`,
        'Or look for an old polyfill that overwrites globals',
      ],
      location,
      confidence: 'medium',
    });
  },
});

function frameKey(f: StackFrame): string {
  return `${f.fn ?? '<anonymous>'}@${f.file}:${f.line ?? 0}`;
}

/** The repeating group of frames in a stack overflow, if there is one. */
function findCycle(frames: StackFrame[]): StackFrame[] | undefined {
  for (let offset = 0; offset <= 2; offset++) {
    const list = frames.slice(offset);
    for (let period = 1; period <= Math.floor(list.length / 2); period++) {
      let ok = true;
      for (let i = 0; i + period < list.length; i++) {
        if (frameKey(list[i] as StackFrame) !== frameKey(list[i + period] as StackFrame)) {
          ok = false;
          break;
        }
      }
      if (ok) return list.slice(0, period);
    }
  }
  return undefined;
}

export const stackOverflow = defineRule({
  id: 'stack-overflow',
  summary: 'Maximum call stack size exceeded — shows the repeating call cycle',
  diagnose(error, ctx) {
    if (!/^Maximum call stack size exceeded$/.test(error.message)) return undefined;
    const cycle = findCycle(error.frames.filter((f) => f.file !== '<anonymous>' || f.fn));
    const accessor = cycle
      ?.map((f) => /^(?:[\w$]+\.)?(set|get) ([\w$]+)/.exec(f.fn ?? ''))
      .find(Boolean);
    const user = ctx.userFrame(error);
    const first = cycle?.find((f) => !f.isInternal && !f.isDependency) ?? user;
    const location = frameLocation(first) ?? locate(error, ctx);
    if (accessor?.[1] && accessor[2]) {
      const kind = accessor[1] === 'set' ? 'setter' : 'getter';
      const prop = accessor[2];
      return finding({
        title: `The ${code(prop)} ${kind} calls itself forever`,
        explanation:
          kind === 'setter'
            ? `${code(`set ${prop}(v)`)} assigns ${code(`this.${prop}`)}, which runs the setter again, and again…`
            : `${code(`get ${prop}()`)} reads ${code(`this.${prop}`)}, which runs the getter again, and again…`,
        fixes: [
          `Store the value in a separate field: ${code(`set ${prop}(v) { this._${prop} = v; }`)} (or a ${code(`#${prop}`)} private field)`,
        ],
        location,
      });
    }
    if (cycle) {
      const names = cycle.map((f) => code(f.fn ?? 'anonymous'));
      const where =
        first?.line !== undefined ? ` (${displayPath(first.file, ctx.cwd)}:${first.line})` : '';
      return finding({
        title:
          cycle.length === 1
            ? `${names[0]} calls itself forever`
            : `Infinite recursion: ${names.join(' → ')} → …`,
        explanation: `These calls repeat until the call stack runs out${where}. The recursion is missing a base case, or the condition that should stop it is never reached.`,
        fixes: [
          'Check the stop condition of the recursive function',
          `Hidden cycles to look for: ${code('toJSON')}/${code('toString')} calling themselves, an event handler re-emitting the same event, or a state update that triggers itself`,
        ],
        location,
      });
    }
    const line = user ? lineAt(ctx, user) : undefined;
    if (line && /\(\s*\.\.\.|,\s*\.\.\./.test(line)) {
      return finding({
        title: 'A huge array was spread into function arguments',
        explanation: `Every spread element becomes a function argument on the stack, so ${code('Math.max(...bigArray)')} or ${code('arr.push(...items)')} overflows for very large arrays.`,
        fixes: [
          `Use a loop or ${code('reduce')}: ${code('const max = arr.reduce((a, b) => (a > b ? a : b), -Infinity)')}`,
          `Push in a loop or use ${code('concat')} instead of spreading`,
        ],
        location: frameLocation(user),
        confidence: 'medium',
      });
    }
    return finding({
      title: 'Maximum call stack size exceeded (infinite or very deep recursion)',
      explanation:
        'A function kept calling itself (directly or through others) until the call stack ran out.',
      fixes: [
        `See more frames with ${code('node --stack-trace-limit=50 …')} and look for the repeating pattern`,
        'For deep but finite recursion, switch to an iterative algorithm',
      ],
      location,
      confidence: 'medium',
    });
  },
});

const RESPONSE_CALL =
  /\b(?:res|response|reply)\s*(?:\.status\([^)]*\))?\.(?:send|json|end|redirect|render|sendFile|sendStatus|download|jsonp)\s*\(/;

export const headersAlreadySent = defineRule({
  id: 'headers-already-sent',
  summary: 'An HTTP response was sent twice (missing return after res.send/res.json)',
  diagnose(error, ctx) {
    if (
      error.code !== 'ERR_HTTP_HEADERS_SENT' &&
      !/Cannot (?:set|remove|render)? ?headers? after they are sent/i.test(error.message)
    ) {
      return undefined;
    }
    const frame = ctx.userFrame(error);
    let earlier: SourceLocation | undefined;
    if (frame?.line !== undefined) {
      const lines = ctx.readFile(frame.file)?.split(/\r?\n/) ?? [];
      for (let i = frame.line - 2; i >= Math.max(0, frame.line - 41); i--) {
        const l = lines[i] ?? '';
        if (RESPONSE_CALL.test(l) && !/^\s*return\b/.test(l) && !/^\s*\/\//.test(l)) {
          earlier = { file: frame.file, line: i + 1 };
          break;
        }
      }
    }
    return finding({
      title: 'A response was sent twice for the same request',
      explanation:
        'This request had already received a response when the code tried to send another one (or change its headers).' +
        (earlier && frame?.line !== undefined
          ? ` Line ${earlier.line} sends a response without ${code('return')}, so execution continues to line ${frame.line}.`
          : ''),
      fixes: [
        `Return when you respond inside a branch: ${code("return res.status(404).json({ error: 'Not found' });")}`,
        `Don't call ${code('next()')} after sending a response`,
        `In async handlers, make sure the success path and the ${code('catch')} block can't both respond`,
      ],
      location: earlier ?? frameLocation(frame) ?? locate(error, ctx),
      docs: DOCS.error('ERR_HTTP_HEADERS_SENT'),
    });
  },
});

export const nonErrorThrown = defineRule({
  id: 'non-error-thrown',
  summary: 'A string or other non-Error value was thrown or rejected — finds where in your code',
  diagnose(error, ctx) {
    const rejection =
      error.code === 'ERR_UNHANDLED_REJECTION' || error.name === 'UnhandledPromiseRejection';
    if (!rejection && error.name !== 'NonError') return undefined;
    let reason = error.message;
    if (rejection) {
      const m = /The promise rejected with the reason "([\s\S]*)"\.?\s*$/.exec(error.message);
      if (!m) return undefined;
      reason = m[1] ?? '';
    }
    const literal = reason.trim();
    const thrownAt = error.sourceHint ? locate(error, ctx) : undefined;
    const matches =
      !thrownAt &&
      literal.length >= 3 &&
      literal.length <= 200 &&
      !/^(?:undefined|null|true|false|\d+)$/.test(literal)
        ? ctx.findInProject(literal, 3)
        : [];
    const shown = literal.length > 60 ? `${literal.slice(0, 57)}...` : literal;
    return finding({
      title: rejection
        ? `A promise was rejected with a non-Error value: ${code(shown)}`
        : `A non-Error value was thrown: ${code(shown)}`,
      explanation:
        `Only ${code('Error')} objects carry a stack trace, so Node.js can't show where this came from.` +
        (rejection ? ' Nothing handled the rejection either.' : '') +
        (matches.length
          ? ` It matches ${matches.length === 1 ? 'this spot' : 'these spots'} in your code: ${matches.map((l) => `${displayPath(l.file, ctx.cwd)}:${l.line}`).join(', ')}.`
          : ''),
      fixes: fixes(
        `Throw and reject with Error objects: ${code(`throw new Error(${JSON.stringify(shown)})`)}`,
        rejection &&
          `Handle rejections: ${code('await')} inside ${code('try/catch')}, or add ${code('.catch(…)')}`,
        !matches.length && !thrownAt && 'Search your code (and dependencies) for this exact value',
      ),
      location: thrownAt ?? matches[0],
    });
  },
});

export const invalidArgument = defineRule({
  id: 'invalid-argument',
  summary: 'A Node.js API received undefined/null or an un-awaited Promise',
  diagnose(error, ctx) {
    if (error.code !== 'ERR_INVALID_ARG_TYPE' && error.code !== 'ERR_INVALID_ARG_VALUE')
      return undefined;
    const m = /^The "(.+?)" (?:argument|property) must be [\s\S]*?\. Received ([\s\S]+)$/.exec(
      error.message,
    );
    if (!m?.[1] || !m[2]) return undefined;
    const arg = m[1];
    const received = m[2].trim();
    const api = error.frames.find(
      (f) => f.isInternal && f.fn && !/^(?:new )?NodeError|validate|hideStackFrames/.test(f.fn),
    )?.fn;
    const apiShown = api ? code(api.replace(/^Object\./, '')) : 'A Node.js API';
    const location = locate(error, ctx);
    if (/^(?:undefined|null)$/.test(received)) {
      return finding({
        title: `${code(arg)} is ${received}`,
        explanation: `${apiShown} was called with ${code(received)} for its ${code(arg)} argument. The value you passed was never set — often a missing environment variable, a missing config field, or a function that didn't return anything.`,
        fixes: [
          'Log the value right before the call',
          'If it comes from an environment variable, check that it is defined (and that .env is loaded)',
          'Validate required config at startup so it fails early with a clear message',
        ],
        location,
        docs: DOCS.error(error.code),
      });
    }
    if (/an instance of Promise/.test(received)) {
      return finding({
        title: `A Promise was passed as ${code(arg)} — missing ${code('await')}?`,
        explanation: `${apiShown} received a Promise for ${code(arg)}. The value came from an async function but wasn't awaited.`,
        fixes: [`Add ${code('await')} before the async call that produces this value`],
        location,
        docs: DOCS.error(error.code),
      });
    }
    return undefined;
  },
});

export const runtimeRules: Rule[] = [
  propertyOfUndefined,
  notAFunction,
  notAConstructor,
  beforeInitialization,
  browserGlobalOnServer,
  missingGlobal,
  stackOverflow,
  headersAlreadySent,
  nonErrorThrown,
  invalidArgument,
];

/** Exposed for tests. */
export const _internal = { findCycle };
