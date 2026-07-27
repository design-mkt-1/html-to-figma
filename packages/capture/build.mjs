import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, 'dist', 'capture.bundle.js');

/**
 * The capture engine is bundled as a self-contained IIFE with no imports and no
 * Node built-ins, because it has to run in three places unchanged: injected by
 * the CLI via `page.evaluate`, as an extension content script, and in tests.
 * Anything that breaks that portability breaks the extension roadmap.
 */
const result = await build({
  entryPoints: [join(here, 'src', 'entry.ts')],
  bundle: true,
  format: 'iife',
  globalName: '__h2f',
  target: 'chrome110',
  platform: 'browser',
  minify: process.env.H2F_DEBUG !== '1',
  sourcemap: false,
  write: false,
  legalComments: 'none',
  // esbuild's IIFE output declares `var __h2f`, which only becomes a global
  // when the bundle runs at top level. Hosts that evaluate it inside a wrapper
  // function — `page.evaluate`, `chrome.scripting.executeScript` — would leave
  // it function-scoped and invisible. Assigning explicitly works in both.
  footer: { js: 'globalThis.__h2f = __h2f;' },
});

const [output] = result.outputFiles;
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, output.text);

// Also emit the bundle as an exported JS string so the CLI can import it
// directly instead of reading from disk at runtime — that keeps `npx` installs
// working regardless of where the package ends up on disk.
writeFileSync(
  join(here, 'dist', 'capture.bundle.mjs'),
  `export const CAPTURE_BUNDLE = ${JSON.stringify(output.text)};\n`,
);
writeFileSync(
  join(here, 'dist', 'capture.bundle.d.mts'),
  'export declare const CAPTURE_BUNDLE: string;\n',
);

console.log(`capture bundle: ${(output.text.length / 1024).toFixed(1)} kB`);
