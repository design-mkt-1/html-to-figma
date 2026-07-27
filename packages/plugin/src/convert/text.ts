import type { TextStyle as IrTextStyle } from '@h2f/schema';

/** Pure value mappings for text properties. */

export function toLineHeight(lineHeight: number | null): LineHeight {
  if (lineHeight === null || lineHeight <= 0) return { unit: 'AUTO' };
  return { value: lineHeight, unit: 'PIXELS' };
}

export function toLetterSpacing(letterSpacing: number): LetterSpacing {
  return { value: letterSpacing, unit: 'PIXELS' };
}

/**
 * The style properties that apply to a whole node or a range, in the order they
 * must be applied.
 *
 * Order matters: `setRangeFontName` resets nothing, but changing the font after
 * a size or spacing has been set can reflow the layer, so the font always goes
 * first.
 */
export interface ResolvedTextStyle {
  fontName: FontName;
  fontSize: number;
  lineHeight: LineHeight;
  letterSpacing: LetterSpacing;
  textDecoration: TextDecoration;
  textCase: TextCase;
}

export function resolveStyle(style: IrTextStyle, fontName: FontName): ResolvedTextStyle {
  return {
    fontName,
    // Figma rejects a font size below 1; CSS happily renders 0.
    fontSize: Math.max(1, style.size),
    lineHeight: toLineHeight(style.lineHeight),
    letterSpacing: toLetterSpacing(style.letterSpacing),
    textDecoration: style.decoration,
    textCase: style.textCase,
  };
}

/**
 * Merge a segment's partial style over the node's base style.
 *
 * Segments only carry the properties that differ, which keeps capture files
 * small but means the base has to be filled back in before the values can be
 * used.
 */
export function mergeStyle(base: IrTextStyle, partial: Partial<IrTextStyle>): IrTextStyle {
  return {
    family: partial.family ?? base.family,
    weight: partial.weight ?? base.weight,
    italic: partial.italic ?? base.italic,
    size: partial.size ?? base.size,
    lineHeight: partial.lineHeight !== undefined ? partial.lineHeight : base.lineHeight,
    letterSpacing: partial.letterSpacing ?? base.letterSpacing,
    fills: partial.fills ?? base.fills,
    decoration: partial.decoration ?? base.decoration,
    textCase: partial.textCase ?? base.textCase,
  };
}
