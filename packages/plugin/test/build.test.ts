import { beforeEach, describe, expect, it } from 'vitest';
import { Builder } from '../src/build.js';
import { DEFAULT_IMPORT_OPTIONS } from '../src/messages.js';
import { createMockFigma, type MockFrame, type MockText } from './mock-figma.js';
import {
  horizontal,
  makeCapture,
  makeElement,
  makeRoot,
  makeText,
  resetIds,
  vertical,
} from './fixtures.js';
import type { Capture } from '@h2f/schema';

beforeEach(resetIds);

async function build(capture: Capture, options = {}, figmaOptions = {}) {
  const figma = createMockFigma(figmaOptions);
  const builder = new Builder(figma, capture, new Map(), {
    ...DEFAULT_IMPORT_OPTIONS,
    ...options,
  });
  const result = await builder.build();
  return { figma, result, root: result.roots[0] as unknown as MockFrame };
}

describe('frame construction', () => {
  it('reproduces the captured geometry', async () => {
    const capture = makeCapture(
      makeRoot(
        [
          makeElement([], { x: 20, y: 30, width: 120, height: 60 }),
          makeElement([], { x: 20, y: 110, width: 200, height: 40 }),
        ],
        { width: 400, height: 300 },
      ),
    );

    const { root } = await build(capture);

    expect(root.width).toBe(400);
    expect(root.height).toBe(300);
    expect(root.children).toHaveLength(2);
    expect(root.children[0]).toMatchObject({ x: 20, y: 30, width: 120, height: 60 });
    expect(root.children[1]).toMatchObject({ x: 20, y: 110, width: 200, height: 40 });
  });

  it('clears the default white frame fill', async () => {
    // Figma frames are opaque white by default. Inheriting that would make
    // every transparent div in a capture silently paint over what is behind it.
    const capture = makeCapture(makeRoot([makeElement()], { width: 100, height: 100 }));
    const { root } = await build(capture);

    expect(root.children[0]!.fills).toEqual([]);
  });

  it('counts every layer it created', async () => {
    const capture = makeCapture(
      makeRoot([makeElement([makeElement(), makeElement()]), makeElement()]),
    );
    const { result } = await build(capture);

    // root + 2 top-level + 2 nested
    expect(result.layers).toBe(5);
  });
});

describe('auto-layout', () => {
  it('applies a horizontal layout that reproduces the capture', async () => {
    const capture = makeCapture(
      makeRoot(
        [
          makeElement([], { x: 10, y: 10, width: 100, height: 50 }),
          makeElement([], { x: 130, y: 10, width: 100, height: 50 }),
          makeElement([], { x: 250, y: 10, width: 100, height: 50 }),
        ],
        { width: 400, height: 70 },
      ),
    );
    capture.roots[0]!.layout = horizontal(20, 10);

    const { root, result } = await build(capture);

    expect(root.layoutMode).toBe('HORIZONTAL');
    expect(root.itemSpacing).toBe(20);
    expect(root.children.map((c) => c.x)).toEqual([10, 130, 250]);
    expect(result.warnings.filter((w) => w.code === 'layout.reverted')).toHaveLength(0);
  });

  it('applies a vertical layout', async () => {
    const capture = makeCapture(
      makeRoot(
        [
          makeElement([], { x: 0, y: 0, width: 300, height: 40 }),
          makeElement([], { x: 0, y: 56, width: 300, height: 40 }),
        ],
        { width: 300, height: 96 },
      ),
    );
    capture.roots[0]!.layout = vertical(16);

    const { root } = await build(capture);

    expect(root.layoutMode).toBe('VERTICAL');
    expect(root.children.map((c) => c.y)).toEqual([0, 56]);
  });

  /**
   * The whole point of the verification pass. A capture that claims a uniform
   * gap but whose children do not actually sit at those positions must not be
   * trusted — Figma would move them and the import would be visibly wrong.
   */
  it('reverts to absolute positioning when auto-layout would move children', async () => {
    const capture = makeCapture(
      makeRoot(
        [
          makeElement([], { x: 0, y: 0, width: 100, height: 40 }),
          // Claims a 10px gap, but sits 60px away — inconsistent.
          makeElement([], { x: 0, y: 100, width: 100, height: 40 }),
        ],
        { width: 200, height: 200 },
      ),
    );
    capture.roots[0]!.layout = vertical(10);

    const { root, result } = await build(capture);

    expect(root.layoutMode).toBe('NONE');
    expect(root.children[1]).toMatchObject({ x: 0, y: 100 });
    expect(result.warnings.some((w) => w.code === 'layout.reverted')).toBe(true);
  });

  it('restores both position and size when reverting', async () => {
    const capture = makeCapture(
      makeRoot(
        [
          makeElement([], { x: 5, y: 0, width: 80, height: 40 }),
          makeElement([], { x: 40, y: 90, width: 120, height: 30 }),
        ],
        { width: 300, height: 200 },
      ),
    );
    capture.roots[0]!.layout = horizontal(4);

    const { root } = await build(capture);

    expect(root.layoutMode).toBe('NONE');
    expect(root.children[0]).toMatchObject({ x: 5, y: 0, width: 80, height: 40 });
    expect(root.children[1]).toMatchObject({ x: 40, y: 90, width: 120, height: 30 });
  });

  it('honours the auto-layout opt-out', async () => {
    const capture = makeCapture(
      makeRoot(
        [
          makeElement([], { x: 0, y: 0, width: 100, height: 40 }),
          makeElement([], { x: 0, y: 50, width: 100, height: 40 }),
        ],
        { width: 100, height: 90 },
      ),
    );
    capture.roots[0]!.layout = vertical(10);

    const { root } = await build(capture, { autoLayout: false });

    expect(root.layoutMode).toBe('NONE');
    expect(root.children.map((c) => c.y)).toEqual([0, 50]);
  });

  it('reproduces space-between', async () => {
    const capture = makeCapture(
      makeRoot(
        [
          makeElement([], { x: 0, y: 0, width: 100, height: 40 }),
          makeElement([], { x: 300, y: 0, width: 100, height: 40 }),
        ],
        { width: 400, height: 40 },
      ),
    );
    capture.roots[0]!.layout = {
      ...horizontal(0),
      primaryAlign: 'SPACE_BETWEEN',
    };

    const { root } = await build(capture);

    expect(root.layoutMode).toBe('HORIZONTAL');
    expect(root.children.map((c) => c.x)).toEqual([0, 300]);
  });
});

