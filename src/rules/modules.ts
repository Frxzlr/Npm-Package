import path from 'node:path';
import { toPath } from '../stack.js';
import type { Rule, RuleContext } from '../types.js';
import {
  closest,
  code,
  displayPath,
  installAllCommand,
  installCommand,
  isBareSpecifier,
  nodeMajorForAbi,
  packageFromPath,
  packageName,
  relativeSpecifier,
} from '../util.js';
import { DOCS, defineRule, findLine, finding, fixes, locate } from './helpers.js';
import { parseVersion } from '../context.js';

const RESOLVABLE_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.json'];
const TS_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx']);
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
  '.jsx': ['.tsx'],
};

function requireEsmSupported(ctx: RuleContext): boolean {
  const [major, minor] = parseVersion(ctx.nodeVersion);
  return major >= 23 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19);
}

function typeStrippingByDefault(ctx: RuleContext): boolean {
  const [major, minor] = parseVersion(ctx.nodeVersion);
  return major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
}

/** Files that an extensionless or mistyped import probably meant. */
function candidatesFor(target: string, ctx: RuleContext): string[] {
  const found: string[] = [];
  const ext = path.extname(target);
  const swaps = JS_TO_TS[ext];
  if (swaps) {
    const base = target.slice(0, -ext.length);
    for (const e of swaps) if (ctx.isFile(base + e)) found.push(base + e);
  }
  for (const e of RESOLVABLE_EXTS) if (ctx.isFile(target + e)) found.push(target + e);
  if (ctx.isDirectory(target)) {
    for (const e of RESOLVABLE_EXTS) {
      const index = path.join(target, `index${e}`);
      if (ctx.isFile(index)) found.push(index);
    }
  }
  // Prefer plain JavaScript over TypeScript sources, keeping discovery order otherwise.
  return found.sort(
    (a, b) => Number(TS_EXTS.has(path.extname(a))) - Number(TS_EXTS.has(path.extname(b))),
  );
}

/** A file in the same folder whose name differs only by letter case. */
function caseMismatch(target: string, ctx: RuleContext): string | undefined {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const lower = base.toLowerCase();
  for (const entry of ctx.readDir(dir)) {
    if (entry === base) return undefined;
    const stem = entry.slice(0, entry.length - path.extname(entry).length);
    if (entry.toLowerCase() === lower || (stem.toLowerCase() === lower && stem !== base)) {
      return path.join(dir, entry);
    }
  }
  return undefined;
}

/** A similarly named file in the same folder. */
function similarFile(target: string, ctx: RuleContext): string | undefined {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, RESOLVABLE_EXTS.includes(ext) ? ext : '');
  const byStem = new Map<string, string>();
  for (const entry of ctx.readDir(dir)) {
    const e = path.extname(entry);
    if (!RESOLVABLE_EXTS.includes(e) && !ctx.isDirectory(path.join(dir, entry))) continue;
    byStem.set(RESOLVABLE_EXTS.includes(e) ? entry.slice(0, -e.length) : entry, entry);
  }
  const match = closest(base, byStem.keys());
  const file = match ? byStem.get(match) : undefined;
  return file ? path.join(dir, file) : undefined;
}

function importLine(ctx: RuleContext, importer: string | undefined, target: string) {
  if (!importer) return undefined;
  const stem = path.basename(target).replace(/\.[^.]+$/, '');
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return findLine(
    ctx,
    importer,
    // The lookbehind makes the match (and so the caret) start at the quoted specifier.
    new RegExp(`(?<=(?:from|import|require)\\s*\\(?\\s*)['"][^'"]*${escaped}[^'"]*['"]`),
  );
}

