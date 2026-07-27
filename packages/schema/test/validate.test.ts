import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, validateCapture } from '../src/index.js';
import type { Capture, RootNode, SceneNode } from '../src/index.js';

/**
 * The validator is the plugin's last line of defence before it starts mutating
 * a user's Figma document, so its failure cases matter more than its success
 * case.
 */

function root(children: SceneNode[] = []): RootNode {
  return {
    kind: 'ROOT',
    id: 'root',
    name: '1200px',
    viewportWidth: 1200,
    rect: { x: 0, y: 0, width: 1200, height: 800 },
    opacity: 1,
    blendMode: 'NORMAL',
    rotation: 0,
    sizing: { horizontal: 'FIXED', vertical: 'FIXED' },
    fills: [],
    stroke: null,
    corners: [0, 0, 0, 0],
    effects: [],
    clipsContent: true,
    layout: { mode: 'ABSOLUTE' },
    children,
  };
}

function capture(overrides: Partial<Capture> = {}): Capture {
  return {
    version: SCHEMA_VERSION,
    meta: {
      url: 'https://example.test/',
      title: 'Test',
      capturedAt: '2026-01-01T00:00:00.000Z',
      colorScheme: 'light',
      locale: 'en-US',
      generator: 'test',
    },
    roots: [root()],
    assets: {},
    fonts: [],
    warnings: [],
    ...overrides,
  };
}

describe('validateCapture', () => {
  it('accepts a minimal valid document', () => {
    expect(validateCapture(capture())).toEqual({ ok: true, errors: [] });
  });

  it('rejects non-objects', () => {
    expect(validateCapture(null).ok).toBe(false);
    expect(validateCapture('a string').ok).toBe(false);
  });

  it('rejects a future schema version without reporting anything else', () => {
    // Later checks would be meaningless against an unknown shape, and a wall of
    // spurious errors would bury the one that matters.
    const result = validateCapture(capture({ version: 999 }));

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('unsupported schema version');
  });

  it('requires at least one root', () => {
    expect(validateCapture(capture({ roots: [] })).ok).toBe(false);
  });

  it('rejects duplicate node ids', () => {
    // Duplicate ids mean a merge went wrong and two viewports would share
    // assets.
    const doc = capture({
      roots: [root([{ ...root(), kind: 'ELEMENT' } as unknown as SceneNode])],
    });
    const result = validateCapture(doc);

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('duplicate node id'))).toBe(true);
  });

  it('rejects a dangling asset reference', () => {
    const doc = capture({
      roots: [
        root([
          {
            kind: 'IMAGE',
            id: 'img',
            name: 'photo',
            rect: { x: 0, y: 0, width: 10, height: 10 },
            opacity: 1,
            blendMode: 'NORMAL',
            rotation: 0,
            sizing: { horizontal: 'FIXED', vertical: 'FIXED' },
            asset: 'nope',
            scaleMode: 'FILL',
            corners: [0, 0, 0, 0],
            stroke: null,
            effects: [],
            alt: '',
          },
        ]),
      ],
    });

    expect(validateCapture(doc).errors.some((e) => e.includes('missing asset'))).toBe(true);
  });

  it('rejects non-finite geometry', () => {
    const broken = root();
    broken.rect.width = Number.NaN;

    expect(validateCapture(capture({ roots: [broken] })).ok).toBe(false);
  });

  it('rejects a text segment that runs past the string', () => {
    const doc = capture({
      roots: [
        root([
          {
            kind: 'TEXT',
            id: 'text',
            name: 'hi',
            rect: { x: 0, y: 0, width: 10, height: 10 },
            opacity: 1,
            blendMode: 'NORMAL',
            rotation: 0,
            sizing: { horizontal: 'FIXED', vertical: 'FIXED' },
            characters: 'hi',
            base: {
              family: 'Inter',
              weight: 400,
              italic: false,
              size: 16,
              lineHeight: null,
              letterSpacing: 0,
              fills: [],
              decoration: 'NONE',
              textCase: 'ORIGINAL',
            },
            segments: [{ start: 0, end: 50, style: {} }],
            align: 'LEFT',
            verticalAlign: 'TOP',
            maxLines: null,
            fills: [],
            stroke: null,
            corners: [0, 0, 0, 0],
            effects: [],
          },
        ]),
      ],
    });

    expect(validateCapture(doc).errors.some((e) => e.includes('out of range'))).toBe(true);
  });

  it('caps the error list on a badly malformed document', () => {
    const children = Array.from({ length: 200 }, (_, i) => ({
      kind: 'UNKNOWN',
      id: `n${i}`,
      name: 'x',
      rect: { x: 0, y: 0, width: 1, height: 1 },
    })) as unknown as SceneNode[];

    const result = validateCapture(capture({ roots: [root(children)] }));

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeLessThanOrEqual(60);
  });
});
