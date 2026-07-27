import { createReadStream, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end smoke test you can run without a network or a Figma account.
 *
 * Serves the bundled fixture site, captures it, and writes both the capture and
 * a reference screenshot — enough to confirm the toolchain works before
 * pointing it at a real URL.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'fixtures');
const out = join(root, 'out');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0];
  const target = join(fixtures, normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, ''));

  if (!target.startsWith(fixtures)) return response.writeHead(403).end();

  try {
    if (!statSync(target).isFile()) throw new Error('not a file');
  } catch {
    return response.writeHead(404).end();
  }

  response.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
  createReadStream(target).pipe(response);
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { port } = server.address();

mkdirSync(out, { recursive: true });

const child = spawn(
  process.execPath,
  [
    join(root, 'packages/cli/dist/h2f.mjs'),
    'capture',
    `http://127.0.0.1:${port}/site.html`,
    '--viewport',
    '1440',
    '--viewport',
    '390',
    '-o',
    join(out, 'demo.h2d.json'),
    '--screenshot',
    join(out, 'demo-reference.png'),
    '--verbose',
  ],
  { stdio: 'inherit' },
);

const code = await new Promise((done) => child.on('close', done));
server.close();

if (code === 0) {
  process.stdout.write('\nDrop out/demo.h2d.json onto the Figma plugin.\n');
}
process.exitCode = code ?? 1;
