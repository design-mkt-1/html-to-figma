import type { APIRequestContext, Page } from 'playwright';
import type { Capture, Warning } from '@h2f/schema';
import {
  countPendingAssets,
  decodeDataUrl,
  resolveAssets as resolveWithAdapter,
  type AssetAdapter,
  type DecodedImage,
  type RawBytes,
} from '@h2f/host';

export interface ResolveOptions {
  maxImageDim: number;
  verbose: boolean;
}

/**
 * Resolve every pending asset using Playwright.
 *
 * The orchestration — which assets to fetch, concurrency, what happens when one
 * fails, pruning the nodes that referenced it — lives in `@h2f/host` so the CLI
 * and the browser extension cannot drift apart. Only the two things Playwright
 * does differently are here.
 */
export async function resolveAssets(
  capture: Capture,
  request: APIRequestContext,
  helperPage: Page,
  options: ResolveOptions,
): Promise<Warning[]> {
  const pending = countPendingAssets(capture);
  if (options.verbose && pending > 0) {
    process.stderr.write(`  resolving ${pending} assets\n`);
  }

  return resolveWithAdapter(capture, playwrightAdapter(request, helperPage), {
    maxImageDim: options.maxImageDim,
    // Bounded concurrency: enough to hide latency, not enough to get throttled.
    concurrency: 8,
  });
}

function playwrightAdapter(request: APIRequestContext, helperPage: Page): AssetAdapter {
  return {
    /**
     * Fetch through Playwright's request context rather than from inside the
     * document: it reuses the page's cookies and session while being bound by
     * none of the CORS rules that would block a CDN image.
     */
    async fetchBytes(url: string): Promise<RawBytes> {
      const response = await request.get(url, { timeout: 30_000 });
      if (!response.ok()) {
        throw new Error(`HTTP ${response.status()}`);
      }

      return {
        bytes: await response.body(),
        contentType: response.headers()['content-type'] ?? '',
      };
    },

    decodeImage: (bytes, contentType, maxDim, allowOriginal) =>
      decodeInBrowser(bytes, contentType, helperPage, maxDim, allowOriginal),
  };
}

/**
 * Decode (and if necessary downscale) an image using the browser.
 *
 * Reserved for formats the header parser does not read and for images above
 * Figma's 4096px `createImage` ceiling, which would otherwise be rejected at
 * import time.
 */
async function decodeInBrowser(
  bytes: Uint8Array,
  contentType: string,
  page: Page,
  maxDim: number,
  allowOriginal: boolean,
): Promise<DecodedImage | null> {
  const result = await page.evaluate(
    async ({ b64, mime, limit, keepOriginal }) => {
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

      // Original bytes survive only when they are both within the size limit
      // and in a format Figma accepts; a full-size WebP still has to come
      // back as PNG.
      if (scale >= 1 && keepOriginal) {
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
    {
      b64: Buffer.from(bytes).toString('base64'),
      mime: contentType || 'image/png',
      limit: maxDim,
      keepOriginal: allowOriginal,
    },
  );

  if (!result) return null;

  if (result.dataUrl) {
    const decoded = decodeDataUrl(result.dataUrl);
    return {
      bytes: decoded.bytes,
      mimeType: 'image/png',
      width: result.width,
      height: result.height,
    };
  }

  return {
    bytes,
    mimeType: contentType || 'image/png',
    width: result.width,
    height: result.height,
  };
}
