/**
 * Read intrinsic image dimensions straight from the file header.
 *
 * The alternative is decoding every asset in the browser, which for a
 * media-heavy page means hundreds of round trips through `page.evaluate` and a
 * base64 copy of every image in both directions. Parsing the handful of bytes
 * that actually carry the size keeps that path reserved for formats this cannot
 * read (AVIF, HEIC) and for images that genuinely need downscaling.
 *
 * Typed as `Uint8Array` rather than `Buffer` so the extension's service worker
 * can use it unchanged. A `Buffer` is a `Uint8Array`, so Node callers are
 * unaffected.
 */

export interface ImageSize {
  width: number;
  height: number;
  mimeType: string;
}

export function readImageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    png(bytes, view) ??
    gif(bytes, view) ??
    jpeg(bytes, view) ??
    webp(bytes, view) ??
    bmp(bytes, view)
  );
}

function png(b: Uint8Array, v: DataView): ImageSize | null {
  if (b.length < 24) return null;
  if (v.getUint32(0) !== 0x89504e47 || v.getUint32(4) !== 0x0d0a1a0a) return null;
  // The IHDR chunk is required to be first, so its offsets are fixed.
  return { width: v.getUint32(16), height: v.getUint32(20), mimeType: 'image/png' };
}

function gif(b: Uint8Array, v: DataView): ImageSize | null {
  if (b.length < 10) return null;
  if (ascii(b, 0, 3) !== 'GIF') return null;
  return { width: v.getUint16(6, true), height: v.getUint16(8, true), mimeType: 'image/gif' };
}

function bmp(b: Uint8Array, v: DataView): ImageSize | null {
  if (b.length < 26) return null;
  if (ascii(b, 0, 2) !== 'BM') return null;
  return {
    width: v.getInt32(18, true),
    // A negative height means a top-down bitmap; the magnitude is the size.
    height: Math.abs(v.getInt32(22, true)),
    mimeType: 'image/bmp',
  };
}

function jpeg(b: Uint8Array, v: DataView): ImageSize | null {
  if (b.length < 4 || v.getUint16(0) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      // Fill bytes are legal between segments; skip them rather than bailing.
      offset++;
      continue;
    }

    const marker = b[offset + 1]!;
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan — past this point is entropy-coded data, no more headers.
    if (marker === 0xda) break;

    const length = v.getUint16(offset + 2);
    if (length < 2) break;

    // SOF0..SOF15, excluding the DHT/JPG/DAC markers interleaved in that range.
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isFrameHeader) {
      return {
        height: v.getUint16(offset + 5),
        width: v.getUint16(offset + 7),
        mimeType: 'image/jpeg',
      };
    }

    offset += 2 + length;
  }

  return null;
}

function webp(b: Uint8Array, v: DataView): ImageSize | null {
  if (b.length < 30) return null;
  if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 12) !== 'WEBP') return null;

  const chunk = ascii(b, 12, 16);

  if (chunk === 'VP8 ') {
    // Lossy: dimensions live in the 10-byte frame header after the start code.
    return {
      width: v.getUint16(26, true) & 0x3fff,
      height: v.getUint16(28, true) & 0x3fff,
      mimeType: 'image/webp',
    };
  }

  if (chunk === 'VP8L') {
    // Lossless: 14 bits each, packed across four bytes.
    const bits = v.getUint32(21, true);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      mimeType: 'image/webp',
    };
  }

  if (chunk === 'VP8X') {
    // Extended: 24-bit little-endian, stored as size minus one.
    const width = (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1;
    const height = (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1;
    return { width, height, mimeType: 'image/webp' };
  }

  return null;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}
