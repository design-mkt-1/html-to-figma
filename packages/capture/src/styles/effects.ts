import type { Effect, ShadowEffect } from '@h2f/schema';
import { isTransparent, parseColor } from './color.js';
import { parseFunction, splitTopLevel, splitWhitespace, toPixels } from './css-values.js';

export interface EffectResult {
  effects: Effect[];
  /** Filter functions with no Figma equivalent, e.g. `saturate`, `hue-rotate`. */
  unsupportedFilters: string[];
}

/**
 * Convert `box-shadow`, `filter` and `backdrop-filter` into IR effects.
 *
 * Figma applies effects in list order, same as CSS, so the order is preserved.
 * Filters that have no equivalent are reported rather than silently dropped —
 * the caller decides whether to rasterize the element or accept the loss.
 */
export function parseEffects(style: CSSStyleDeclaration): EffectResult {
  const effects: Effect[] = [];
  const unsupportedFilters: string[] = [];

  for (const shadow of parseBoxShadow(style.boxShadow)) {
    effects.push(shadow);
  }

  parseFilterList(style.filter, effects, unsupportedFilters, 'LAYER_BLUR');
  parseFilterList(style.backdropFilter, effects, unsupportedFilters, 'BACKGROUND_BLUR');

  return { effects, unsupportedFilters };
}

// ---------------------------------------------------------------------------
// box-shadow
// ---------------------------------------------------------------------------

export function parseBoxShadow(value: string | null | undefined): ShadowEffect[] {
  if (!value || value === 'none') return [];

  const out: ShadowEffect[] = [];

  for (const layer of splitTopLevel(value)) {
    const tokens = splitWhitespace(layer).filter(Boolean);
    if (tokens.length === 0) continue;

    let inset = false;
    const lengths: string[] = [];
    let colorToken: string | null = null;

    // Chromium serializes the colour first, but authored order puts it last.
    // Classifying each token by shape rather than position handles both.
    for (const token of tokens) {
      if (token.toLowerCase() === 'inset') {
        inset = true;
      } else if (/^[-+.\d]/.test(token)) {
        lengths.push(token);
      } else {
        colorToken = token;
      }
    }

    if (lengths.length < 2) continue;

    const color = colorToken ? parseColor(colorToken) : { r: 0, g: 0, b: 0, a: 1 };
    if (isTransparent(color)) continue;

    out.push({
      kind: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color,
      offset: { x: toPixels(lengths[0]!, 0) ?? 0, y: toPixels(lengths[1]!, 0) ?? 0 },
      radius: lengths[2] ? Math.max(0, toPixels(lengths[2], 0) ?? 0) : 0,
      spread: lengths[3] ? (toPixels(lengths[3], 0) ?? 0) : 0,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// filter / backdrop-filter
// ---------------------------------------------------------------------------

function parseFilterList(
  value: string | null | undefined,
  effects: Effect[],
  unsupported: string[],
  blurKind: 'LAYER_BLUR' | 'BACKGROUND_BLUR',
): void {
  if (!value || value === 'none') return;

  for (const item of splitWhitespace(value)) {
    const fn = parseFunction(item);
    if (!fn) continue;

    switch (fn.name) {
      case 'blur': {
        const radius = toPixels(fn.args, 0) ?? 0;
        // CSS blur radius is a Gaussian sigma; Figma's is a diameter-like
        // value that reads about twice as strong at the same number.
        if (radius > 0) effects.push({ kind: blurKind, radius: radius * 2 });
        break;
      }
      case 'drop-shadow': {
        // Only meaningful on `filter`; on `backdrop-filter` it has no Figma
        // equivalent at all.
        if (blurKind !== 'LAYER_BLUR') {
          unsupported.push(fn.name);
          break;
        }
        const shadow = parseDropShadow(fn.args);
        if (shadow) effects.push(shadow);
        break;
      }
      case 'opacity':
        // Handled by the node's own opacity, nothing to add here.
        break;
      case 'none':
        break;
      default:
        unsupported.push(fn.name);
    }
  }
}

function parseDropShadow(args: string): ShadowEffect | null {
  const tokens = splitWhitespace(args).filter(Boolean);
  const lengths: string[] = [];
  let colorToken: string | null = null;

  for (const token of tokens) {
    if (/^[-+.\d]/.test(token)) lengths.push(token);
    else colorToken = token;
  }
  if (lengths.length < 2) return null;

  const color = colorToken ? parseColor(colorToken) : { r: 0, g: 0, b: 0, a: 1 };
  if (isTransparent(color)) return null;

  return {
    kind: 'DROP_SHADOW',
    color,
    offset: { x: toPixels(lengths[0]!, 0) ?? 0, y: toPixels(lengths[1]!, 0) ?? 0 },
    // `filter: drop-shadow()` takes a sigma, like `blur()`.
    radius: lengths[2] ? Math.max(0, (toPixels(lengths[2], 0) ?? 0) * 2) : 0,
    spread: 0,
  };
}
