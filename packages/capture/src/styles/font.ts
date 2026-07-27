import { splitTopLevel } from './css-values.js';

/**
 * CSS generic families. These never name a real font file, so they are skipped
 * when working out which family actually rendered.
 */
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
  '-apple-system',
  'blinkmacsystemfont',
]);

/** What a generic family should become once it reaches Figma. */
const GENERIC_FALLBACK: Record<string, string> = {
  serif: 'Times New Roman',
  'ui-serif': 'Times New Roman',
  'sans-serif': 'Inter',
  'system-ui': 'Inter',
  'ui-sans-serif': 'Inter',
  '-apple-system': 'Inter',
  blinkmacsystemfont: 'Inter',
  monospace: 'Roboto Mono',
  'ui-monospace': 'Roboto Mono',
  cursive: 'Inter',
  fantasy: 'Inter',
  'ui-rounded': 'Inter',
  math: 'Inter',
  emoji: 'Inter',
  fangsong: 'Inter',
};

const NAMED_WEIGHTS: Record<string, number> = {
  normal: 400,
  bold: 700,
  lighter: 300,
  bolder: 700,
};

export function parseFontWeight(value: string | null | undefined): number {
  if (!value) return 400;
  const named = NAMED_WEIGHTS[value.trim().toLowerCase()];
  if (named !== undefined) return named;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 400;
  // Round to the nearest standard weight; Figma has no 437.
  return Math.min(900, Math.max(100, Math.round(n / 100) * 100));
}

export function isItalic(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('italic') || normalized.startsWith('oblique');
}

/**
 * Work out which family in a font stack actually rendered the given text.
 *
 * The computed `font-family` is the whole stack, and only the browser knows
 * which entry won. `document.fonts.check` asks it directly, per family, which
 * is far more accurate than assuming the first entry — a page listing
 * `"Custom Font", Arial, sans-serif` where the webfont failed to load would
 * otherwise be captured with the wrong family everywhere.
 */
export function resolveFamily(
  stack: string | null | undefined,
  weight: number,
  italic: boolean,
  size: number,
  sample: string,
): string {
  const families = splitTopLevel(stack ?? '')
    .map((f) => f.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);

  if (families.length === 0) return 'Inter';

  const style = italic ? 'italic' : 'normal';
  // A short sample is enough and keeps the check cheap on long paragraphs.
  const probe = sample.slice(0, 16) || 'A';

  for (const family of families) {
    const key = family.toLowerCase();
    if (GENERIC_FAMILIES.has(key)) {
      return GENERIC_FALLBACK[key] ?? 'Inter';
    }
    if (canRender(style, weight, size, family, probe)) {
      return family;
    }
  }

  // Nothing in the stack reported as usable — keep the author's first choice so
  // the plugin's font matching still has a real name to work with.
  const first = families[0]!;
  return GENERIC_FALLBACK[first.toLowerCase()] ?? first;
}

function canRender(
  style: string,
  weight: number,
  size: number,
  family: string,
  sample: string,
): boolean {
  try {
    return document.fonts.check(`${style} ${weight} ${size}px "${cssEscape(family)}"`, sample);
  } catch {
    // `fonts.check` throws on a font shorthand it cannot parse; treating that
    // as "available" keeps the author's family rather than skipping to a
    // fallback on a syntax technicality.
    return true;
  }
}

function cssEscape(family: string): string {
  return family.replace(/["\\]/g, '\\$&');
}
