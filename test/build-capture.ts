import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Rebuild the capture bundle, and the extension that embeds a copy of it,
 * before any test runs.
 *
 * `@h2f/cli` inlines the bundle at build time and the extension copies it into
 * its `dist`, so the end-to-end tests exercise whatever was last built — not
 * the current sources. Without this, editing the walker and running vitest
 * directly tests the previous revision and passes.
 */
export async function setup(): Promise<void> {
  for (const workspace of ['packages/capture', 'packages/extension']) {
    execFileSync('node', ['build.mjs'], {
      cwd: resolve(root, workspace),
      stdio: 'ignore',
    });
  }
}
