import { createServer, type Server } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

export interface StaticServer {
  origin: string;
  close(): Promise<void>;
}

/**
 * Serve a directory over HTTP for the duration of a test.
 *
 * The fixtures could be loaded over `file://`, but then the CLI's asset
 * resolution never exercises a real HTTP fetch — which is the path that matters,
 * because it is what replaces the CORS-blocked in-page fetch.
 */
export async function serve(root: string): Promise<StaticServer> {
  const base = resolve(root);

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]!;
    // Contain the served tree; a test fixture should not be able to read the
    // repository above it.
    const target = join(base, normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, ''));

    if (!target.startsWith(base)) {
      response.writeHead(403).end();
      return;
    }

    try {
      if (!statSync(target).isFile()) throw new Error('not a file');
    } catch {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    });
    createReadStream(target).pipe(response);
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((done, fail) => {
        server.close((error) => (error ? fail(error) : done()));
      }),
  };
}
