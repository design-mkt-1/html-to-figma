import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { Capture, ElementNode, SceneNode } from '@h2f/schema';
import { validateCapture } from '@h2f/schema';
import { runCapture } from '../src/capture.js';
import { parseCaptureArgs } from '../src/options.js';
import { serve, type StaticServer } from './serve.js';

/**
 * End-to-end capture tests.
 *
 * These drive a real Chromium against the fixture pages, so they cover the one
 * thing unit tests cannot: that the values Chromium actually reports from
 * `getComputedStyle` are the ones the parsers were written against. They are
 * the reason the fixtures exist.
 */

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures');

function fixtureUrl(name: string): string {
  return pathToFileURL(resolve(FIXTURES, name)).href;
}

async function capture(name: string, extraArgs: string[] = []): Promise<Capture> {
  const options = parseCaptureArgs([fixtureUrl(name), '--viewport', '1200', ...extraArgs]);
  const { capture } = await runCapture(options);
  return capture;
}

function walk(node: SceneNode | Capture['roots'][number], out: SceneNode[] = []): SceneNode[] {
  out.push(node as SceneNode);
  for (const child of (node as ElementNode).children ?? []) walk(child, out);
  return out;
}

function byName(capture: Capture, name: string): SceneNode | undefined {
  return walk(capture.roots[0]!).find((node) => node.name.includes(name));
}

describe('layout fixture', () => {
  let doc: Capture;

  beforeAll(async () => {
    doc = await capture('layout.html');
  }, 120_000);

  it('produces a valid capture document', () => {
    expect(validateCapture(doc)).toEqual({ ok: true, errors: [] });
  });

  it('records the page metadata', () => {
    expect(doc.meta.title).toBe('Layout fixture');
    expect(doc.roots[0]!.viewportWidth).toBe(1200);
  });

  it('infers a horizontal auto-layout with the real gap', () => {
    const toolbar = byName(doc, 'toolbar') as ElementNode;

    expect(toolbar.layout).toMatchObject({ mode: 'HORIZONTAL', gap: 16 });
  });

  it('reads padding through the border box', () => {
    // 16px padding plus a 1px border: Figma's padding is measured from the
    // frame edge, so the border width has to be included.
    const card = byName(doc, 'card') as ElementNode;

    expect(card.layout).toMatchObject({
      mode: 'VERTICAL',
      padding: { top: 17, right: 17, bottom: 17, left: 17 },
    });
  });

  it('measures a gap produced by margins, which no CSS property holds', () => {
    const stack = byName(doc, 'stack') as ElementNode;
    expect(stack.layout).toMatchObject({ mode: 'VERTICAL', gap: 20 });
  });

  it('detects space-between', () => {
    const split = byName(doc, 'split') as ElementNode;
    expect(split.layout).toMatchObject({ primaryAlign: 'SPACE_BETWEEN' });
  });

  it('falls back to absolute for overlapping absolute children', () => {
    const overlap = byName(doc, 'overlap') as ElementNode;
    expect(overlap.layout.mode).toBe('ABSOLUTE');
  });

  it('merges inline elements into one text layer with styled ranges', () => {
    const paragraph = walk(doc.roots[0]!).find(
      (node) => node.kind === 'TEXT' && node.characters.startsWith('A paragraph'),
    );

    expect(paragraph).toBeDefined();
    if (paragraph?.kind !== 'TEXT') throw new Error('expected a text node');

    // Whitespace collapsed exactly as the browser renders it.
    expect(paragraph.characters).toBe(
      'A paragraph with bold text, an inline link and some emphasis to exercise text segmentation.',
    );

    const styled = paragraph.segments.map((s) => paragraph.characters.slice(s.start, s.end));
    expect(styled).toEqual(['bold text', 'inline link', 'emphasis']);
  });

  it('collects every font weight and slant the page rendered', () => {
    expect(doc.fonts).toEqual(
      expect.arrayContaining([
        { family: 'Arial', weight: 400, italic: false },
        { family: 'Arial', weight: 700, italic: false },
        { family: 'Arial', weight: 400, italic: true },
      ]),
    );
  });

  it('drops visually hidden accessibility text', () => {
    const texts = walk(doc.roots[0]!)
      .filter((node): node is Extract<SceneNode, { kind: 'TEXT' }> => node.kind === 'TEXT')
      .map((node) => node.characters);

    expect(texts).not.toContain('Skip to content');
    expect(texts).not.toContain('Next slide');
    expect(texts).not.toContain('Hidden brand name');
    expect(texts).not.toContain('Invisible caption');
  });

  it('emits absolute positioning everywhere when auto-layout is off', async () => {
    const flat = await capture('layout.html', ['--no-auto-layout']);
    const modes = new Set(
      walk(flat.roots[0]!)
        .filter((node): node is ElementNode => node.kind === 'ELEMENT')
        .map((node) => node.layout.mode),
    );

    expect([...modes]).toEqual(['ABSOLUTE']);
  }, 120_000);
});