export const modulePathNotFound = defineRule({
  id: 'module-path-not-found',
  summary: 'A relative import or require() points at a file that does not exist',
  diagnose(error, ctx) {
    let target: string | undefined;
    let importer: string | undefined;
    let esm = false;
    let directoryImport = false;
    const message = error.message;

    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      const m = /^Cannot find module '(.+?)' imported from (.+?)\s*$/m.exec(message);
      if (!m?.[1]) return undefined;
      target = typeof error.props.url === 'string' ? toPath(error.props.url) : toPath(m[1]);
      importer = m[2] ? toPath(m[2]) : undefined;
      esm = true;
    } else if (error.code === 'ERR_UNSUPPORTED_DIR_IMPORT') {
      const m =
        /^Directory import '(.+?)' is not supported resolving ES modules imported from (.+?)\s*$/m.exec(
          message,
        );
      if (!m?.[1]) return undefined;
      target = toPath(m[1]);
      importer = m[2] ? toPath(m[2]) : undefined;
      esm = true;
      directoryImport = true;
    } else if (error.code === 'MODULE_NOT_FOUND' || /^Cannot find module '/.test(message)) {
      const m = /^Cannot find module '(.+?)'/.exec(message);
      const spec = m?.[1];
      const hasScheme =
        !!spec && /^[a-z][a-z0-9+.-]*:/i.test(spec) && !/^[a-zA-Z]:[\\/]/.test(spec);
      if (!spec || isBareSpecifier(spec) || hasScheme) return undefined;
      const stack = error.props.requireStack;
      importer =
        Array.isArray(stack) && typeof stack[0] === 'string'
          ? stack[0]
          : (/^- (.+)$/m.exec(message)?.[1] ?? ctx.userFrame(error)?.file);
      target = path.isAbsolute(spec)
        ? spec
        : path.resolve(importer ? path.dirname(importer) : ctx.cwd, spec);
    } else {
      return undefined;
    }
    if (!target) return undefined;

    const shownTarget = importer
      ? relativeSpecifier(importer, target)
      : displayPath(target, ctx.cwd);
    const location = importLine(ctx, importer, target) ?? locate(error, ctx);
    const docs = esm ? DOCS.mandatoryExtensions : DOCS.systemErrors;
    const candidates = candidatesFor(target, ctx);
    const candidate = candidates[0];

    if (candidate) {
      const spec = importer
        ? relativeSpecifier(importer, candidate)
        : displayPath(candidate, ctx.cwd);
      const isTs = TS_EXTS.has(path.extname(candidate));
      const importerIsTs = !!importer && TS_EXTS.has(path.extname(importer));
      if (isTs && (importerIsTs || !esm)) {
        const runsTs = importerIsTs;
        return finding({
          title: `${code(shownTarget)} doesn't exist — the file is ${code(spec)}`,
          explanation: runsTs
            ? `Node.js is running your TypeScript directly, but it doesn't rewrite import paths: ${code(shownTarget)} only exists after compiling. The source file is ${code(spec)}.`
            : `${esm ? 'ES modules' : '`require()`'} won't load ${code(path.extname(candidate))} files by guessing their extension, and only Node.js versions with type stripping can run them at all.`,
          fixes: fixes(
            runsTs
              ? `Import ${code(spec)} and enable ${code('"rewriteRelativeImportExtensions": true')} (or ${code('"allowImportingTsExtensions": true')} with ${code('noEmit')}) in tsconfig.json`
              : `Use the full filename: ${code(spec)}`,
            `Or run the code with ${code('tsx')}, which resolves TypeScript files for you`,
            'Or compile first and run the JavaScript output',
          ),
          location,
          docs: runsTs ? DOCS.typeStripping : docs,
        });
      }
      if (esm) {
        const isIndex =
          path.basename(candidate).startsWith('index.') && candidate.startsWith(target + path.sep);
        return finding({
          title:
            directoryImport || isIndex
              ? `Directory imports don't work in ES modules — import ${code(spec)}`
              : `${code(shownTarget)} is missing its file extension — use ${code(spec)}`,
          explanation: `ES modules don't guess file extensions or ${code('index')} files the way ${code('require()')} does, so the import must name the file exactly. The file exists as ${code(spec)}.`,
          fixes: fixes(
            `Change the import to ${code(spec)}`,
            importerIsTs
              ? `In TypeScript, write the ${code('.js')} extension in imports and set ${code('"module": "nodenext"')} so the compiler checks them`
              : `Writing TypeScript? Set ${code('"module": "nodenext"')} in tsconfig.json so the compiler flags missing extensions`,
          ),
          location,
          docs,
        });
      }
    }

    const wrongCase = caseMismatch(target, ctx);
    if (wrongCase) {
      const actual = importer
        ? relativeSpecifier(importer, wrongCase)
        : displayPath(wrongCase, ctx.cwd);
      return finding({
        title: `${code(shownTarget)} has the wrong letter case — the file is ${code(actual)}`,
        explanation: `macOS and Windows ignore filename case by default, so this may work on one machine and fail on Linux (CI, Docker, servers).`,
        fixes: [`Change the path to ${code(actual)} exactly`],
        location,
        docs,
      });
    }

    const similar = similarFile(target, ctx);
    const dirShown = displayPath(path.dirname(target), ctx.cwd) || '.';
    return finding({
      title: similar
        ? `${code(shownTarget)} doesn't exist — did you mean ${code(importer ? relativeSpecifier(importer, similar) : displayPath(similar, ctx.cwd))}?`
        : `${code(shownTarget)} doesn't exist`,
      explanation: `Nothing matching ${code(path.basename(target))} exists in ${code(dirShown)}${esm ? '' : ' (common extensions and index files included)'}. Relative imports resolve from the importing file${importer ? ` (${displayPath(importer, ctx.cwd)})` : ''}, not from the working directory.`,
      fixes: fixes(
        similar && `Check the spelling: ${code(path.basename(similar))}`,
        'If the file is generated (build output, codegen), run that step first',
      ),
      location,
      docs,
      confidence: similar ? 'high' : 'medium',
    });
  },
});

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function installedPackages(ctx: RuleContext, nodeModules: string | undefined): string[] {
  if (!nodeModules) return [];
  const names: string[] = [];
  for (const entry of ctx.readDir(nodeModules).slice(0, 3000)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      for (const sub of ctx.readDir(path.join(nodeModules, entry)).slice(0, 500))
        names.push(`${entry}/${sub}`);
    } else names.push(entry);
  }
  return names;
}

