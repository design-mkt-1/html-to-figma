import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '@h2f/schema';
import type { Capture, ElementNode, ImageNode, RootNode, SceneNode } from '@h2f/schema';
import { fromBase64, toBase64 } from '../src/base64.js';
import { dropUnresolvedRasters, pruneMissingAssets } from '../src/prune.js';
import { countPendingAssets, resolveAssets, type AssetAdapter } from '../src/resolve-assets.js';

/**
 * These cover the half of asset resolution that both hosts share. A drift here
 * shows up as a capture file that fails validation inside the plugin, where the
 * user has nothing to act on, so the failure paths matter more than the happy
 * one.
 */

// A 1×1 PNG, the smallest thing `readImageSize` will accept.
const PNG_1X1 = fromBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
);

function base(id: string, overrides: Partial<ElementNode> = {}): ElementNode {
  return {
    kind: 'ELEMENT',
    id,
    name: id,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    opacity: 1,
    blendMode: 'NORMAL',
    rotation: 0,
    sizing: { horizontal: 'FIXED', vertical: 'FIXED' },
    fills: [],
    stroke: null,
    corners: [0, 0, 0, 0],
    effects: [],
    clipsContent: false,
    layout: { mode: 'ABSOLUTE' },
    children: [],
    ...overrides,
  };
}

function image(id: string, asset: string): ImageNode {
  const { fills, stroke, corners, effects, clipsContent, layout, children, ...rest } = base(id);
  (void fills, clipsContent, layout, children);
  return { ...rest, kind: 'IMAGE', asset, scaleMode: 'FILL', corners, stroke, effects, alt: '' };
}

function makeCapture(children: SceneNode[], assets: Capture['assets']): Capture {
  const root: RootNode = {
    ...base('root', { rect: { x: 0, y: 0, width: 100, height: 100 }, children }),
    kind: 'ROOT',
    viewportWidth: 100,
  } as RootNode;

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
    roots: [root],
    assets,
    fonts: [],
    warnings: [],
  };
}

function pending(url: string, width = 10, height = 10): Capture['assets'][string] {
  return { kind: 'PENDING', url, width, height } as unknown as Capture['assets'][string];
}

function adapter(overrides: Partial<AssetAdapter> = {}): AssetAdapter {
  return {
    fetchBytes: async () => ({ bytes: PNG_1X1, contentType: 'image/png' }),
    decodeImage: async () => null,
    ...overrides,
  };
}