describe('visual fixture', () => {
  let doc: Capture;

  beforeAll(async () => {
    doc = await capture('visuals.html');
  }, 120_000);

  it('produces a valid capture document', () => {
    expect(validateCapture(doc)).toEqual({ ok: true, errors: [] });
  });

  function fill(id: string) {
    const node = byName(doc, id) as ElementNode;
    expect(node, `no node named ${id}`).toBeDefined();
    return node.fills[node.fills.length - 1];
  }

  it('converts a linear gradient', () => {
    const paint = fill('linear');

    expect(paint).toMatchObject({ kind: 'GRADIENT', gradientKind: 'LINEAR' });
    if (paint?.kind !== 'GRADIENT') throw new Error('expected a gradient');
    expect(paint.angle).toBeCloseTo(135, 0);
    expect(paint.stops).toHaveLength(2);
  });

  it('converts a radial gradient with an offset centre', () => {
    const paint = fill('radial');

    expect(paint).toMatchObject({ kind: 'GRADIENT', gradientKind: 'RADIAL' });
    if (paint?.kind !== 'GRADIENT') throw new Error('expected a gradient');
    expect(paint.center.x).toBeCloseTo(0.3, 1);
  });

  it('converts a conic gradient', () => {
    expect(fill('conic')).toMatchObject({ kind: 'GRADIENT', gradientKind: 'CONIC' });
  });

  it('unrolls a repeating gradient into explicit stops', () => {
    const paint = fill('repeating');
    if (paint?.kind !== 'GRADIENT') throw new Error('expected a gradient');

    expect(paint.stops.length).toBeGreaterThan(4);
  });

  it('converts a multi-layer box shadow', () => {
    const node = byName(doc, 'shadows') as ElementNode;
    expect(node.effects).toHaveLength(2);
    expect(node.effects[0]!.kind).toBe('DROP_SHADOW');
  });

  it('converts an inset shadow', () => {
    const node = byName(doc, 'inset') as ElementNode;
    expect(node.effects[0]!.kind).toBe('INNER_SHADOW');
  });

  it('reads per-side border widths', () => {
    const node = byName(doc, 'borders') as ElementNode;

    expect(node.stroke?.weights).toEqual({ top: 4, right: 2, bottom: 6, left: 2 });
    expect(node.stroke?.align).toBe('INSIDE');
  });

  it('reads a dashed border as a dash pattern', () => {
    const node = byName(doc, 'dashed') as ElementNode;
    expect(node.stroke?.dashPattern.length).toBeGreaterThan(0);
  });

  it('clamps an oversized radius to a pill', () => {
    // `border-radius: 9999px` on a 160x120 box is a 60px corner, not a 9999px
    // one — CSS scales all four radii down until they fit.
    const node = byName(doc, 'pill') as ElementNode;

    expect(node.corners[0]).toBeCloseTo(60, 0);
  });

  it('keeps colour alpha', () => {
    const paint = fill('translucent');
    if (paint?.kind !== 'SOLID') throw new Error('expected a solid');

    expect(paint.color.a).toBeCloseTo(0.4, 2);
  });

  it('converts a CSS blur filter', () => {
    const node = byName(doc, 'blurred') as ElementNode;
    expect(node.effects[0]!.kind).toBe('LAYER_BLUR');
  });

  it('records rotation for a rotated leaf', () => {
    const node = byName(doc, 'rotated') as ElementNode;
    expect(node.rotation).toBeCloseTo(20, 1);
  });

  it('rasterizes a skew, which Figma cannot express', () => {
    const node = byName(doc, 'skewed') as ElementNode;

    expect(node.rasterize).toBeDefined();
    expect(doc.assets[node.rasterize!]).toMatchObject({ kind: 'BITMAP' });
  });

  it('rasterizes a clip-path', () => {
    const node = byName(doc, 'clipped') as ElementNode;
    expect(node.rasterize).toBeDefined();
  });

  it('reconstructs a decorative pseudo-element', () => {
    const pseudo = walk(doc.roots[0]!).find((node) => node.name.includes('::before'));

    expect(pseudo).toBeDefined();
    expect(pseudo!.rect).toMatchObject({ width: 40, height: 40 });
    expect(doc.warnings.some((w) => w.code === 'pseudo.approximate')).toBe(true);
  });

  it('marks an overflow-hidden container as clipping', () => {
    const node = byName(doc, 'tall') as ElementNode;
    expect(node.clipsContent).toBe(true);
  });

  it('keeps inline SVG as vector markup', () => {
    const svg = walk(doc.roots[0]!).find((node) => node.kind === 'SVG');

    expect(svg).toBeDefined();
    if (svg?.kind !== 'SVG') throw new Error('expected an svg node');

    const asset = doc.assets[svg.asset];
    expect(asset).toMatchObject({ kind: 'SVG' });
    if (asset?.kind !== 'SVG') throw new Error('expected an svg asset');
    expect(asset.markup).toContain('<circle');
  });

  it('resolves a data-URI image to real bytes', () => {
    const image = walk(doc.roots[0]!).find((node) => node.kind === 'IMAGE');

    expect(image).toBeDefined();
    if (image?.kind !== 'IMAGE') throw new Error('expected an image node');

    const asset = doc.assets[image.asset];
    expect(asset).toMatchObject({ kind: 'BITMAP', mimeType: 'image/png', width: 2, height: 2 });
  });

  it('leaves no unresolved assets behind', () => {
    // Anything still PENDING would fail to import; the CLI must resolve or
    // prune every one.
    for (const [ref, asset] of Object.entries(doc.assets)) {
      expect(asset.kind, `asset ${ref} was never resolved`).toMatch(/BITMAP|SVG/);
    }
  });
});