export const packageNotFound = defineRule({
  id: 'package-not-found',
  summary: 'An imported package is not installed (typo, missing install, missing peer dependency)',
  diagnose(error, ctx) {
    let spec: string | undefined;
    let importer: string | undefined;
    const esm = /^Cannot find package '(.+?)' imported from (.+?)\s*$/m.exec(error.message);
    if (esm?.[1]) {
      spec = esm[1];
      importer = esm[2] ? toPath(esm[2]) : undefined;
    } else if (
      error.code === 'MODULE_NOT_FOUND' ||
      error.code === 'ERR_MODULE_NOT_FOUND' ||
      /^Cannot find module '/.test(error.message)
    ) {
      const m = /^Cannot find module '(.+?)'/.exec(error.message);
      if (!m?.[1] || (!isBareSpecifier(m[1]) && !m[1].startsWith('node:'))) return undefined;
      spec = m[1];
      const stack = error.props.requireStack;
      importer =
        Array.isArray(stack) && typeof stack[0] === 'string'
          ? stack[0]
          : (/^- (.+)$/m.exec(error.message)?.[1] ?? ctx.userFrame(error)?.file);
    } else if (error.code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
      const m = /No such built-in module: (\S+)/.exec(error.message);
      const mod = m?.[1] ?? 'this module';
      return finding({
        title: `${code(mod)} isn't a built-in module in Node.js ${ctx.nodeVersion}`,
        explanation: `${code(mod)} was added in a newer Node.js version, needs a command-line flag, or the name is misspelled.`,
        fixes: [
          'Check the Node.js docs for the version that added it, then upgrade Node.js',
          'Check the spelling of the module name',
        ],
        location: locate(error, ctx),
        confidence: 'medium',
      });
    } else {
      return undefined;
    }
    if (!spec) return undefined;
    if (spec.startsWith('node:')) {
      return finding({
        title: `${code(spec)} isn't available in Node.js ${ctx.nodeVersion}`,
        explanation:
          'This built-in module was added in a newer Node.js version (or still needs a flag).',
        fixes: ['Upgrade Node.js, or check the docs for the flag that enables it'],
        location: locate(error, ctx),
        confidence: 'medium',
      });
    }

    const name = packageName(spec);
    const owner = importer ? packageFromPath(importer) : undefined;
    const projectDir = importer
      ? (importer.replace(/\\/g, '/').split('/node_modules/')[0] ?? path.dirname(importer))
      : ctx.cwd;
    const startDir = owner ? projectDir : importer ? path.dirname(importer) : ctx.cwd;
    const pkgPath = ctx.findUp('package.json', startDir);
    const pkg = (pkgPath ? ctx.readJson(pkgPath) : undefined) as
      Record<string, unknown> | undefined;
    const declared = new Map<string, string>();
    for (const field of DEP_FIELDS) {
      const deps = pkg?.[field];
      if (deps && typeof deps === 'object')
        for (const dep of Object.keys(deps)) declared.set(dep, field);
    }
    const pm = ctx.packageManager(startDir);
    const nodeModules = ctx.findUp('node_modules', startDir);
    const escapedSpec = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const location =
      (importer && !owner
        ? findLine(ctx, importer, new RegExp(`['"]${escapedSpec}['"]`))
        : undefined) ?? locate(error, ctx);
    const docs = DOCS.error(
      error.code === 'MODULE_NOT_FOUND' ? 'module_not_found' : 'err_module_not_found',
    );

    if (owner && owner.name !== name) {
      return finding({
        title: `${code(name)} is missing — ${code(owner.name)} needs it`,
        explanation: `${code(owner.name)} (in node_modules) imports ${code(name)}, but it isn't installed. That usually means an incomplete install, or a peer dependency you're expected to install yourself.`,
        fixes: [
          `If it's a peer dependency of ${code(owner.name)}, install it: ${code(installCommand(pm, name))}`,
          `Otherwise reinstall cleanly: delete ${code('node_modules')} and run ${code(installAllCommand(pm))}`,
        ],
        location,
        docs,
        confidence: 'medium',
      });
    }

    const field = declared.get(name);
    if (field) {
      const noModules = !nodeModules;
      return finding({
        title: `${code(name)} is in package.json but isn't installed`,
        explanation: noModules
          ? `${code(name)} is listed under ${code(field)}, but there's no ${code('node_modules')} folder at all — dependencies were never installed here (fresh clone? different folder?).`
          : `${code(name)} is listed under ${code(field)}, but ${code(`node_modules/${name}`)} doesn't exist. package.json changed since the last install (e.g. after pulling) or the install failed.`,
        fixes: [`Install dependencies: ${code(installAllCommand(pm))}`],
        location,
        docs,
      });
    }

    const installed = installedPackages(ctx, nodeModules);
    const suggestion = closest(name, new Set([...declared.keys(), ...installed]));
    const typesOnly = installed.includes(`@types/${name.replace(/^@/, '').replace('/', '__')}`);
    return finding({
      title: suggestion
        ? `${code(name)} isn't installed — did you mean ${code(suggestion)}?`
        : `${code(name)} isn't installed`,
      explanation:
        `Nothing named ${code(name)} is in node_modules, and it isn't listed in package.json.` +
        (typesOnly
          ? ` Only its type definitions (${code(`@types/${name}`)}) are installed — they don't include the code itself.`
          : ''),
      fixes: fixes(
        suggestion && `Fix the import to use ${code(suggestion)}`,
        `${suggestion ? 'Or install' : 'Install'} it: ${code(installCommand(pm, name))}`,
      ),
      location,
      docs,
    });
  },
});

function exportKeys(exportsField: unknown): string[] {
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) return ['.'];
  if (!exportsField || typeof exportsField !== 'object') return [];
  const keys = Object.keys(exportsField);
  return keys.some((k) => k.startsWith('.')) ? keys.filter((k) => k.startsWith('.')) : ['.'];
}

function rootExport(exportsField: unknown): unknown {
  if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField))
    return exportsField;
  const obj = exportsField as Record<string, unknown>;
  return Object.keys(obj).some((k) => k.startsWith('.')) ? obj['.'] : obj;
}

