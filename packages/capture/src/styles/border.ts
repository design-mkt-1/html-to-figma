import type { Corners, Rgba, Stroke } from '@h2f/schema';
import { isTransparent, parseColor } from './color.js';
import { splitWhitespace, toPixels } from './css-values.js';

export interface BorderResult {
  stroke: Stroke | null;
  /** True when sides disagree on colour and only one could be kept. */
  mixedColors: boolean;
}

type Side = 'Top' | 'Right' | 'Bottom' | 'Left';
const SIDES: Side[] = ['Top', 'Right', 'Bottom', 'Left'];

/**
 * Convert CSS borders into a single IR stroke.
 *
 * Figma allows per-side stroke *weights* but only one stroke *paint*. When
 * sides disagree on colour the thickest visible side wins and the caller is
 * told, so it can decide whether the element is worth rasterizing.
 */
export function parseBorder(style: CSSStyleDeclaration): BorderResult {
  const weights = { top: 0, right: 0, bottom: 0, left: 0 };
  const colors: Array<{ color: Rgba; weight: number }> = [];
  let dashPattern: number[] = [];

  for (const side of SIDES) {
    const lineStyle = style.getPropertyValue(`border-${side.toLowerCase()}-style`);
    if (!lineStyle || lineStyle === 'none' || lineStyle === 'hidden') continue;

    const width = toPixels(style.getPropertyValue(`border-${side.toLowerCase()}-width`), 0) ?? 0;
    if (width <= 0) continue;

    const color = parseColor(style.getPropertyValue(`border-${side.toLowerCase()}-color`));
    if (isTransparent(color)) continue;

    weights[side.toLowerCase() as Lowercase<Side>] = width;
    colors.push({ color, weight: width });

    if (dashPattern.length === 0) {
      dashPattern = dashPatternFor(lineStyle, width);
    }
  }

  const total = weights.top + weights.right + weights.bottom + weights.left;
  if (total === 0 || colors.length === 0) {
    return { stroke: null, mixedColors: false };
  }

  // Thickest side wins; ties go to the first, which is the top edge.
  const dominant = colors.reduce((a, b) => (b.weight > a.weight ? b : a));
  const mixedColors = colors.some((c) => !sameColor(c.color, dominant.color));

  return {
    stroke: {
      paints: [{ kind: 'SOLID', color: dominant.color, opacity: 1 }],
      weights,
      align: 'INSIDE',
      dashPattern,
    },
    mixedColors,
  };
}

function dashPatternFor(lineStyle: string, width: number): number[] {
  switch (lineStyle) {
    case 'dashed':
      // Chromium draws dashes at roughly 3x the border width.
      return [width * 3, width * 3];
    case 'dotted':
      return [width, width];
    default:
      // `double`, `groove`, `ridge`, `inset` and `outset` all collapse to a
      // solid line; they are rare enough that a dedicated approximation would
      // cost more than it returns.
      return [];
  }
}

function sameColor(a: Rgba, b: Rgba): boolean {
  return (
    Math.abs(a.r - b.r) < 0.004 &&
    Math.abs(a.g - b.g) < 0.004 &&
    Math.abs(a.b - b.b) < 0.004 &&
    Math.abs(a.a - b.a) < 0.004
  );
}

export interface CornerResult {
  corners: Corners;
  /** True when any corner used two different radii (an elliptical corner). */
  elliptical: boolean;
}

/**
 * Read `border-radius` into four scalar corner radii.
 *
 * Two CSS behaviours have to be reproduced here or shapes come out wrong:
 * elliptical corners (which Figma cannot represent) collapse to their smaller
 * radius, and oversized radii are scaled down by the CSS overlap rule — without
 * which `border-radius: 9999px` would produce a 9999px corner instead of a pill.
 */
export function parseCorners(style: CSSStyleDeclaration, width: number, height: number): CornerResult {
  let elliptical = false;

  const read = (property: string, reference: number): number => {
    const raw = style.getPropertyValue(property);
    if (!raw) return 0;
    const parts = splitWhitespace(raw).filter(Boolean);
    if (parts.length === 0) return 0;

    const rx = toPixels(parts[0]!, reference) ?? 0;
    if (parts.length === 1) return Math.max(0, rx);

    const ry = toPixels(parts[1]!, height) ?? rx;
    if (Math.abs(rx - ry) > 0.5) elliptical = true;
    return Math.max(0, Math.min(rx, ry));
  };

  const corners: Corners = [
    read('border-top-left-radius', width),
    read('border-top-right-radius', width),
    read('border-bottom-right-radius', width),
    read('border-bottom-left-radius', width),
  ];

  return { corners: clampCorners(corners, width, height), elliptical };
}

/**
 * CSS scales all radii by a single factor when any pair overflows its side.
 * https://www.w3.org/TR/css-backgrounds-3/#corner-overlap
 */
function clampCorners(corners: Corners, width: number, height: number): Corners {
  const [tl, tr, br, bl] = corners;
  if (width <= 0 || height <= 0) return [0, 0, 0, 0];

  const ratios = [
    tl + tr > 0 ? width / (tl + tr) : Infinity,
    br + bl > 0 ? width / (br + bl) : Infinity,
    tr + br > 0 ? height / (tr + br) : Infinity,
    bl + tl > 0 ? height / (bl + tl) : Infinity,
  ];

  const factor = Math.min(1, ...ratios);
  if (factor >= 1) return corners;
  return [tl * factor, tr * factor, br * factor, bl * factor];
}