describe('padded text and http assets', () => {
  let doc: Capture;
  let server: StaticServer;

  beforeAll(async () => {
    // Served over HTTP rather than file:// so asset resolution exercises a real
    // fetch — the path that exists to get around CORS.
    server = await serve(FIXTURES);
    const options = parseCaptureArgs([`${server.origin}/site.html`, '--viewport', '1440']);
    doc = (await runCapture(options)).capture;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  /**
   * Figma text layers have no padding. A padded, painted element therefore has
   * to become a frame wrapping a text layer, or every button in the import ends
   * up with its label jammed into the top-left corner of its background.
   */
  it('wraps a padded button in a frame carrying the padding', () => {
    const button = byName(doc, 'cta') as ElementNode;

    expect(button.kind).toBe('ELEMENT');
    expect(button.fills.length).toBeGreaterThan(0);
    expect(button.layout).toMatchObject({
      mode: 'VERTICAL',
      padding: { top: 10, right: 20, bottom: 10, left: 20 },
    });

    const label = button.children[0]!;
    expect(label.kind).toBe('TEXT');
    // Inset by the padding, not sitting at the frame's corner.
    expect(label.rect).toMatchObject({ x: 20, y: 10 });
  });

  it('moves the background off the text layer and onto the wrapper', () => {
    const button = byName(doc, 'cta') as ElementNode;
    const label = button.children[0]!;

    if (label.kind !== 'TEXT') throw new Error('expected a text node');
    // Painting it twice would double up the shadow and the fill.
    expect(label.fills).toEqual([]);
    expect(label.stroke).toBeNull();
  });

  it('insets an unpainted padded element without adding a wrapper', () => {
    const footer = byName(doc, 'footer') as ElementNode;

    expect(footer.layout).toMatchObject({ padding: { right: 40, left: 40 } });
    expect(footer.children[0]!.rect.x).toBe(40);
  });

  it('picks the srcset variant matching the device pixel ratio', () => {
    // Captured at --scale 2, so the 2x source is what the browser chose.
    const image = walk(doc.roots[0]!).find((node) => node.kind === 'IMAGE');
    if (image?.kind !== 'IMAGE') throw new Error('expected an image node');

    const asset = doc.assets[image.asset];
    if (asset?.kind !== 'BITMAP') throw new Error('expected a bitmap');

    expect(asset.source).toContain('photo@2x.png');
    expect(asset.width).toBe(800);
  });

  it('fetches http assets that CORS would have blocked in the page', () => {
    for (const asset of Object.values(doc.assets)) {
      expect(asset.kind).toBe('BITMAP');
      if (asset.kind !== 'BITMAP') continue;
      expect(asset.bytes.length).toBeGreaterThan(0);
    }
  });
});

describe('capture options', () => {
  it('captures multiple viewports into one document with distinct ids', async () => {
    const options = parseCaptureArgs([
      fixtureUrl('layout.html'),
      '--viewport',
      '1200',
      '--viewport',
      '390',
    ]);
    const { capture: doc } = await runCapture(options);

    expect(doc.roots).toHaveLength(2);
    expect(doc.roots.map((r) => r.viewportWidth)).toEqual([1200, 390]);

    const ids = walk(doc.roots[0]!)
      .concat(walk(doc.roots[1]!))
      .map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 120_000);

  it('removes elements matched by --hide', async () => {
    const doc = await capture('layout.html', ['--hide', '.toolbar']);
    expect(byName(doc, 'toolbar')).toBeUndefined();
  }, 120_000);

  it('warns when a --click selector never matches', async () => {
    const doc = await capture('layout.html', ['--click', '#does-not-exist']);
    expect(doc.warnings.some((w) => w.code === 'click.notFound')).toBe(true);
  }, 120_000);
});
