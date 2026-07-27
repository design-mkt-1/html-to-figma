import { build, context } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const watch = process.argv.includes('--watch');

mkdirSync(dist, { recursive: true });

/**
 * The sandbox bundle. Figma runs this in QuickJS, not a browser: no DOM, no
 * dynamic import, and an ES2017-era feature set.
 */
const codeConfig = {
  entryPoints: [join(here, 'src', 'code.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2017',
  platform: 'neutral',
  outfile: join(dist, 'code.js'),
  minify: !watch,
};

/**
 * The UI bundle is inlined into a single HTML file, because a Figma plugin's
 * `ui` entry must be one self-contained document — it cannot reference sibling
 * files.
 */
async function buildUi() {
  const result = await build({
    entryPoints: [join(here, 'src', 'ui.ts')],
    bundle: true,
    format: 'iife',
    target: 'chrome110',
    platform: 'browser',
    write: false,
    minify: !watch,
  });

  const template = readFileSync(join(here, 'ui.template.html'), 'utf8');
  const script = result.outputFiles[0].text;

  writeFileSync(
    join(dist, 'ui.html'),
    template.replace('/* __H2F_UI_SCRIPT__ */', () => script),
  );
}

if (watch) {
  const ctx = await context(codeConfig);
  await ctx.watch();
  await buildUi();
  console.log('watching…');
} else {
  await build(codeConfig);
  await buildUi();
  console.log('plugin: dist/code.js, dist/ui.html');
}