describe('text', () => {
  it('creates editable text with the captured characters', async () => {
    const capture = makeCapture(makeRoot([makeText('Hello world')]), {
      fonts: [{ family: 'Inter', weight: 400, italic: false }],
    });

    const { root } = await build(capture);
    const text = root.children[0] as unknown as MockText;

    expect(text.type).toBe('TEXT');
    expect(text.characters).toBe('Hello world');
    expect(text.fontName).toEqual({ family: 'Inter', style: 'Regular' });
  });

  it('applies inline segment styling as ranges', async () => {
    const node = makeText('normal bold normal', { width: 300 });
    node.segments = [{ start: 7, end: 11, style: { weight: 700 } }];

    const capture = makeCapture(makeRoot([node]), {
      fonts: [
        { family: 'Inter', weight: 400, italic: false },
        { family: 'Inter', weight: 700, italic: false },
      ],
    });

    const { root } = await build(capture);
    const text = root.children[0] as unknown as MockText;

    expect(text.ranges).toContainEqual({
      start: 7,
      end: 11,
      property: 'fontName',
      value: { family: 'Inter', style: 'Bold' },
    });
  });

  it('keeps text at the captured size rather than auto-sizing', async () => {
    // Figma re-wraps auto-sized text using its own metrics, which would shift
    // everything below it in the page.
    const capture = makeCapture(makeRoot([makeText('Some text', { width: 250, height: 48 })]));
    const { root } = await build(capture);
    const text = root.children[0] as unknown as MockText;

    expect(text.textAutoResize).toBe('NONE');
    expect(text.width).toBe(250);
    expect(text.height).toBe(48);
  });

  it('clamps a segment that runs past the end of the string', async () => {
    const node = makeText('short');
    node.segments = [{ start: 2, end: 999, style: { weight: 700 } }];

    const capture = makeCapture(makeRoot([node]));
    const { root, result } = await build(capture);
    const text = root.children[0] as unknown as MockText;

    expect(text.ranges.every((r) => r.end <= 'short'.length)).toBe(true);
    expect(result.warnings.some((w) => w.code === 'text.failed')).toBe(false);
  });
});

describe('fonts', () => {
  it('substitutes an unavailable family and reports it', async () => {
    const capture = makeCapture(makeRoot([makeText('Hi')]), {
      fonts: [{ family: 'Nonexistent Sans', weight: 400, italic: false }],
    });

    const { result } = await build(capture);
    const warning = result.warnings.find((w) => w.code === 'font.missing');

    expect(warning?.message).toContain('Nonexistent Sans');
  });

  it('preloads every font before building text', async () => {
    const capture = makeCapture(makeRoot([makeText('Hi')]), {
      fonts: [
        { family: 'Inter', weight: 400, italic: false },
        { family: 'Inter', weight: 700, italic: false },
      ],
    });

    const { figma } = await build(capture);

    expect(figma.loadedFonts).toEqual([
      { family: 'Inter', style: 'Regular' },
      { family: 'Inter', style: 'Bold' },
    ]);
  });
});

describe('images', () => {
  it('skips an image layer whose bytes never arrived', async () => {
    const capture = makeCapture(
      makeRoot([
        {
          kind: 'IMAGE',
          id: 'img-node',
          name: 'photo',
          rect: { x: 0, y: 0, width: 100, height: 100 },
          opacity: 1,
          blendMode: 'NORMAL',
          rotation: 0,
          sizing: { horizontal: 'FIXED', vertical: 'FIXED' },
          asset: 'missing',
          scaleMode: 'FILL',
          corners: [0, 0, 0, 0],
          stroke: null,
          effects: [],
          alt: '',
        },
      ]),
    );

    const { root } = await build(capture);
    expect(root.children).toHaveLength(0);
  });

  it('imports inline SVG as a vector frame', async () => {
    const capture = makeCapture(
      makeRoot([
        {
          kind: 'SVG',
          id: 'svg-node',
          name: 'icon',
          rect: { x: 0, y: 0, width: 24, height: 24 },
          opacity: 1,
          blendMode: 'NORMAL',
          rotation: 0,
          sizing: { horizontal: 'FIXED', vertical: 'FIXED' },
          asset: 'svg:0',
        },
      ]),
      {
        assets: {
          'svg:0': {
            kind: 'SVG',
            markup: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="8"/></svg>',
            width: 24,
            height: 24,
          },
        },
      },
    );

    const { root } = await build(capture);

    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toMatchObject({ width: 24, height: 24 });
  });
});