export const packageSubpathNotExported = defineRule({
  id: 'package-subpath-not-exported',
  summary:
    'A deep import or require() targets a path the package\'s "exports" field doesn\'t allow',
  diagnose(error, ctx) {
    if (
      error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' &&
      !/is not defined by "exports"|No "exports" main defined/.test(error.message)
    ) {
      return undefined;
    }
    const sub = /Package subpath '(.+?)' is not defined by "exports" in (.+?package\.json)/.exec(
      error.message,
    );
    const main = /No "exports" main defined in (.+?package\.json)/.exec(error.message);
    const pkgJsonPath = sub?.[2] ?? main?.[1];
    if (!pkgJsonPath) return undefined;
    const pkg = ctx.readJson(pkgJsonPath) as { name?: unknown; exports?: unknown } | undefined;
    const name =
      typeof pkg?.name === 'string'
        ? pkg.name
        : (packageFromPath(pkgJsonPath)?.name ?? 'the package');
    const keys = exportKeys(pkg?.exports).filter((k) => k !== './package.json');
    const location = locate(error, ctx);
    const docs = DOCS.error('ERR_PACKAGE_PATH_NOT_EXPORTED');
    const asImport = (subpath: string) =>
      subpath === '.' ? name : `${name}/${subpath.replace(/^\.\//, '')}`;

    if (sub?.[1]) {
      const requested = sub[1];
      const concrete = keys.filter((k) => !k.includes('*'));
      const withoutExt = requested.replace(/\.(?:[cm]?js|json)$/, '');
      const suggestion =
        concrete.find((k) => k === withoutExt) ??
        concrete.find((k) => path.posix.basename(k) === path.posix.basename(withoutExt)) ??
        closest(requested, concrete);
      const list = keys
        .slice(0, 8)
        .map((k) => code(asImport(k)))
        .join(', ');
      return finding({
        title: `${code(name)} doesn't export ${code(asImport(requested))}`,
        explanation: `The package's ${code('"exports"')} field lists the only paths you may import, and ${code(requested)} isn't one of them. Deep imports into a package's internal files are blocked${pkg ? '' : ' (its package.json could not be read)'}.`,
        fixes: fixes(
          suggestion && `Import ${code(asImport(suggestion))} instead`,
          keys.length > 0 && `Available entry points: ${list}${keys.length > 8 ? ', …' : ''}`,
          'Paths often move between major versions — check the package changelog or migration guide',
        ),
        location,
        docs,
      });
    }

    const root = rootExport(pkg?.exports);
    const conditions =
      root && typeof root === 'object' && !Array.isArray(root) ? Object.keys(root) : [];
    const importOnly =
      conditions.includes('import') &&
      !conditions.some((c) => ['require', 'default', 'node'].includes(c));
    const viaRequire = error.frames.some((f) =>
      /cjs[\\/]loader|resolveExports/.test(f.file + (f.fn ?? '')),
    );
    if (importOnly || viaRequire) {
      return finding({
        title: `${code(name)} is ESM-only and can't be loaded with ${code('require()')}`,
        explanation: `${code(name)}'s ${code('"exports"')} only defines an ${code('import')} entry point, so ${code(`require('${name}')`)} has nothing to load.`,
        fixes: [
          `Load it with a dynamic import: ${code(`const mod = await import('${name}')`)}`,
          `Or switch this file to ES modules (${code('"type": "module"')} or a ${code('.mjs')} extension) and use ${code('import')}`,
          `Or use the last major version of ${code(name)} that still supported CommonJS`,
        ],
        location,
        docs,
      });
    }
    return finding({
      title: `${code(name)} has no main entry point`,
      explanation: `${code(name)} only exports subpaths, so it can't be imported by its bare name.`,
      fixes: fixes(
        keys.length > 0 &&
          `Import one of: ${keys
            .slice(0, 8)
            .map((k) => code(asImport(k)))
            .join(', ')}`,
      ),
      location,
      docs,
      confidence: 'medium',
    });
  },
});

export const requireEsm = defineRule({
  id: 'require-esm',
  summary: 'require() was used on an ES module on a Node.js version (or tool) that cannot do that',
  diagnose(error, ctx) {
    if (error.code !== 'ERR_REQUIRE_ESM' && !/require\(\) of ES Module/.test(error.message))
      return undefined;
    const m = /require\(\) of ES Module (.+?) from (.+?) not supported/.exec(error.message);
    const mod = m?.[1];
    const pkg = mod ? packageFromPath(mod) : undefined;
    const label = pkg ? code(pkg.name) : mod ? code(displayPath(mod, ctx.cwd)) : 'This module';
    const importName = pkg?.name ?? (mod ? displayPath(mod, ctx.cwd) : 'the-module');
    const supported = requireEsmSupported(ctx);
    return finding({
      title: `${label} is an ES module and can't be loaded with ${code('require()')} here`,
      explanation: supported
        ? `Node.js ${ctx.nodeVersion} can ${code('require()')} ES modules, so this error comes from a tool that loads code its own way (Jest, ts-node, an older bundler or Electron) or from the ${code('--no-experimental-require-module')} flag.`
        : `Node.js ${ctx.nodeVersion} can't ${code('require()')} ES modules. Support arrived (unflagged) in Node.js 20.19, 22.12 and 23.0.`,
      fixes: fixes(
        !supported &&
          'Upgrade Node.js to 20.19+ or 22.12+ — require() of ES modules then works out of the box',
        `Use a dynamic import: ${code(`const mod = await import('${importName}')`)}`,
        `Or convert your project to ES modules (${code('"type": "module"')}) and use ${code('import')}`,
        pkg &&
          `Or pin the last version of ${code(pkg.name)} that shipped CommonJS (check its changelog)`,
      ),
      location: locate(error, ctx),
      docs: DOCS.requireEsm,
      confidence: supported ? 'medium' : 'high',
    });
  },
});

