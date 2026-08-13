/**
 * Base64 over `Uint8Array`, implemented by hand.
 *
 * Every host has a faster native path — `Buffer` in Node, `atob`/`btoa` in a
 * browser — but they are different paths, and this package is the half of the
 * host logic that both share. Node's global `atob` is also marked legacy, so
 * reaching for it would trade a platform split for a deprecation. The cost is
 * a few tens of milliseconds per megabyte, against network fetches measured in
 * hundreds.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const LOOKUP = /* @__PURE__ */ (() => {
  const table = new Uint8Array(256).fill(255);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function toBase64(bytes: Uint8Array): string {
  let out = '';

  // Chunked so the intermediate string never becomes a rope of millions of
  // one-character concatenations, which is where the naive version falls over.
  let chunk = '';
  let i = 0;

  for (; i + 2 < bytes.length; i += 3) {
    const triple = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    chunk +=
      ALPHABET[(triple >> 18) & 63]! +
      ALPHABET[(triple >> 12) & 63]! +
      ALPHABET[(triple >> 6) & 63]! +
      ALPHABET[triple & 63]!;

    if (chunk.length >= 8192) {
      out += chunk;
      chunk = '';
    }
  }

  const remaining = bytes.length - i;
  if (remaining === 1) {
    const value = bytes[i]! << 16;
    chunk += `${ALPHABET[(value >> 18) & 63]}${ALPHABET[(value >> 12) & 63]}==`;
  } else if (remaining === 2) {
    const value = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    chunk += `${ALPHABET[(value >> 18) & 63]}${ALPHABET[(value >> 12) & 63]}${ALPHABET[(value >> 6) & 63]}=`;
  }

  return out + chunk;
}

export function fromBase64(text: string): Uint8Array {
  // Tolerate URL-safe input and embedded whitespace; both turn up in data URLs
  // copied out of stylesheets.
  const clean = text.replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean.replace(/=+$/, '');

  const out = new Uint8Array(Math.floor((padded.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < padded.length; i++) {
    const value = LOOKUP[padded.charCodeAt(i)]!;
    if (value === 255) continue; // Not base64; skipping matches browser behaviour.

    buffer = (buffer << 6) | value;
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >> bits) & 0xff;
    }
  }

  return outIndex === out.length ? out : out.subarray(0, outIndex);
}
