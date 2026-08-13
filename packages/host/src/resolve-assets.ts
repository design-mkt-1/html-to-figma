import type { Asset, Capture, PendingAsset, Warning } from '@h2f/schema';
import { toBase64 } from './base64.js';
import { decodeDataUrl, decodeUtf8, looksLikeSvg, type RawBytes } from './data-url.js';
import { readImageSize } from './image-size.js';
import { pruneMissingAssets } from './prune.js';

export interface DecodedImage {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * The two things only the host platform can do.
 *
 * Everything else about resolving assets — which ones to fetch, in what order,
 * what counts as an SVG, what happens when one fails — is identical whether the
 * host is Playwright in Node or a service worker in Chrome, and lives below.
 */
export interface AssetAdapter {
  /** Fetch a URL with the page's credentials, unconstrained by CORS. */
  fetchBytes(url: string): Promise<RawBytes>;
  /**
   * Decode an image, downscaling it to fit `maxDim`. Called only for formats
   * `readImageSize` cannot parse and for images that exceed the limit.
   * Returns `null` when the bytes are not a decodable image.
   */
  decodeImage(bytes: Uint8Array, contentType: string, maxDim: number): Promise<DecodedImage | null>;
}

export interface ResolveOptions {
  maxImageDim: number;
  /** Enough to hide latency, not enough to get throttled. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

type AnyAsset = Asset | PendingAsset;

/**
 * Turn every `PENDING` asset into real bytes.
 *
 * This runs in the host rather than in the page on purpose: `fetch` from inside
 * the document is subject to CORS, and the overwhelming majority of real sites
 * serve their images from a CDN that sends no permissive
 * `Access-Control-Allow-Origin` header. A Playwright request context and an
 * extension service worker are both bound by none of that.
 */
export async function resolveAssets(
  capture: Capture,
  adapter: AssetAdapter,
  options: ResolveOptions,
): Promise<Warning[]> {
  const warnings: Warning[] = [];
  const assets = capture.assets as unknown as Record<string, AnyAsset>;

  const pending = Object.entries(assets).filter(
    (entry): entry is [string, PendingAsset] => entry[1].kind === 'PENDING',
  );

  const concurrency = Math.max(1, options.concurrency ?? 8);
  let cursor = 0;
  let done = 0;

  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (cursor < pending.length) {
      const index = cursor++;
      const [ref, asset] = pending[index]!;

      // Raster placeholders are filled in by the screenshot pass, not here.
      if (asset.url === '') {
        done++;
        continue;
      }

      try {
        const resolved = await resolveOne(asset, adapter, options);
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

      options.onProgress?.(++done, pending.length);
    }
  });

  await Promise.all(workers);

  // Any node still pointing at a dropped asset would fail validation, so the
  // references are pruned rather than left dangling.
  pruneMissingAssets(capture, warnings);
  return warnings;
}

/** Number of assets `resolveAssets` would have to fetch, for progress reporting. */
export function countPendingAssets(capture: Capture): number {
  return Object.values(capture.assets as unknown as Record<string, AnyAsset>).filter(
    (asset) => asset.kind === 'PENDING' && asset.url !== '',
  ).length;
}

async function resolveOne(
  asset: PendingAsset,
  adapter: AssetAdapter,
  options: ResolveOptions,
): Promise<Asset | null> {
  const { bytes, contentType } = asset.url.startsWith('data:')
    ? decodeDataUrl(asset.url)
    : await adapter.fetchBytes(asset.url);

  if (bytes.length === 0) return null;

  // SVG stays vector all the way into Figma; rasterizing it here would throw
  // away the one asset type that imports as editable shapes.
  if (contentType.includes('svg') || looksLikeSvg(bytes)) {
    return {
      kind: 'SVG',
      markup: decodeUtf8(bytes),
      width: asset.width || 0,
      height: asset.height || 0,
      source: asset.url,
    };
  }

  const header = readImageSize(bytes);
  const needsProbe = header === null;
  const tooLarge = header !== null && Math.max(header.width, header.height) > options.maxImageDim;

  if (!needsProbe && !tooLarge) {
    return {
      kind: 'BITMAP',
      bytes: toBase64(bytes),
      mimeType: header.mimeType,
      width: header.width,
      height: header.height,
      source: asset.url,
    };
  }

  const decoded = await adapter.decodeImage(bytes, contentType, options.maxImageDim);
  if (!decoded) return null;

  return {
    kind: 'BITMAP',
    bytes: toBase64(decoded.bytes),
    mimeType: decoded.mimeType,
    width: decoded.width,
    height: decoded.height,
    source: asset.url,
  };
}

function short(url: string): string {
  return url.length > 80 ? `${url.slice(0, 77)}…` : url;
}