export const requireAsyncModule = defineRule({
  id: 'require-async-module',
  summary: 'require() of an ES module that uses top-level await',
  diagnose(error, ctx) {
    if (error.code !== 'ERR_REQUIRE_ASYNC_MODULE') return undefined;
    // Node.js 22–24: "Requiring <path>"; Node.js 26+: "Required module: <path>".
    const mod = /(?:Requiring|Required module:) (.+?)\s*$/m.exec(error.message)?.[1];
    const pkg = mod ? packageFromPath(mod) : undefined;
    const label = pkg ? code(pkg.name) : mod ? code(displayPath(mod, ctx.cwd)) : 'This module';
    return finding({
      title: `${label} uses top-level ${code('await')}, so it can't be ${code('require()')}d`,
      explanation: `${code('require()')} can load ES modules only if they finish synchronously. This module — or something it imports — uses top-level ${code('await')}.`,
      fixes: [
        `Use ${code('await import(...)')} instead of ${code('require(...)')}`,
        `Find the await: run with ${code('node --experimental-print-required-tla')}`,
        `If it's your module, move the top-level await into an exported async function`,
      ],
      location: locate(error, ctx),
      docs: DOCS.error('ERR_REQUIRE_ASYNC_MODULE'),
    });
  },
});

export const importInCommonJs = defineRule({
  id: 'import-in-commonjs',
  summary: 'ES module syntax (import/export) in a file Node.js loads as CommonJS',
  diagnose(error, ctx) {
    if (error.name !== 'SyntaxError') return undefined;
    if (
      !/^Cannot use import statement outside a module|^Unexpected token 'export'/.test(
        error.message,
      )
    )
      return undefined;
    const file = error.sourceHint?.file ?? ctx.userFrame(error)?.file;
    const jest = error.frames.some((f) => /jest-runtime|jest-runner/.test(f.file));
    const location = locate(error, ctx);
    const dep = file ? packageFromPath(file) : undefined;
    if (dep) {
      if (jest) {
        return finding({
          title: `Jest can't load ${code(dep.name)} because it ships ES modules`,
          explanation: `Jest runs code as CommonJS and, by default, doesn't transform files in node_modules — so an ESM-only dependency fails to parse.`,
          fixes: [
            `Let Jest transform it:\ntransformIgnorePatterns: ['/node_modules/(?!(${dep.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})/)']`,
            `Or run Jest with ES module support (${code('NODE_OPTIONS=--experimental-vm-modules')})`,
            'Or use Vitest, which handles ESM dependencies natively',
          ],
          location,
          docs: DOCS.moduleSystem,
        });
      }
      return finding({
        title: `${code(dep.name)} ships ES modules but is being loaded as CommonJS`,
        explanation: `A dependency uses ${code('import')}/${code('export')}, but it was loaded through ${code('require()')} or a tool that only understands CommonJS.`,
        fixes: [
          `Load it with ${code(`await import('${dep.name}')`)}, or convert your code to ES modules`,
          'Upgrade Node.js to 20.19+ / 22.12+, where require() can load ES modules',
        ],
        location,
        docs: DOCS.moduleSystem,
        confidence: 'medium',
      });
    }
    if (!file) {
      return finding({
        title: `${code('import')} used in a file that Node.js loads as CommonJS`,
        explanation: `Node.js picks the module system per file: ${code('.mjs')} is ESM, ${code('.cjs')} is CommonJS, and ${code('.js')} follows the nearest package.json ${code('"type"')} field.`,
        fixes: [
          `Add ${code('"type": "module"')} to your package.json, or rename the file to ${code('.mjs')}`,
          `Or keep CommonJS and use ${code('require()')}`,
        ],
        location,
        docs: DOCS.moduleSystem,
        confidence: 'medium',
      });
    }
    const ext = path.extname(file);
    const shown = displayPath(file, ctx.cwd);
    if (ext === '.cjs' || ext === '.cts') {
      return finding({
        title: `${code(path.basename(file))} is a ${code(ext)} file, so it can't use ${code('import')}`,
        explanation: `Files ending in ${code(ext)} are always CommonJS, whatever package.json says.`,
        fixes: [
          `Rename it to ${code(ext === '.cjs' ? '.mjs' : '.mts')}`,
          `Or use ${code('require()')} instead of ${code('import')}`,
        ],
        location,
        docs: DOCS.moduleSystem,
      });
    }
    const pkgJson = ctx.findUp('package.json', path.dirname(file));
    const type = (pkgJson ? (ctx.readJson(pkgJson) as { type?: unknown } | undefined) : undefined)
      ?.type;
    const pkgShown = pkgJson ? displayPath(pkgJson, ctx.cwd) : 'package.json';
    return finding({
      title: `${code(shown)} uses ${code('import')}, but Node.js loads it as CommonJS`,
      explanation:
        `Node.js picks the module system per file: ${code('.mjs')} is ESM, ${code('.cjs')} is CommonJS, and ${code('.js')} follows the nearest package.json ${code('"type"')} field. ` +
        (pkgJson
          ? typeof type === 'string'
            ? `${code(pkgShown)} sets ${code(`"type": "${type}"`)}, so this file is CommonJS.`
            : `${code(pkgShown)} has no ${code('"type"')} field.`
          : 'No package.json was found above this file.') +
        (jest ? ' Jest also runs tests as CommonJS unless configured otherwise.' : ''),
      fixes: fixes(
        `Add ${code('"type": "module"')} to ${code(pkgShown)}`,
        `Or rename the file to ${code(ext === '.ts' ? '.mts' : '.mjs')}`,
        `Or keep CommonJS and use ${code('require()')}`,
        jest && 'For Jest, configure a transform (babel-jest/ts-jest) or its ES module support',
      ),
      location,
      docs: DOCS.moduleSystem,
    });
  },
});

