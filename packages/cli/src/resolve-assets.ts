import type { APIRequestContext, Page } from 'playwright';
import type { Asset, Capture, PendingAsset, Warning } from '@h2f/schema';
import { readImageSize } from './image-size.js';

export interface ResolveOptions {
  maxImageDim: number;
  verbose: boolean;
}

type AnyAsset = Asset | PendingAsset;

/**
 * Turn every `PENDING` asset into real bytes.
 *
 * This runs in Node rather than in the page on purpose: `fetch` from inside the
 * document is subject to CORS, and the overwhelming majority of real sites
 * serve their images from a CDN that sends no permissive `Access-Control-Allow-
 * Origin` header. Fetching through Playwright's request context reuses the
 * page's cookies and session while being bound by none of that.
 */
export async function resolveAssets(
  capture: Capture,
  request: APIRequestContext,
  helperPage: Page,
  options: ResolveOptions,
): Promise<Warning[]> {
  const warnings: Warning[] = [];
  const assets = capture.assets as unknown as Record<string, AnyAsset>;

  const pending = Object.entries(assets).filter(
    (entry): entry is [string, PendingAsset] => entry[1].kind === 'PENDING',
  );

  if (options.verbose && pending.length > 0) {
    process.stderr.write(`  resolving ${pending.length} assets\n`);
  }

  // Bounded concurrency: enough to hide latency, not enough to get throttled.
  const CONCURRENCY = 8;
  let cursor = 0;

  const workers = Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
    while (cursor < pending.length) {
      const index = cursor++;
      const [ref, asset] = pending[index]!;

      // Raster placeholders are filled in by the screenshot pass, not here.
      if (asset.url === '') continue;

      try {
        const resolved = await resolveOne(asset, request, helperPage, options);
        if (resolved) {
          assets[ref] = resolved;
        } else {
          delete assets[ref];
          warnings.push({
            code: 'asset.unreadable',
            message: `Could not decode image: ${short(asset.url)}`,
          });
        }
      } catch (error) {
        delete assets[ref];
        warnings.push({
          code: 'asset.failed',
          message: `Could not fetch ${short(asset.url)}: ${(error as Error).message}`,
        });
      }
    }
  });

  await Promise.all(workers);

  // Any node still pointing at a dropped asset would fail validation, so the
  // references are pruned rather than left dangling.
  pruneMissingAssets(capture, warnings);
  return warnings;
}

async function resolveOne(
  asset: PendingAsset,
  request: APIRequestContext,
  helperPage: Page,
  options: ResolveOptions,
): Promise<Asset | null> {
  const { bytes, contentType } = await fetchBytes(asset.url, request);
  if (bytes.length === 0) return null;

  // SVG stays vector all the way into Figma; rasterizing it here would throw
  // away the one asset type that imports as editable shapes.
  if (contentType.includes('svg') || looksLikeSvg(bytes)) {
    const markup = bytes.toString('utf8');
    return {
      kind: 'SVG',
      markup,
      width: asset.width || 0,
      height: asset.height || 0,
      source: asset.url,
    };
  }

  const header = readImageSize(bytes);
  const needsProbe = header === null;
  const tooLarge =
    header !== null && Math.max(header.width, header.height) > options.maxImageDim;

  if (!needsProbe && !tooLarge) {
    return {
      kind: 'BITMAP',
      bytes: bytes.toString('base64'),
      mimeType: header.mimeType,
      width: header.width,
      height: header.height,
      source: asset.url,
    };
  }

  return decodeInBrowser(bytes, contentType, helperPage, options.maxImageDim, asset.url);
}

async function fetchBytes(
  url: string,
  request: APIRequestContext,
): Promise<{ bytes: Buffer; contentType: string }> {
  if (url.startsWith('data:')) {
    return decodeDataUrl(url);
  }

  const response = await request.get(url, { timeout: 30_000 });
  if (!response.ok()) {
    throw new Error(`HTTP ${response.status()}`);
  }

  return {
    bytes: await response.body(),
    contentType: response.headers()['content-type'] ?? '',
  };
}

function decodeDataUrl(url: string): { bytes: Buffer; contentType: string } {
  const comma = url.indexOf(',');
  if (comma < 0) throw new Error('malformed data URL');

  const header = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  const contentType = header.split(';')[0] ?? '';

  const bytes = header.includes('base64')
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');

  return { bytes, contentType };
}

/**
 * Decode (and if necessary downscale) an image using the browser.
 *
 * Reserved for formats the header parser does not read and for images above
 * Figma's 4096px `createImage` ceiling, which would otherwise be rejected at
 * import time.
 */
async function decodeInBrowser(
  bytes: Buffer,
  contentType: string,
  page: Page,
  maxDim: number,
  source: string,
): Promise<Asset | null> {
  const result = await page.evaluate(
    async ({ b64, mime, limit }) => {
      const binary = atob(b64);
      const data = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);

      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(new Blob([data], { type: mime }));
      } catch {
        return null;
      }

      const { width, height } = bitmap;
      const scale = Math.min(1, limit / Math.max(width, height));

      if (scale >= 1) {
        bitmap.close();
        return { width, height, dataUrl: null as string | null };
      }

      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        bitmap.close();
        return null;
      }
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();

      return { width: w, height: h, dataUrl: canvas.toDataURL('image/png') };
    },
    { b64: bytes.toString('base64'), mime: contentType || 'image/png', limit: maxDim },
  );

  if (!result) return null;

  if (result.dataUrl) {
    const decoded = decodeDataUrl(result.dataUrl);
    return {
      kind: 'BITMAP',
      bytes: decoded.bytes.toString('base64'),
      mimeType: 'image/png',
      width: result.width,
      height: result.height,
      source,
    };
  }

  return {
    kind: 'BITMAP',
    bytes: bytes.toString('base64'),
    mimeType: contentType || 'image/png',
    width: result.width,
    height: result.height,
    source,
  };
}

function looksLikeSvg(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 256).toString('utf8').trimStart();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

/**
 * Drop nodes whose asset failed to resolve.
 *
 * An image layer with no image is worse than no layer: it imports as an
 * invisible empty frame that the designer has to hunt down and delete.
 */
function pruneMissingAssets(capture: Capture, warnings: Warning[]): void {
  let dropped = 0;

  const visit = (node: { children?: unknown[] } & Record<string, unknown>): boolean => {
    const kind = node.kind as string;

    if ((kind === 'IMAGE' || kind === 'SVG') && !(String(node.asset) in capture.assets)) {
      dropped++;
      return false;
    }
    if (node.rasterize !== undefined && !(String(node.rasterize) in capture.assets)) {
      // The box itself is still meaningful even without its bitmap.
      delete node.rasterize;
    }

    if (Array.isArray(node.children)) {
      node.children = node.children.filter((child) =>
        visit(child as { children?: unknown[] } & Record<string, unknown>),
      );
    }
    return true;
  };

  for (const root of capture.roots) {
    visit(root as unknown as { children?: unknown[] } & Record<string, unknown>);
  }

  if (dropped > 0) {
    warnings.push({
      code: 'asset.dropped',
      message: `${dropped} image layer${dropped === 1 ? '' : 's'} removed because the source could not be fetched`,
    });
  }
}

function short(url: string): string {
  return url.length > 80 ? `${url.slice(0, 77)}…` : url;
}
