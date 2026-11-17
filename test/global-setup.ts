import { execSync } from 'node:child_process';
import path from 'node:path';

/** The register hook and CLI are tested as built artifacts, so build once before the run. */
export default function setup(): void {
  execSync('npm run build --silent', {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