export const commonJsInEsm = defineRule({
  id: 'commonjs-in-esm',
  summary: 'require, module, exports, __dirname or __filename used in an ES module',
  diagnose(error, ctx) {
    if (error.name !== 'ReferenceError') return undefined;
    const m =
      /^(require|module|exports|__dirname|__filename) is not defined( in ES module scope)?/.exec(
        error.message,
      );
    if (!m?.[1]) return undefined;
    const name = m[1];
    const esmScope = !!m[2];
    const hasMeta =
      ctx.nodeAtLeast(21, 2) ||
      (parseVersion(ctx.nodeVersion)[0] === 20 && ctx.nodeAtLeast(20, 11));
    const keepCjs = `Or keep CommonJS: rename the file to ${code('.cjs')}`;
    let fixList: string[];
    if (name === '__dirname' || name === '__filename') {
      const meta = name === '__dirname' ? 'import.meta.dirname' : 'import.meta.filename';
      fixList = hasMeta
        ? [`Use ${code(meta)}`, keepCjs]
        : [
            `Rebuild it from ${code('import.meta.url')}:\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst __filename = fileURLToPath(import.meta.url);\nconst __dirname = path.dirname(__filename);`,
            `On Node.js 20.11+ you can use ${code(meta)} directly`,
            keepCjs,
          ];
    } else if (name === 'require') {
      fixList = [
        `Use ${code('import')}: ${code("import express from 'express'")}`,
        `For JSON files: ${code("import data from './data.json' with { type: 'json' }")}`,
        `If you really need require():\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);`,
        keepCjs,
      ];
    } else {
      fixList = [
        `Replace ${code('module.exports = x')} with ${code('export default x')}, and ${code('exports.foo = …')} with ${code('export const foo = …')}`,
        `${keepCjs} (or remove ${code('"type": "module"')} from package.json)`,
      ];
    }
    return finding({
      title: `${code(name)} doesn't exist in ES modules`,
      explanation: esmScope
        ? `This file runs as an ES module, where the CommonJS globals ${code('require')}, ${code('module')}, ${code('exports')}, ${code('__dirname')} and ${code('__filename')} don't exist.`
        : `This code expects CommonJS but runs somewhere without it: an ES module, a browser bundle, or an edge runtime.`,
      fixes: fixList,
      location: locate(error, ctx),
      docs: name.startsWith('__') ? DOCS.noDirname : DOCS.noRequire,
      confidence: esmScope ? 'high' : 'medium',
    });
  },
});

const ASSET_EXTS = new Set([
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.styl',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.html',
  '.vue',
  '.svelte',
  '.astro',
  '.md',
  '.mdx',
  '.graphql',
  '.gql',
  '.yaml',
  '.yml',
  '.txt',
  '.csv',
]);

export const unknownFileExtension = defineRule({
  id: 'unknown-file-extension',
  summary: 'Node.js was asked to run a .ts, .tsx, .jsx, .css or other file it cannot execute',
  diagnose(error, ctx) {
    if (error.code !== 'ERR_UNKNOWN_FILE_EXTENSION') return undefined;
    const m = /Unknown file extension "(\.[^"]+)" for (.+?)\s*$/m.exec(error.message);
    const ext = m?.[1];
    const file = m?.[2] ? toPath(m[2]) : undefined;
    if (!ext) return undefined;
    const shown = file ? displayPath(file, ctx.cwd) : `the ${ext} file`;
    const docs = DOCS.error('ERR_UNKNOWN_FILE_EXTENSION');
    if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
      if (!typeStrippingByDefault(ctx)) {
        return finding({
          title: `Node.js ${ctx.nodeVersion} can't run TypeScript files directly`,
          explanation:
            'Node.js runs `.ts` files natively from version 22.18 / 23.6 (type stripping). Older versions need a TypeScript runner or a build step.',
          fixes: [
            `Run it with tsx: ${code(`npx tsx ${shown}`)}`,
            'Or upgrade Node.js to 22.18+ (type stripping is on by default)',
            `Or compile with ${code('tsc')} and run the JavaScript output`,
          ],
          docs: DOCS.typeStripping,
        });
      }
      return finding({
        title: 'Type stripping is turned off',
        explanation: `Node.js ${ctx.nodeVersion} can run TypeScript natively, but it's disabled here — e.g. ${code('--no-strip-types')} in ${code('NODE_OPTIONS')} — or the file is loaded by a tool with its own loader.`,
        fixes: [
          `Check ${code('NODE_OPTIONS')} and your start command for ${code('--no-strip-types')}`,
          `Or run the file with ${code('tsx')}`,
        ],
        docs: DOCS.typeStripping,
        confidence: 'medium',
      });
    }
    if (ext === '.tsx' || ext === '.jsx') {
      return finding({
        title: `Node.js can't run ${code(ext)} files`,
        explanation: `JSX has to be compiled to JavaScript first; Node.js's built-in type stripping doesn't handle JSX.`,
        fixes: [
          `Run it with tsx: ${code(`npx tsx ${shown}`)}`,
          'Or compile it with your bundler (esbuild, Vite, tsup, Next.js)',
          'If this is a front-end component, check why server or test code imports it',
        ],
        docs,
      });
    }
    if (ASSET_EXTS.has(ext)) {
      return finding({
        title: `Node.js can't import ${code(ext)} files`,
        explanation: `Importing ${code(ext)} files works only through a bundler or framework (Vite, webpack, Next.js…). Plain Node.js loads JavaScript, JSON and (on recent versions) TypeScript.`,
        fixes: [
          'Run this code through your bundler/framework instead of plain Node.js',
          `In tests, mock or ignore asset imports (e.g. Jest ${code('moduleNameMapper')}, Vitest ${code('css')} options)`,
          `To read the file at runtime, use ${code(`fs.readFileSync(new URL('./file${ext}', import.meta.url))`)}`,
        ],
        docs,
      });
    }
    return undefined;
  },
});

