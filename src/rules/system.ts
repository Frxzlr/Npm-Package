import path from 'node:path';
import type { Rule } from '../types.js';
import { closest, code, displayPath, numberProp, stringProp } from '../util.js';
import { DOCS, defineRule, finding, fixes, locate } from './helpers.js';

const WRITE_SYSCALLS = new Set([
  'open',
  'mkdir',
  'rename',
  'copyfile',
  'symlink',
  'link',
  'writeFile',
]);

export const spawnNotFound = defineRule({
  id: 'spawn-not-found',
  summary: 'child_process could not start a command (not on PATH, bad cwd, Windows .cmd files)',
  diagnose(error, ctx) {
    const syscall = stringProp(error.props.syscall) ?? '';
    const spawnMsg = /^spawn (\S+) (ENOENT|EINVAL)$/.exec(error.message);
    if (!syscall.startsWith('spawn') && !spawnMsg) return undefined;
    const cmd = stringProp(error.props.path) ?? spawnMsg?.[1] ?? syscall.replace(/^spawn\s*/, '');
    const win = ctx.platform === 'win32';
    const location = locate(error, ctx);
    if (error.code === 'EINVAL' || spawnMsg?.[2] === 'EINVAL') {
      if (!win && !/\.(?:cmd|bat)$/i.test(cmd)) return undefined;
      return finding({
        title: 'Windows refuses to spawn .cmd/.bat files without a shell',
        explanation:
          'Since the April 2024 security releases (CVE-2024-27980), Node.js on Windows throws EINVAL when spawning batch files (such as `npm.cmd`) without `shell: true`.',
        fixes: [
          `Pass ${code('{ shell: true }')} (and quote arguments carefully)`,
          `Or run the underlying script directly with ${code('process.execPath')}`,
        ],
        location,
        docs: DOCS.systemErrors,
      });
    }
    if (error.code !== 'ENOENT' && spawnMsg?.[2] !== 'ENOENT') return undefined;
    return finding({
      title: `Command ${code(cmd)} was not found`,
      explanation: `Node.js couldn't start ${code(cmd)}: it isn't on this process's PATH. (spawn also reports ENOENT when its ${code('cwd')} option points to a folder that doesn't exist.)`,
      fixes: fixes(
        `Check that it's installed and on PATH: ${code(win ? `where ${cmd}` : `which ${cmd}`)}`,
        win &&
          !/\.(?:cmd|bat|exe)$/i.test(cmd) &&
          `On Windows, tools like ${code('npm')} and ${code('npx')} are .cmd scripts — spawn them with ${code('shell: true')}`,
        `If you pass a ${code('cwd')} option, make sure that folder exists`,
        `CLIs installed in the project live in ${code('node_modules/.bin')} — use ${code(`npx ${cmd}`)} or an npm script`,
      ),
      location,
      docs: DOCS.systemErrors,
    });
  },
});

