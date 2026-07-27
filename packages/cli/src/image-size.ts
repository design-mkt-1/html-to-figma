/**
 * Read intrinsic image dimensions straight from the file header.
 *
 * The alternative is decoding every asset in the browser, which for a
 * media-heavy page means hundreds of round trips through `page.evaluate` and a
 * base64 copy of every image in both directions. Parsing the handful of bytes
 * that actually carry the size keeps that path reserved for formats this cannot
 * read (AVIF, HEIC) and for images that genuinely need downscaling.
 */

export interface ImageSize {
  width: number;
  height: number;
  mimeType: string;
}

export function readImageSize(bytes: Buffer): ImageSize | null {
  return png(bytes) ?? gif(bytes) ?? jpeg(bytes) ?? webp(bytes) ?? bmp(bytes);
}

function png(b: Buffer): ImageSize | null {
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  // The IHDR chunk is required to be first, so its offsets are fixed.
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), mimeType: 'image/png' };
}

function gif(b: Buffer): ImageSize | null {
  if (b.length < 10) return null;
  if (b.toString('ascii', 0, 3) !== 'GIF') return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), mimeType: 'image/gif' };
}

function bmp(b: Buffer): ImageSize | null {
  if (b.length < 26) return null;
  if (b.toString('ascii', 0, 2) !== 'BM') return null;
  return {
    width: b.readInt32LE(18),
    // A negative height means a top-down bitmap; the magnitude is the size.
    height: Math.abs(b.readInt32LE(22)),
    mimeType: 'image/bmp',
  };
}

function jpeg(b: Buffer): ImageSize | null {
  if (b.length < 4 || b.readUInt16BE(0) !== 0xffd8) return null;

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

    const length = b.readUInt16BE(offset + 2);
    if (length < 2) break;

    // SOF0..SOF15, excluding the DHT/JPG/DAC markers interleaved in that range.
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isFrameHeader) {
      return {
        height: b.readUInt16BE(offset + 5),
        width: b.readUInt16BE(offset + 7),
        mimeType: 'image/jpeg',
      };
    }

    offset += 2 + length;
  }

  return null;
}

function webp(b: Buffer): ImageSize | null {
  if (b.length < 30) return null;
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;

  const chunk = b.toString('ascii', 12, 16);

  if (chunk === 'VP8 ') {
    // Lossy: dimensions live in the 10-byte frame header after the start code.
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, mimeType: 'image/webp' };
  }

  if (chunk === 'VP8L') {
    // Lossless: 14 bits each, packed across four bytes.
    const bits = b.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
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
