import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const watch = process.argv.includes('--watch');

mkdirSync(dist, { recursive: true });

/**
 * Three separate bundles, because the extension runs in three contexts that
 * share no globals: the service worker (no DOM), the popup (a normal page that
 * is destroyed when it loses focus) and the offscreen document (a page that
 * exists only to own a blob).
 *
 * Manifest V3 forbids inline scripts in extension pages, so each page loads its
 * bundle by URL — the opposite of the Figma plugin, whose UI has to be one
 * self-contained file.
 */
const entries = [
  { in: 'worker.ts', out: 'worker.js' },
  { in: 'popup.ts', out: 'popup.js' },
  { in: 'offscreen.ts', out: 'offscreen.js' },
];

const configs = entries.map((entry) => ({
  entryPoints: [join(here, 'src', entry.in)],
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  platform: 'browser',
  outfile: join(dist, entry.out),
  minify: !watch,
  legalComments: 'none',
}));

/**
 * The capture engine is copied, not rebuilt.
 *
 * It has to be byte-for-byte the file the CLI injects through Playwright: if
 * the extension ever captured with a differently-built engine, a capture that
 * worked from one host and not the other would be indistinguishable from a bug
 * in the page.
 */
function copyEngine() {
  const bundle = join(here, '..', 'capture', 'dist', 'capture.bundle.js');

  try {
    copyFileSync(bundle, join(dist, 'capture.bundle.js'));
  } catch {
    throw new Error(
      `The capture bundle is missing. Run "npm run build:capture" first.\n  expected: ${bundle}`,
    );
  }
}

function copyStatic() {
  copyFileSync(join(here, 'manifest.json'), join(dist, 'manifest.json'));
  for (const page of ['popup.html', 'offscreen.html']) {
    copyFileSync(join(here, 'pages', page), join(dist, page));
  }

  // Keep the manifest's version in step with the package, so a loaded unpacked
  // extension reports the version the repo actually built.
  const manifestPath = join(dist, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (watch) {
  for (const config of configs) {
    const ctx = await context(config);
    await ctx.watch();
  }
  copyEngine();
  copyStatic();
  console.log('watching…');
} else {
  await Promise.all(configs.map((config) => build(config)));
  copyEngine();
  copyStatic();
  console.log(`extension: ${dist}`);
}
