import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, 'src', 'main.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: join(here, 'dist', 'h2f.mjs'),
  // Playwright is a real Node dependency with native pieces; bundling it would
  // break its browser lookup. The capture bundle, by contrast, is inlined —
  // that is the whole point of building it as a standalone string.
  external: ['playwright', 'playwright-core'],
  banner: { js: '#!/usr/bin/env node' },
});

console.log('cli: dist/h2f.mjs');