export const typescriptInNodeModules = defineRule({
  id: 'typescript-in-node-modules',
  summary: 'A dependency (or linked workspace package) ships TypeScript source',
  diagnose(error, ctx) {
    if (error.code !== 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING') return undefined;
    const raw = /for "(.+?)"/.exec(error.message)?.[1];
    const file = raw ? toPath(raw) : undefined;
    const pkg = file ? packageFromPath(file) : undefined;
    const real = pkg ? ctx.realpath(pkg.root) : undefined;
    const workspace = !!real && !/[\\/]node_modules[\\/]/.test(real);
    const label = pkg ? code(pkg.name) : 'A dependency';
    return finding({
      title: `${label} ships TypeScript source, which Node.js won't run from node_modules`,
      explanation:
        'Node.js strips types only from your own files; everything under node_modules must be JavaScript.' +
        (workspace
          ? ` ${label} is a workspace package linked into node_modules, and its entry point is a .ts file.`
          : ''),
      fixes: workspace
        ? [
            `Build ${label} and point its ${code('"exports"')} at the compiled JavaScript`,
            `Or run the app with ${code('tsx')}, which compiles TypeScript in dependencies too`,
          ]
        : [
            `Run the app with ${code('tsx')} or a bundler that compiles dependencies`,
            'Or ask the maintainers to publish compiled JavaScript',
          ],
      docs: DOCS.error('ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING'),
    });
  },
});

export const typescriptSyntaxNotErasable = defineRule({
  id: 'typescript-syntax-not-erasable',
  summary:
    'TypeScript features (enum, namespace, parameter properties) that type stripping cannot run',
  diagnose(error, ctx) {
    if (
      error.code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' &&
      !/is not supported in strip-only mode/.test(error.message)
    ) {
      return undefined;
    }
    const feature =
      /TypeScript (.+?) is not supported in strip-only mode/.exec(error.message)?.[1] ?? 'syntax';
    return finding({
      title: `Node.js can't run TypeScript ${feature} syntax without compiling`,
      explanation: `Node.js runs TypeScript by erasing types. It doesn't compile features that generate JavaScript, such as ${code('enum')}, runtime ${code('namespace')}s and constructor parameter properties.`,
      fixes: fixes(
        /enum/.test(feature) &&
          `Replace the enum with a const object:\nexport const Color = { Red: 'red', Blue: 'blue' } as const;\nexport type Color = (typeof Color)[keyof typeof Color];`,
        `Enable ${code('"erasableSyntaxOnly": true')} in tsconfig.json so the editor flags these features`,
        `Or run the file with ${code('tsx')}, which compiles everything`,
      ),
      location: locate(error, ctx),
      docs: DOCS.typescriptFeatures,
    });
  },
});

export const jsonImportAttribute = defineRule({
  id: 'json-import-attribute',
  summary: "JSON imported without `with { type: 'json' }`, or with the removed `assert` syntax",
  diagnose(error, ctx) {
    if (
      error.code === 'ERR_IMPORT_ATTRIBUTE_MISSING' ||
      error.code === 'ERR_IMPORT_ASSERTION_TYPE_MISSING'
    ) {
      const raw = /Module "(.+?)" needs an import (?:attribute|assertion)/.exec(error.message)?.[1];
      const base = raw ? path.basename(toPath(raw)) : 'data.json';
      return finding({
        title: `JSON imports need ${code("with { type: 'json' }")}`,
        explanation:
          'ES modules import JSON only when the import says so explicitly — a safety measure so a .json URL can never execute code.',
        fixes: [
          `${code(`import data from './${base}' with { type: 'json' };`)}`,
          `Or read it at runtime: ${code(`JSON.parse(fs.readFileSync(new URL('./${base}', import.meta.url), 'utf8'))`)}`,
        ],
        docs: DOCS.importAttributes,
      });
    }
    if (error.name === 'SyntaxError' && /Unexpected identifier 'assert'/.test(error.message)) {
      const snippet = error.sourceHint?.snippet ?? '';
      const location = locate(error, ctx);
      const line = location ? (ctx.sourceLine(location.file, location.line) ?? snippet) : snippet;
      if (line && !/\bassert\s*\{/.test(line)) return undefined;
      return finding({
        confidence: line ? 'high' : 'medium',
        title: `${code('assert { type: ... }')} was replaced by ${code('with { type: ... }')}`,
        explanation:
          'Import assertions were removed in favor of import attributes. Node.js 22 and newer only accept the `with` keyword.',
        fixes: [
          `Replace ${code('assert')} with ${code('with')}: ${code("import data from './data.json' with { type: 'json' };")}`,
        ],
        location,
        docs: DOCS.importAttributes,
      });
    }
    return undefined;
  },
});

function rebuildCommand(pm: string, pkg: string): string {
  if (pm === 'npm' || pm === 'pnpm') return `${pm} rebuild ${pkg}`;
  return `${pm} install --force`;
}

export const nativeModuleMismatch = defineRule({
  id: 'native-module-mismatch',
  summary: 'A native add-on (.node) was built for another Node.js version, OS or CPU architecture',
  diagnose(error, ctx) {
    const message = error.message.replace(/\s+/g, ' ');
    const native =
      error.code === 'ERR_DLOPEN_FAILED' ||
      /NODE_MODULE_VERSION|invalid ELF header|wrong ELF class|incompatible architecture|not a valid Win32 application/.test(
        message,
      );
    if (!native) return undefined;
    const modPath =
      /The module '(.+?)'/.exec(message)?.[1] ??
      /dlopen\((.+?),/.exec(message)?.[1] ??
      /(\/\S+\.node)\b/.exec(message)?.[1];
    const pkg = modPath ? packageFromPath(modPath) : undefined;
    const label = pkg ? code(pkg.name) : 'A native module';
    const pm = ctx.packageManager();
    const pkgName = pkg?.name ?? '';
    const docs = DOCS.error('ERR_DLOPEN_FAILED');
    const location = locate(error, ctx);

    const abi =
      /NODE_MODULE_VERSION (\d+)\. This version of Node\.js requires NODE_MODULE_VERSION (\d+)/.exec(
        message,
      );
    if (abi?.[1] && abi[2]) {
      const built = Number(abi[1]);
      const builtNode = nodeMajorForAbi(built);
      const running = parseVersion(ctx.nodeVersion)[0];
      return finding({
        title: `${label} was compiled for ${builtNode ? `Node.js ${builtNode}` : `NODE_MODULE_VERSION ${built}`}, but this is Node.js ${running}`,
        explanation:
          'Native add-ons (.node files) are compiled for one Node.js ABI version. This one was built for a different version — usually because Node.js was switched (nvm, fnm, Volta, a system update) after installing.' +
          (builtNode
            ? ''
            : ' If this is an Electron app, the module must be rebuilt for Electron instead.'),
        fixes: fixes(
          `Rebuild it: ${code(rebuildCommand(pm, pkgName).trim())}`,
          `Or reinstall: delete ${code('node_modules')} and run ${code(installAllCommand(pm))}`,
          'Pin the Node.js version for the project (`.nvmrc`, the `engines` field) so installs and runs match',
          !builtNode && `For Electron, use ${code('@electron/rebuild')}`,
        ),
        location,
        docs,
      });
    }
    if (
      /invalid ELF header|not a valid Win32 application|not a mach-o file|slice is not valid mach-o/i.test(
        message,
      )
    ) {
      return finding({
        title: `${label} was compiled for a different operating system`,
        explanation:
          'The native binary in node_modules was built on another OS — typically node_modules installed on macOS or Windows and then copied into a Linux container or server.',
        fixes: [
          'Install dependencies on the OS where the app runs (e.g. `RUN npm ci` inside the Dockerfile)',
          `Add ${code('node_modules')} to ${code('.dockerignore')} so the host copy isn't copied into the image`,
          `Reinstall locally: delete ${code('node_modules')} and run ${code(installAllCommand(pm))}`,
        ],
        location,
        docs,
      });
    }
    if (
      /incompatible architecture|wrong ELF class|mach-o file, but is an incompatible/i.test(message)
    ) {
      return finding({
        title: `${label} was compiled for a different CPU architecture`,
        explanation: `The native binary doesn't match this process's architecture (${code(process.arch)}) — common on Apple Silicon when Node.js or the terminal runs under Rosetta, or with Docker ${code('--platform')} mismatches.`,
        fixes: [
          `Check ${code('node -p process.arch')} and reinstall dependencies with the same architecture you run`,
          'On Apple Silicon, make sure Node.js and your terminal are both native arm64',
          pkgName
            ? `Rebuild: ${code(rebuildCommand(pm, pkgName))}`
            : `Reinstall: ${code(installAllCommand(pm))}`,
        ],
        location,
        docs,
      });
    }
    return undefined;
  },
});

export const opensslLegacy = defineRule({
  id: 'openssl-legacy',
  summary: 'Old webpack-based tooling uses hashing that OpenSSL 3 (Node.js 17+) disables',
  diagnose(error, ctx) {
    if (
      error.code !== 'ERR_OSSL_EVP_UNSUPPORTED' &&
      !/digital envelope routines::unsupported/.test(error.message)
    )
      return undefined;
    const webpack = error.frames.some((f) => /[\\/]webpack[\\/]|react-scripts/.test(f.file));
    return finding({
      title: 'Old build tooling uses a hash algorithm OpenSSL 3 disables',
      explanation:
        'Node.js 17+ ships OpenSSL 3, which disables legacy algorithms such as MD4. webpack 4 — used by react-scripts 4 and older Vue/Angular CLIs — hashes files with MD4.',
      fixes: [
        'Upgrade the tooling (webpack 5 / react-scripts 5 or newer)',
        `Temporary workaround: ${code('NODE_OPTIONS=--openssl-legacy-provider')}`,
      ],
      location: locate(error, ctx),
      docs: DOCS.opensslLegacy,
      confidence: webpack ? 'high' : 'medium',
    });
  },
});

export const moduleRules: Rule[] = [
  modulePathNotFound,
  packageNotFound,
  packageSubpathNotExported,
  requireEsm,
  requireAsyncModule,
  importInCommonJs,
  commonJsInEsm,
  unknownFileExtension,
  typescriptInNodeModules,
  typescriptSyntaxNotErasable,
  jsonImportAttribute,
  nativeModuleMismatch,
  opensslLegacy,
];
