import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', register: 'src/register.ts', cli: 'src/cli.ts' },
  format: ['esm', 'cjs'],
  dts: { entry: { index: 'src/index.ts', register: 'src/register.ts' } },
  target: 'node18',
  platform: 'node',
  splitting: true,
  sourcemap: false,
  minify: false,
  treeshake: true,
  clean: true,
});
