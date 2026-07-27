import type { ImageScaleMode, Paint } from '@h2f/schema';
import type { AssetRegistry } from '../assets.js';
import { isTransparent, parseColor } from './color.js';
import { splitTopLevel, splitWhitespace, toPixels } from './css-values.js';
import { isGradient, parseGradient, parsePosition, type Box } from './gradient.js';

export interface BackgroundResult {
  paints: Paint[];
  /** Background layers that could not be converted, e.g. `element()`. */
  unsupported: string[];
}

/**
 * Convert `background-color` and the `background-image` layer list into IR
 * paints.
 *
 * The one subtlety that matters: CSS paints the *first* background layer on top
 * and Figma paints the *last* fill on top, so the layer list is reversed.
 * Getting this backwards silently hides every gradient that sits over an image.
 */
export function parseBackground(
  style: CSSStyleDeclaration,
  box: Box,
  assets: AssetRegistry,
): BackgroundResult {
  const paints: Paint[] = [];
  const unsupported: string[] = [];

  const color = parseColor(style.backgroundColor);
  if (!isTransparent(color)) {
    paints.push({ kind: 'SOLID', color, opacity: 1 });
  }

  const image = style.backgroundImage;
  if (image && image !== 'none') {
    const layers = splitTopLevel(image);
    const sizes = splitTopLevel(style.backgroundSize || 'auto');
    const positions = splitTopLevel(style.backgroundPosition || '0% 0%');
    const repeats = splitTopLevel(style.backgroundRepeat || 'repeat');

    // Reverse so the CSS-topmost layer ends up last, i.e. topmost in Figma.
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]!;
      const paint = parseLayer(
        layer,
        box,
        assets,
        cyclic(sizes, i),
        cyclic(positions, i),
        cyclic(repeats, i),
      );
      if (paint) paints.push(paint);
      else if (layer !== 'none') unsupported.push(layer.slice(0, 40));
    }
  }

  return { paints, unsupported };
}

function parseLayer(
  layer: string,
  box: Box,
  assets: AssetRegistry,
  size: string,
  position: string,
  repeat: string,
): Paint | null {
  const value = layer.trim();
  if (value === 'none' || value === '') return null;

  if (isGradient(value)) {
    return parseGradient(value, box);
  }

  if (/^url\(/i.test(value)) {
    // Background images are fetched at the box's rendered size at minimum; the
    // host may find a larger intrinsic size and keep that instead.
    const ref = assets.addPending(value, Math.ceil(box.width), Math.ceil(box.height));
    if (!ref) return null;
    return {
      kind: 'IMAGE',
      asset: ref,
      scaleMode: backgroundScaleMode(size, repeat),
      opacity: 1,
      ...cropGeometry(size, position, repeat, box),
    };
  }

  // `image-set()` resolves to a single URL in computed style in Chromium, so
  // reaching here means something genuinely exotic (`element()`, `paint()`).
  return null;
}

function backgroundScaleMode(size: string, repeat: string): ImageScaleMode {
  const normalizedRepeat = repeat.trim().toLowerCase();
  const normalizedSize = size.trim().toLowerCase();

  if (normalizedSize === 'cover') return 'FILL';
  if (normalizedSize === 'contain') return 'FIT';

  const repeats = normalizedRepeat !== 'no-repeat' && normalizedRepeat !== 'no-repeat no-repeat';
  if (repeats) return 'TILE';

  // A single non-repeating image at an explicit or intrinsic size. FIT keeps
  // the whole image visible, which is almost always the intent.
  return 'FIT';
}

/**
 * Figma tile paints take a scaling factor rather than a size, and crop paints
 * take a normalized offset. Only fill in what the chosen scale mode uses.
 */
function cropGeometry(
  size: string,
  position: string,
  repeat: string,
  box: Box,
): { scalingFactor?: number; offset?: { x: number; y: number } } {
  const mode = backgroundScaleMode(size, repeat);
  if (mode !== 'TILE') {
    const pos = parsePosition(position, box);
    return { offset: pos };
  }

  const tokens = splitWhitespace(size).filter(Boolean);
  const width = tokens[0] ? toPixels(tokens[0], box.width) : null;
  if (width === null || width <= 0 || box.width <= 0) return { scalingFactor: 1 };
  return { scalingFactor: width / box.width };
}

/** CSS repeats shorter background sub-lists to match the layer count. */
function cyclic(list: string[], index: number): string {
  if (list.length === 0) return '';
  return list[index % list.length]!;
}
