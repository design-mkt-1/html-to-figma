import type { Rgba } from '@h2f/schema';

export const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

/**
 * Parse a CSS color into straight RGBA.
 *
 * `getComputedStyle` already serializes almost everything to `rgb()` /
 * `rgba()`, so the fast path handles the overwhelming majority. Newer colour
 * spaces (`oklch`, `lab`, `color(display-p3 …)`) are serialized as-is by
 * Chromium, so those fall through to `normalizeViaCanvas`, which lets the
 * browser do the conversion for us rather than reimplementing four colour
 * spaces by hand.
 */
export function parseColor(input: string | null | undefined): Rgba {
  if (!input) return TRANSPARENT;
  const value = input.trim();
  if (value === '' || value === 'none' || value === 'transparent') return TRANSPARENT;

  const fast = parseRgbFunction(value);
  if (fast) return fast;

  if (value.startsWith('#')) {
    const hex = parseHex(value);
    if (hex) return hex;
  }

  return normalizeViaCanvas(value);
}

const RGB_RE = /^rgba?\(([^)]+)\)$/i;

function parseRgbFunction(value: string): Rgba | null {
  const match = RGB_RE.exec(value);
  if (!match) return null;

  // Both legacy `rgb(1, 2, 3)` and modern `rgb(1 2 3 / 0.5)` syntax.
  const parts = match[1]!.replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;

  const r = channel(parts[0]!);
  const g = channel(parts[1]!);
  const b = channel(parts[2]!);
  const a = parts.length > 3 ? alpha(parts[3]!) : 1;
  if (r === null || g === null || b === null) return null;

  return { r, g, b, a };
}

/** Accepts `255` or `100%`, returns 0..1. */
function channel(token: string): number | null {
  if (token.endsWith('%')) {
    const pct = Number.parseFloat(token);
    return Number.isFinite(pct) ? clamp01(pct / 100) : null;
  }
  const n = Number.parseFloat(token);
  return Number.isFinite(n) ? clamp01(n / 255) : null;
}

function alpha(token: string): number {
  if (token.endsWith('%')) {
    const pct = Number.parseFloat(token);
    return Number.isFinite(pct) ? clamp01(pct / 100) : 1;
  }
  const n = Number.parseFloat(token);
  return Number.isFinite(n) ? clamp01(n) : 1;
}

function parseHex(value: string): Rgba | null {
  const hex = value.slice(1);
  const expand = (c: string) => Number.parseInt(c + c, 16) / 255;
  const pair = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16) / 255;

  switch (hex.length) {
    case 3:
      return { r: expand(hex[0]!), g: expand(hex[1]!), b: expand(hex[2]!), a: 1 };
    case 4:
      return {
        r: expand(hex[0]!),
        g: expand(hex[1]!),
        b: expand(hex[2]!),
        a: expand(hex[3]!),
      };
    case 6:
      return { r: pair(0), g: pair(2), b: pair(4), a: 1 };
    case 8:
      return { r: pair(0), g: pair(2), b: pair(4), a: pair(6) };
    default:
      return null;
  }
}

let normalizeCtx: CanvasRenderingContext2D | null | undefined;

/**
 * Last resort for colour syntaxes we do not parse: paint a single pixel with
 * the browser's own colour engine and read it back.
 *
 * Canvas composites onto a transparent black backdrop, so the pixel comes back
 * premultiplied and we have to undo that to recover the straight alpha the IR
 * expects.
 */
function normalizeViaCanvas(value: string): Rgba {
  if (normalizeCtx === undefined) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      normalizeCtx = canvas.getContext('2d', { willReadFrequently: true });
    } catch {
      normalizeCtx = null;
    }
  }
  if (!normalizeCtx) return TRANSPARENT;

  try {
    normalizeCtx.clearRect(0, 0, 1, 1);
    normalizeCtx.fillStyle = '#000';
    normalizeCtx.fillStyle = value;
    // An unparseable value leaves fillStyle at the previous one; detecting that
    // is not worth the complexity, a black pixel is an acceptable failure.
    normalizeCtx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = normalizeCtx.getImageData(0, 0, 1, 1).data;
    const alphaRatio = a / 255;
    if (alphaRatio === 0) return TRANSPARENT;
    return {
      r: clamp01(r / 255 / alphaRatio),
      g: clamp01(g / 255 / alphaRatio),
      b: clamp01(b / 255 / alphaRatio),
      a: clamp01(alphaRatio),
    };
  } catch {
    return TRANSPARENT;
  }
}

export function isTransparent(color: Rgba): boolean {
  return color.a <= 0.001;
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