export const fileNotFound = defineRule({
  id: 'file-not-found',
  summary:
    'A file path does not exist — checks cwd vs. script folder, letter case, typos and missing folders',
  diagnose(error, ctx) {
    if (error.code !== 'ENOENT' && !/^ENOENT: no such file or directory/.test(error.message))
      return undefined;
    const syscall =
      stringProp(error.props.syscall) ??
      /ENOENT: no such file or directory, (\w+)/.exec(error.message)?.[1];
    if (syscall?.startsWith('spawn')) return undefined;
    const p = stringProp(error.props.path) ?? /, \w+ '(.+?)'/.exec(error.message)?.[1];
    if (!p) return undefined;
    const abs = path.resolve(ctx.cwd, p);
    const relative = !path.isAbsolute(p);
    const frame = ctx.userFrame(error) ?? ctx.userFrame(ctx.root);
    const location = locate(error, ctx);
    const docs = DOCS.systemErrors;
    const shownAbs = displayPath(abs, ctx.cwd);

    if (relative && frame) {
      const nextToCode = path.resolve(path.dirname(frame.file), p);
      if (nextToCode !== abs && ctx.exists(nextToCode)) {
        const codeDir = path.dirname(frame.file);
        return finding({
          title: `${code(p)} is resolved from the working directory, not from your file`,
          explanation: `Relative paths in ${code('fs')} calls resolve against ${code('process.cwd()')} (${ctx.cwd}), not against the file containing the code. The file exists next to your code: ${displayPath(nextToCode, ctx.cwd)}.`,
          fixes: [
            `Build the path from the module's own location:\nconst file = path.join(import.meta.dirname, '${p}'); // ES modules (Node.js 20.11+)\nconst file = path.join(__dirname, '${p}');            // CommonJS`,
            `Or start the program from ${code(displayPath(codeDir, ctx.cwd) || '.')}`,
          ],
          location,
          docs,
        });
      }
    }

    const dir = path.dirname(abs);
    const base = path.basename(abs);
    const entries = ctx.readDir(dir);
    const sameCase = entries.find((e) => e !== base && e.toLowerCase() === base.toLowerCase());
    if (sameCase) {
      return finding({
        title: `${code(base)} has different letter case on disk: ${code(sameCase)}`,
        explanation:
          "macOS and Windows ignore filename case by default; Linux (CI, Docker, servers) doesn't.",
        fixes: [`Use the exact name: ${code(sameCase)}`],
        location,
        docs,
      });
    }

    if (base === '.env') {
      const example = ['.env.example', '.env.sample', '.env.template'].find((e) =>
        entries.includes(e),
      );
      return finding({
        title: `There's no ${code('.env')} file in ${code(displayPath(dir, ctx.cwd) || '.')}`,
        explanation: `The app expects a ${code('.env')} file with local configuration. It's usually not committed to git.`,
        fixes: fixes(
          example
            ? `Create it from the template: ${code(`cp ${example} .env`)}, then fill in the values`
            : `Create ${code('.env')} with the variables the app needs`,
          'Or start the app from the folder that contains the .env file',
        ),
        location,
        docs,
      });
    }

    if (!ctx.isDirectory(dir)) {
      return finding({
        title: `The folder ${code(displayPath(dir, ctx.cwd))} doesn't exist`,
        explanation: `${code(base)} can't be ${syscall && WRITE_SYSCALLS.has(syscall) ? 'created' : 'found'} because its parent folder is missing. Node.js doesn't create folders automatically.`,
        fixes: fixes(
          syscall &&
            WRITE_SYSCALLS.has(syscall) &&
            `Create it first: ${code('fs.mkdirSync(path.dirname(file), { recursive: true })')}`,
          relative &&
            `The path is relative to the working directory (${ctx.cwd}) — check you started the program from the right folder`,
          'Check the path for typos',
        ),
        location,
        docs,
      });
    }

    const stems = new Map(entries.map((e) => [e, e] as const));
    const similar = closest(base, stems.keys());
    if (similar) {
      return finding({
        title: `${code(shownAbs)} doesn't exist — did you mean ${code(similar)}?`,
        explanation: `There's no ${code(base)} in ${code(displayPath(dir, ctx.cwd) || '.')}, but there is ${code(similar)}.`,
        fixes: [`Fix the filename: ${code(similar)}`],
        location,
        docs,
      });
    }

    return finding({
      title: `No such file or directory: ${code(shownAbs)}`,
      explanation: `${code(p)}${relative ? ` (resolved from the working directory ${ctx.cwd})` : ''} doesn't exist.`,
      fixes: fixes(
        'Check the path and spelling',
        relative &&
          `Relative paths depend on where the process starts — build paths from ${code('import.meta.dirname')} / ${code('__dirname')} instead`,
        'If the file is generated (build output, uploads, codegen), make sure that step ran first',
      ),
      location,
      docs,
      confidence: 'medium',
    });
  },
});

const GLOBAL_PREFIX =
  /[\\/](?:usr[\\/](?:local[\\/])?lib|opt[\\/]homebrew[\\/]lib)[\\/]node_modules\b/;

