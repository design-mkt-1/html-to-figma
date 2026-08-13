import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readImageSize } from '../src/image-size.js';

/**
 * Header parsing is the reason a media-heavy capture does not have to decode
 * every image in a browser, so it has to agree with a real decoder on real
 * files — hence the fixtures rather than hand-written byte arrays.
 */

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures/assets');

function fixture(name: string): Uint8Array {
  return readFileSync(resolve(FIXTURES, name));
}

describe('readImageSize', () => {
  it('reads PNG dimensions from the fixtures', () => {
    expect(readImageSize(fixture('photo.png'))).toEqual({
      width: 400,
      height: 300,
      mimeType: 'image/png',
    });
    expect(readImageSize(fixture('photo@2x.png'))).toEqual({
      width: 800,
      height: 600,
      mimeType: 'image/png',
    });
  });

  /**
   * `Buffer.from(...).subarray()` shares its parent's ArrayBuffer, and Node
   * pools small allocations, so a parser built on `DataView` reads the wrong
   * offsets unless it honours `byteOffset`. That is exactly what happens to a
   * screenshot buffer in the raster pass.
   */
  it('reads correctly from a view into a larger buffer', () => {
    const png = fixture('photo.png');
    const backing = new Uint8Array(png.length + 64);
    backing.set(png, 32);

    expect(readImageSize(backing.subarray(32, 32 + png.length))).toEqual({
      width: 400,
      height: 300,
      mimeType: 'image/png',
    });
  });

  it('reads GIF, BMP and JPEG headers', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xc8, 0x00]);
    expect(readImageSize(gif)).toEqual({ width: 320, height: 200, mimeType: 'image/gif' });

    const bmp = new Uint8Array(26);
    bmp[0] = 0x42;
    bmp[1] = 0x4d;
    new DataView(bmp.buffer).setInt32(18, 100, true);
    // Negative height means a top-down bitmap; the magnitude is the size.
    new DataView(bmp.buffer).setInt32(22, -50, true);
    expect(readImageSize(bmp)).toEqual({ width: 100, height: 50, mimeType: 'image/bmp' });

    // SOI, an APP0 segment to be skipped, then SOF0 carrying the dimensions.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c,
      0x02, 0x58, 0x03, 0x01, 0x22, 0x00,
    ]);
    expect(readImageSize(jpeg)).toEqual({ width: 600, height: 300, mimeType: 'image/jpeg' });
  });

  it('reads all three WebP chunk layouts', () => {
    const riff = (chunk: string, fill: (view: DataView, bytes: Uint8Array) => void): Uint8Array => {
      const bytes = new Uint8Array(32);
      const view = new DataView(bytes.buffer);
      bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
      bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
      for (let i = 0; i < 4; i++) bytes[12 + i] = chunk.charCodeAt(i);
      fill(view, bytes);
      return bytes;
    };

    const lossy = riff('VP8 ', (view) => {
      view.setUint16(26, 320, true);
      view.setUint16(28, 200, true);
    });
    expect(readImageSize(lossy)).toEqual({ width: 320, height: 200, mimeType: 'image/webp' });

    // Lossless packs width-1 and height-1 into 14 bits each.
    const lossless = riff('VP8L', (view) => {
      view.setUint32(21, (319 & 0x3fff) | ((199 & 0x3fff) << 14), true);
    });
    expect(readImageSize(lossless)).toEqual({ width: 320, height: 200, mimeType: 'image/webp' });

    const extended = riff('VP8X', (_view, bytes) => {
      bytes.set([319 & 0xff, (319 >> 8) & 0xff, 0], 24);
      bytes.set([199 & 0xff, (199 >> 8) & 0xff, 0], 27);
    });
    expect(readImageSize(extended)).toEqual({ width: 320, height: 200, mimeType: 'image/webp' });
  });

  it('returns null for formats it cannot read, rather than guessing', () => {
    // AVIF and HEIC fall through to the host's browser decoder on purpose.
    expect(
      readImageSize(new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70])),
    ).toBeNull();
    expect(readImageSize(new Uint8Array(0))).toBeNull();
  });
});
