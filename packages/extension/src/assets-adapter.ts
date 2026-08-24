import type { AssetAdapter, DecodedImage, RawBytes } from '@h2f/host';

/**
 * The service worker's half of asset resolution.
 *
 * Fetching from the worker rather than from the page is the entire reason the
 * capture engine records URLs instead of bytes: the worker holds
 * `<all_urls>` host permission, so it reads a CDN image that the document
 * itself could never touch without a permissive `Access-Control-Allow-Origin`.
 */
export function createAssetAdapter(): AssetAdapter {
  return {
    async fetchBytes(url: string): Promise<RawBytes> {
      const response = await fetch(url, {
        // Sends the site's cookies, which is what makes an image behind a login
        // resolve — the point of capturing from the user's own browser.
        credentials: 'include',
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') ?? '',
      };
    },

    /**
     * Decode, and downscale past Figma's 4096px `createImage` ceiling.
     *
     * `createImageBitmap` and `OffscreenCanvas` are the service worker's only
     * image primitives — there is no `document` to make a canvas with — but
     * they cover every format Chrome itself can render, which is the whole
     * reason this path exists for AVIF and HEIC.
     */
    async decodeImage(
      bytes: Uint8Array,
      contentType: string,
      maxDim: number,
      allowOriginal: boolean,
    ): Promise<DecodedImage | null> {
      let bitmap: ImageBitmap;
      try {
        // The cast asserts the bytes are not backed by a SharedArrayBuffer,
        // which they never are — they come from `fetch` or a data URL.
        const part = bytes as Uint8Array<ArrayBuffer>;
        bitmap = await createImageBitmap(new Blob([part], { type: contentType || 'image/png' }));
      } catch {
        return null;
      }

      try {
        const { width, height } = bitmap;
        const scale = Math.min(1, maxDim / Math.max(width, height));

        // Within the limit and in a format Figma accepts: the original bytes
        // are already the best copy, and re-encoding would only cost quality
        // and time. Otherwise (WebP, AVIF, …) fall through to the canvas,
        // which re-encodes as PNG even at full size.
        if (scale >= 1 && allowOriginal) {
          return { bytes, mimeType: contentType || 'image/png', width, height };
        }

        const w = Math.max(1, Math.round(width * scale));
        const h = Math.max(1, Math.round(height * scale));

        const canvas = new OffscreenCanvas(w, h);
        const context = canvas.getContext('2d');
        if (!context) return null;

        context.drawImage(bitmap, 0, 0, w, h);
        const blob = await canvas.convertToBlob({ type: 'image/png' });

        return {
          bytes: new Uint8Array(await blob.arrayBuffer()),
          mimeType: 'image/png',
          width: w,
          height: h,
        };
      } finally {
        bitmap.close();
      }
    },
  };
}
