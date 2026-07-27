import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runCapture } from './capture.js';
import { parseCaptureArgs, USAGE } from './options.js';

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command !== 'capture') {
    process.stderr.write(`Unknown command "${command}".\n${USAGE}`);
    return 1;
  }

  const options = parseCaptureArgs(rest);
  const started = Date.now();

  const { capture, screenshot } = await runCapture(options);

  const json = JSON.stringify(capture);
  const payload = options.compress ? gzipSync(json, { level: 9 }) : Buffer.from(json, 'utf8');

  const outPath = resolve(options.output);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, payload);

  if (screenshot && options.screenshot) {
    const shotPath = resolve(options.screenshot);
    mkdirSync(dirname(shotPath), { recursive: true });
    writeFileSync(shotPath, screenshot);
  }

  report(capture, outPath, payload.length, Date.now() - started);
  return 0;
}

function report(
  capture: Awaited<ReturnType<typeof runCapture>>['capture'],
  outPath: string,
  bytes: number,
  elapsed: number,
): void {
  const nodes = capture.roots.reduce((sum, root) => sum + countNodes(root), 0);
  const assets = Object.keys(capture.assets).length;

  process.stdout.write(
    `${outPath}\n` +
      `  ${nodes} layers, ${assets} assets, ${capture.fonts.length} fonts\n` +
      `  ${formatBytes(bytes)} in ${(elapsed / 1000).toFixed(1)}s\n`,
  );

  if (capture.warnings.length > 0) {
    // Grouped by code: a page with 200 rotated icons should print one line.
    const byCode = new Map<string, number>();
    for (const warning of capture.warnings) {
      byCode.set(warning.code, (byCode.get(warning.code) ?? 0) + 1);
    }

    process.stdout.write(`  ${capture.warnings.length} warnings:\n`);
    for (const [code, count] of [...byCode].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`    ${code} ×${count}\n`);
    }
  }
}

function countNodes(node: { children?: unknown[] }): number {
  let total = 1;
  for (const child of node.children ?? []) {
    total += countNodes(child as { children?: unknown[] });
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
