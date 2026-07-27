import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { Capture } from '@h2f/schema';
import { runCapture } from '@h2f/cli';
import { parseCaptureArgs } from '@h2f/cli';
import { serve, type StaticServer } from '../../cli/test/serve.js';
import { Builder } from '../src/build.js';
import { DEFAULT_IMPORT_OPTIONS } from '../src/messages.js';
import { createMockFigma, type MockFrame, type MockNode } from './mock-figma.js';

/**
 * The full pipeline: a real page through the real capture engine, then through
 * the real plugin builder.
 *
 * The unit tests either side of this use hand-written captures, which means
 * they only ever exercise the shapes the author thought to write down. This
 * runs the two halves against each other, which is where format drift and
 * unhandled combinations actually show up.
 */

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures');

let server: StaticServer;
let capture: Capture;
let root: MockFrame;
let warnings: string[];

beforeAll(async () => {
  server = await serve(FIXTURES);
  const options = parseCaptureArgs([`${server.origin}/site.html`, '--viewport', '1440']);
  capture = (await runCapture(options)).capture;

  const bytes = new Map<string, Uint8Array>();
  for (const [ref, asset] of Object.entries(capture.assets)) {
    if (asset.kind === 'BITMAP') {
      bytes.set(ref, Uint8Array.from(Buffer.from(asset.bytes, 'base64')));
    }
  }

  const figma = createMockFigma({
    availableFonts: [
      { family: 'Arial', style: 'Regular' },
      { family: 'Arial', style: 'Bold' },
      { family: 'Arial', style: 'Bold Italic' },
    ],
  });

  const result = await new Builder(figma, capture, bytes, DEFAULT_IMPORT_OPTIONS).build();
  root = result.roots[0] as unknown as MockFrame;
  warnings = result.warnings.map((w) => w.code);
}, 180_000);

afterAll(async () => {
  await server?.close();
});

function flatten(node: MockNode, out: MockNode[] = []): MockNode[] {
  out.push(node);
  for (const child of (node as MockFrame).children ?? []) flatten(child, out);
  return out;
}

function find(name: string): MockNode | undefined {
  return flatten(root).find((node) => node.name.includes(name));
}

describe('capture → plugin round trip', () => {
  it('builds a layer for every captured node', () => {
    const captured = countIr(capture.roots[0]!);
    expect(flatten(root)).toHaveLength(captured);
  });

  it('produces no unexpected build warnings', () => {
    // Font substitution is expected: the fixture uses Arial and the mock only
    // reports a few faces. Anything else means the two halves disagree.
    expect(
      warnings.filter((code) => code !== 'font.missing' && !code.startsWith('pseudo')),
    ).toEqual([]);
  });

  it('reproduces the header as an auto-layout frame', () => {
    const header = find('header') as MockFrame;

    expect(header.layoutMode).toBe('HORIZONTAL');
    expect(header.primaryAxisAlignItems).toBe('SPACE_BETWEEN');
  });

  it('keeps every layer at the position it was captured at', () => {
    // The builder's drift check should mean this holds for the whole tree,
    // whether a frame kept auto-layout or reverted to absolute.
    const mismatches: string[] = [];
    compare(capture.roots[0]!, root, mismatches);

    expect(mismatches).toEqual([]);
  });

  it('creates a real text layer for the button label', () => {
    const button = find('cta') as MockFrame;
    const label = button.children[0]!;

    expect(label.type).toBe('TEXT');
    expect(label.x).toBe(20);
    expect(label.y).toBe(10);
  });

  it('creates an image fill from the captured bytes', () => {
    const image = flatten(root).find((node) => node.type === 'RECTANGLE');

    expect(image).toBeDefined();
    const fills = image!.fills as Array<{ type: string; imageHash: string }>;
    expect(fills[0]).toMatchObject({ type: 'IMAGE' });
  });
});

function countIr(node: { children?: unknown[] }): number {
  let total = 1;
  for (const child of node.children ?? []) total += countIr(child as { children?: unknown[] });
  return total;
}

function compare(
  source: {
    name: string;
    rect: { x: number; y: number; width: number; height: number };
    children?: unknown[];
  },
  built: MockNode,
  mismatches: string[],
): void {
  const drift = Math.max(
    Math.abs(built.width - source.rect.width),
    Math.abs(built.height - source.rect.height),
  );
  if (drift > 1) {
    mismatches.push(`${source.name}: size off by ${drift.toFixed(1)}px`);
  }

  const children = (source.children ?? []) as (typeof source)[];
  const builtChildren = (built as MockFrame).children ?? [];

  children.forEach((child, index) => {
    const builtChild = builtChildren[index];
    if (!builtChild) {
      mismatches.push(`${child.name}: missing from the built tree`);
      return;
    }

    const offset = Math.max(
      Math.abs(builtChild.x - child.rect.x),
      Math.abs(builtChild.y - child.rect.y),
    );
    if (offset > 1) {
      mismatches.push(`${child.name}: moved ${offset.toFixed(1)}px`);
    }

    compare(child, builtChild, mismatches);
  });
}