describe('resolveAssets', () => {
  it('turns a pending asset into base64 bitmap bytes with header dimensions', async () => {
    const capture = makeCapture([image('img', 'img:0')], {
      'img:0': pending('https://cdn.test/a.png'),
    });

    const warnings = await resolveAssets(capture, adapter(), { maxImageDim: 4096 });

    expect(warnings).toEqual([]);
    expect(capture.assets['img:0']).toEqual({
      kind: 'BITMAP',
      bytes: toBase64(PNG_1X1),
      mimeType: 'image/png',
      width: 1,
      height: 1,
      source: 'https://cdn.test/a.png',
    });
  });

  it('decodes data URLs without touching the adapter', async () => {
    const fetchBytes = vi.fn();
    const capture = makeCapture([image('img', 'img:0')], {
      'img:0': pending(`data:image/png;base64,${toBase64(PNG_1X1)}`),
    });

    await resolveAssets(capture, adapter({ fetchBytes }), { maxImageDim: 4096 });

    expect(fetchBytes).not.toHaveBeenCalled();
    expect(capture.assets['img:0']).toMatchObject({ kind: 'BITMAP', width: 1, height: 1 });
  });

  it('keeps SVG as markup rather than rasterizing it', async () => {
    const markup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>';
    const capture = makeCapture([image('img', 'img:0')], {
      'img:0': pending('https://cdn.test/icon.svg', 24, 24),
    });

    await resolveAssets(
      capture,
      adapter({
        fetchBytes: async () => ({
          bytes: new TextEncoder().encode(markup),
          // Servers routinely mislabel SVG, so detection cannot rely on this.
          contentType: 'application/octet-stream',
        }),
      }),
      { maxImageDim: 4096 },
    );

    expect(capture.assets['img:0']).toEqual({
      kind: 'SVG',
      markup,
      width: 24,
      height: 24,
      source: 'https://cdn.test/icon.svg',
    });
  });

  it('sends oversized images to the adapter to be downscaled', async () => {
    // 8000×8000 PNG header: past Figma's 4096 ceiling for `createImage`.
    const big = new Uint8Array(PNG_1X1);
    new DataView(big.buffer).setUint32(16, 8000);
    new DataView(big.buffer).setUint32(20, 8000);

    const decodeImage = vi.fn(async () => ({
      bytes: PNG_1X1,
      mimeType: 'image/png',
      width: 4096,
      height: 4096,
    }));

    const capture = makeCapture([image('img', 'img:0')], {
      'img:0': pending('https://cdn.test/huge.png'),
    });

    await resolveAssets(
      capture,
      adapter({ fetchBytes: async () => ({ bytes: big, contentType: 'image/png' }), decodeImage }),
      { maxImageDim: 4096 },
    );

    expect(decodeImage).toHaveBeenCalledWith(big, 'image/png', 4096);
    expect(capture.assets['img:0']).toMatchObject({ width: 4096, height: 4096 });
  });

  it('drops the layer and warns when a fetch fails', async () => {
    const capture = makeCapture([image('img', 'img:0'), base('keep')], {
      'img:0': pending('https://cdn.test/gone.png'),
    });

    const warnings = await resolveAssets(
      capture,
      adapter({
        fetchBytes: async () => {
          throw new Error('HTTP 404');
        },
      }),
      { maxImageDim: 4096 },
    );

    expect(warnings.map((w) => w.code)).toEqual(['asset.failed', 'asset.dropped']);
    expect(capture.assets['img:0']).toBeUndefined();
    expect(capture.roots[0]!.children.map((c) => c.id)).toEqual(['keep']);
  });

  it('warns when the bytes are not a decodable image', async () => {
    const capture = makeCapture([image('img', 'img:0')], {
      'img:0': pending('https://cdn.test/weird.avif'),
    });

    const warnings = await resolveAssets(
      capture,
      adapter({
        fetchBytes: async () => ({ bytes: new Uint8Array([1, 2, 3, 4]), contentType: '' }),
      }),
      { maxImageDim: 4096 },
    );

    expect(warnings.map((w) => w.code)).toEqual(['asset.unreadable', 'asset.dropped']);
  });

  it('leaves raster placeholders alone — the screenshot pass owns them', async () => {
    const fetchBytes = vi.fn();
    const capture = makeCapture([base('box', { rasterize: 'raster:box' })], {
      'raster:box': pending(''),
    });

    await resolveAssets(capture, adapter({ fetchBytes }), { maxImageDim: 4096 });

    expect(fetchBytes).not.toHaveBeenCalled();
    expect(capture.assets['raster:box']).toMatchObject({ kind: 'PENDING' });
    expect(countPendingAssets(capture)).toBe(0);
  });

  it('reports progress once per asset', async () => {
    const onProgress = vi.fn();
    const capture = makeCapture([image('a', 'img:0'), image('b', 'img:1')], {
      'img:0': pending('https://cdn.test/a.png'),
      'img:1': pending('https://cdn.test/b.png'),
    });

    await resolveAssets(capture, adapter(), { maxImageDim: 4096, concurrency: 1, onProgress });

    expect(onProgress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('never runs more fetches at once than the concurrency allows', async () => {
    let active = 0;
    let peak = 0;

    const assets: Capture['assets'] = {};
    const nodes: SceneNode[] = [];
    for (let i = 0; i < 10; i++) {
      assets[`img:${i}`] = pending(`https://cdn.test/${i}.png`);
      nodes.push(image(`n${i}`, `img:${i}`));
    }

    await resolveAssets(
      makeCapture(nodes, assets),
      adapter({
        fetchBytes: async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return { bytes: PNG_1X1, contentType: 'image/png' };
        },
      }),
      { maxImageDim: 4096, concurrency: 3 },
    );

    expect(peak).toBe(3);
  });
});

describe('pruneMissingAssets', () => {
  it('removes an image node whose asset is gone but keeps a box that lost its raster', () => {
    const capture = makeCapture(
      [image('img', 'img:0'), base('box', { rasterize: 'raster:box' })],
      {},
    );

    const warnings: Capture['warnings'] = [];
    pruneMissingAssets(capture, warnings);

    const kept = capture.roots[0]!.children;
    expect(kept.map((c) => c.id)).toEqual(['box']);
    expect((kept[0] as ElementNode).rasterize).toBeUndefined();
    expect(warnings).toEqual([
      {
        code: 'asset.dropped',
        message: '1 image layer removed because the source could not be fetched',
      },
    ]);
  });

  it('prunes nested nodes and says nothing when everything resolved', () => {
    const capture = makeCapture([base('wrap', { children: [image('img', 'img:0')] })], {
      'img:0': { kind: 'BITMAP', bytes: '', mimeType: 'image/png', width: 1, height: 1 },
    });

    const warnings: Capture['warnings'] = [];
    pruneMissingAssets(capture, warnings);

    expect(warnings).toEqual([]);
    expect((capture.roots[0]!.children[0] as ElementNode).children).toHaveLength(1);
  });
});

describe('dropUnresolvedRasters', () => {
  it('removes raster placeholders that never got a screenshot, and only those', () => {
    const capture = makeCapture([], {
      'raster:1': pending(''),
      'raster:2': { kind: 'BITMAP', bytes: '', mimeType: 'image/png', width: 1, height: 1 },
      'img:0': pending('https://cdn.test/a.png'),
    });

    dropUnresolvedRasters(capture);

    expect(Object.keys(capture.assets).sort()).toEqual(['img:0', 'raster:2']);
  });
});
