import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Rebuild the capture bundle before any test runs.
 *
 * `@h2f/cli` inlines the bundle at build time, so the end-to-end tests exercise
 * whatever was last written to `packages/capture/dist` — not the current
 * sources. Without this, editing the walker and running vitest directly tests
 * the previous revision and passes.
 */
export async function setup(): Promise<void> {
  execFileSync('node', ['build.mjs'], {
    cwd: resolve(root, 'packages/capture'),
    stdio: 'ignore',
  });
}