export const permissionDenied = defineRule({
  id: 'permission-denied',
  summary: 'EACCES/EPERM: privileged ports, global npm installs, locked files on Windows',
  diagnose(error, ctx) {
    if (
      error.code !== 'EACCES' &&
      error.code !== 'EPERM' &&
      !/^(?:listen )?(?:EACCES|EPERM)\b/.test(error.message)
    )
      return undefined;
    const syscall =
      stringProp(error.props.syscall) ??
      /(?:EACCES|EPERM): [^,]+, (\w+)/.exec(error.message)?.[1] ??
      (/^listen /.test(error.message) ? 'listen' : undefined);
    const port = numberProp(error.props.port) ?? numberProp(/:(\d+)\s*$/.exec(error.message)?.[1]);
    const p =
      stringProp(error.props.path) ??
      stringProp(error.props.dest) ??
      /, \w+ '(.+?)'/.exec(error.message)?.[1];
    const location = locate(error, ctx);
    const docs = DOCS.systemErrors;

    if (syscall === 'listen' && port !== undefined && port < 1024) {
      return finding({
        title: `Port ${port} needs administrator privileges`,
        explanation:
          "Ports below 1024 are privileged on Linux, so normal users can't listen on them.",
        fixes: [
          'Listen on a port ≥ 1024 (e.g. 3000 or 8080) and put a reverse proxy (nginx, Caddy) in front for 80/443',
          `On Linux you can grant only this capability: ${code('sudo setcap cap_net_bind_service=+ep "$(which node)"')}`,
        ],
        location,
        docs,
      });
    }
    if (p && GLOBAL_PREFIX.test(p)) {
      return finding({
        title: "npm can't write to the global packages folder",
        explanation: `A global install (${code('npm install -g')}) tried to write to ${code(p)}, a system folder owned by root.`,
        fixes: [
          'Use a Node.js version manager (nvm, fnm, Volta) — global packages then live in your home folder',
          `Or point npm to a folder you own: ${code('npm config set prefix ~/.npm-global')} and add ${code('~/.npm-global/bin')} to PATH`,
          `Avoid ${code('sudo npm install -g')} — it creates root-owned files that cause more errors later`,
        ],
        location,
        docs,
      });
    }
    if (ctx.platform === 'win32' && error.code === 'EPERM' && p) {
      return finding({
        title: `Windows blocked access to ${code(displayPath(p, ctx.cwd))}`,
        explanation:
          'On Windows, EPERM usually means another process has the file open: an editor, a running dev server, antivirus, or a cloud-sync client like OneDrive.',
        fixes: [
          'Close programs that may hold the file (dev servers, editors, terminals in that folder) and retry',
          'Exclude the project folder from antivirus scanning and cloud sync',
        ],
        location,
        docs,
        confidence: 'medium',
      });
    }
    if (!p) return undefined;
    return finding({
      title: `Permission denied: ${code(displayPath(p, ctx.cwd))}`,
      explanation: `This process isn't allowed to ${syscall ?? 'access'} that path.`,
      fixes: [
        `Check ownership and permissions: ${code(`ls -la "${p}"`)}`,
        `If something ran with sudo earlier, files may now be owned by root — fix with ${code('sudo chown -R "$(whoami)" <folder>')}`,
        "Don't run Node.js apps as root to work around this",
      ],
      location,
      docs,
      confidence: 'medium',
    });
  },
});

