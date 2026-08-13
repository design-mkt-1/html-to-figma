import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64 } from '../src/base64.js';

/**
 * Every image byte in a capture file goes through here, so "agrees with Node's
 * native implementation" is the only interesting property — including at the
 * padding lengths, which is where hand-rolled codecs go wrong.
 */

function randomBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = state & 0xff;
  }
  return out;
}

describe('base64', () => {
  it('matches Buffer for every remainder length', () => {
    for (let length = 0; length < 16; length++) {
      const bytes = randomBytes(length, length + 1);
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('matches Buffer across the internal chunk boundary', () => {
    const bytes = randomBytes(20_000, 7);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('round-trips', () => {
    const bytes = randomBytes(5_000, 13);
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('decodes what Buffer encodes, including unpadded and URL-safe input', () => {
    const bytes = randomBytes(10, 3);
    const standard = Buffer.from(bytes).toString('base64');

    expect(Array.from(fromBase64(standard))).toEqual(Array.from(bytes));
    expect(Array.from(fromBase64(standard.replace(/=+$/, '')))).toEqual(Array.from(bytes));
    expect(Array.from(fromBase64(Buffer.from(bytes).toString('base64url')))).toEqual(
      Array.from(bytes),
    );
  });

  it('ignores the whitespace that data URLs pick up when copied out of CSS', () => {
    const bytes = randomBytes(30, 5);
    const wrapped = Buffer.from(bytes)
      .toString('base64')
      .replace(/(.{8})/g, '$1\n  ');

    expect(Array.from(fromBase64(wrapped))).toEqual(Array.from(bytes));
  });
});