export const tooManyOpenFiles = defineRule({
  id: 'too-many-open-files',
  summary: 'EMFILE/ENFILE: the process hit the open-file limit',
  diagnose(error, ctx) {
    if (error.code !== 'EMFILE' && error.code !== 'ENFILE' && !/\bE[MN]FILE\b/.test(error.message))
      return undefined;
    return finding({
      title: 'Too many open files',
      explanation: `The process hit the operating system's limit on open files (${code('ulimit -n')}). Usually something opens thousands of files at once, watches a huge folder, or never closes its file handles.`,
      fixes: [
        `Limit concurrency instead of ${code('Promise.all')} over thousands of files (e.g. ${code('p-limit')})`,
        `Make sure streams and file handles are closed (${code('await handle.close()')}, ${code('stream.destroy()')})`,
        `Exclude ${code('node_modules')} and build folders from file watchers`,
        ctx.platform === 'win32'
          ? 'Close other programs that hold many files open'
          : `As a stopgap, raise the limit: ${code('ulimit -n 10240')}`,
      ],
      location: locate(error, ctx),
      docs: DOCS.systemErrors,
      confidence: 'medium',
    });
  },
});

export const outOfMemory = defineRule({
  id: 'out-of-memory',
  summary: 'JavaScript heap out of memory, strings too long, failed buffer allocations',
  diagnose(error, ctx) {
    const heap =
      (error.name === 'FatalError' &&
        /heap out of memory|Reached heap limit|Ineffective mark-compacts/i.test(error.message)) ||
      /JavaScript heap out of memory/.test(error.message);
    if (heap) {
      return finding({
        title: 'Node.js ran out of memory (JavaScript heap limit reached)',
        explanation:
          'The program used more memory than the heap allows: it holds too much data at once (large files or arrays), leaks memory over time, or is a build tool (webpack, tsc, Next.js) working on a big project.',
        fixes: [
          `Raise the limit (in MiB): ${code('NODE_OPTIONS=--max-old-space-size=4096')}`,
          `Find what uses the memory: ${code('node --heapsnapshot-near-heap-limit=1 app.js')}, then open the snapshot in Chrome DevTools → Memory`,
          'Process large data in chunks or streams instead of loading it all at once',
        ],
        docs: DOCS.maxOldSpace,
      });
    }
    if (error.name === 'RangeError' && /^Invalid string length$/.test(error.message)) {
      return finding({
        title: "A string grew past JavaScript's maximum length",
        explanation: `Strings have a hard size limit (hundreds of MB). This usually means reading a huge file into one string or calling ${code('JSON.stringify')} on a very large object.`,
        fixes: [
          `Stream the data instead (${code('fs.createReadStream')}, streaming JSON writers)`,
          `Process the file in chunks or line by line (${code('readline')})`,
        ],
        location: locate(error, ctx),
      });
    }
    if (error.name === 'RangeError' && /Array buffer allocation failed/.test(error.message)) {
      return finding({
        title: "Couldn't allocate memory for a Buffer/ArrayBuffer",
        explanation: 'The process asked for a buffer larger than the memory available to it.',
        fixes: [
          'Read or download large data in chunks/streams',
          'Check the requested size — a corrupted length header can request gigabytes',
        ],
        location: locate(error, ctx),
        confidence: 'medium',
      });
    }
    return undefined;
  },
});

export const unsettledTopLevelAwait = defineRule({
  id: 'unsettled-top-level-await',
  summary: 'A top-level await never settled, so Node.js exited with code 13',
  diagnose(error, ctx) {
    if (!/Detected unsettled top-level await/.test(error.message)) return undefined;
    return finding({
      title: `Top-level ${code('await')} never finished`,
      explanation:
        'The module awaited a promise that never resolved or rejected. Once nothing else kept Node.js busy, it exited with code 13 instead of waiting forever.',
      fixes: [
        `Make sure the awaited promise always settles — every code path must call ${code('resolve')} or ${code('reject')}`,
        'Waiting for an event? Check the event name and that the listener is attached before the event fires',
        `Turn a hang into an error with a timeout:\nimport { setTimeout as sleep } from 'node:timers/promises';\nawait Promise.race([work, sleep(5000).then(() => { throw new Error('Timed out'); })]);`,
      ],
      location: locate(error, ctx),
    });
  },
});

export const systemRules: Rule[] = [
  spawnNotFound,
  fileNotFound,
  permissionDenied,
  tooManyOpenFiles,
  outOfMemory,
  unsettledTopLevelAwait,
];
