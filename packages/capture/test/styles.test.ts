import { describe, expect, it } from 'vitest';
import { parseColor } from '../src/styles/color.js';
import { splitTopLevel, splitWhitespace, toDegrees, toPixels } from '../src/styles/css-values.js';
import { isGradient, parseGradient } from '../src/styles/gradient.js';
import { parseBoxShadow } from '../src/styles/effects.js';
import { analyzeTransform } from '../src/styles/transform.js';
import { parseFontWeight, isItalic } from '../src/styles/font.js';

const BOX = { width: 200, height: 100 };

describe('css value splitting', () => {
  it('does not split inside parentheses', () => {
    // The reason this helper exists: a naive split on "," destroys every
    // value containing an rgba() colour, which is nearly all of them.
    expect(splitTopLevel('rgba(0, 0, 0, 0.5) 0px 2px, rgb(1, 2, 3) 0px 4px')).toEqual([
      'rgba(0, 0, 0, 0.5) 0px 2px',
      'rgb(1, 2, 3) 0px 4px',
    ]);
  });

  it('splits on whitespace outside parentheses', () => {
    expect(splitWhitespace('blur(4px) drop-shadow(0 2px rgba(0, 0, 0, 1))')).toEqual([
      'blur(4px)',
      'drop-shadow(0 2px rgba(0, 0, 0, 1))',
    ]);
  });

  it('converts every CSS angle unit', () => {
    expect(toDegrees('90deg')).toBe(90);
    expect(toDegrees('0.5turn')).toBe(180);
    expect(toDegrees('100grad')).toBe(90);
    expect(toDegrees('3.14159rad')).toBeCloseTo(180, 2);
  });

  it('resolves percentages against the reference length', () => {
    expect(toPixels('50%', 200)).toBe(100);
    expect(toPixels('16px', 0)).toBe(16);
    expect(toPixels('12pt', 0)).toBe(16);
  });
});

describe('colour parsing', () => {
  it('parses legacy and modern rgb syntax', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor('rgba(0, 0, 255, 0.5)')).toEqual({ r: 0, g: 0, b: 1, a: 0.5 });
    expect(parseColor('rgb(255 0 0 / 50%)')).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
  });

  it('parses every hex length', () => {
    expect(parseColor('#f00')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor('#ff0000')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor('#ff000080').a).toBeCloseTo(0.502, 2);
  });

  it('treats absent and transparent values as fully transparent', () => {
    expect(parseColor('transparent').a).toBe(0);
    expect(parseColor('').a).toBe(0);
    expect(parseColor(null).a).toBe(0);
  });
});

describe('gradients', () => {
  it('recognises gradient functions', () => {
    expect(isGradient('linear-gradient(red, blue)')).toBe(true);
    expect(isGradient('repeating-radial-gradient(red, blue)')).toBe(true);
    expect(isGradient('url(x.png)')).toBe(false);
  });

  it('reads an explicit angle and evenly distributes bare stops', () => {
    const gradient = parseGradient('linear-gradient(90deg, rgb(255,0,0), rgb(0,0,255))', BOX)!;

    expect(gradient.gradientKind).toBe('LINEAR');
    expect(gradient.angle).toBe(90);
    expect(gradient.stops.map((s) => s.position)).toEqual([0, 1]);
  });

  it('defaults to `to bottom`', () => {
    expect(parseGradient('linear-gradient(red, blue)', BOX)!.angle).toBe(180);
  });

  it('maps side keywords to angles', () => {
    expect(parseGradient('linear-gradient(to right, red, blue)', BOX)!.angle).toBe(90);
    expect(parseGradient('linear-gradient(to top, red, blue)', BOX)!.angle).toBe(0);
  });

  it('resolves corner keywords against the box aspect ratio', () => {
    // A corner gradient is not 45°: the gradient line must be perpendicular to
    // the diagonal, so a 2:1 box gives a different angle than a square.
    const wide = parseGradient('linear-gradient(to top right, red, blue)', {
      width: 200,
      height: 100,
    })!;
    const square = parseGradient('linear-gradient(to top right, red, blue)', {
      width: 100,
      height: 100,
    })!;

    expect(square.angle).toBeCloseTo(45, 1);
    expect(wide.angle).toBeCloseTo(63.43, 1);
  });

  it('interpolates omitted interior stop positions', () => {
    const gradient = parseGradient('linear-gradient(red 0%, green, blue, white 100%)', BOX)!;

    expect(gradient.stops.map((s) => Math.round(s.position * 100))).toEqual([0, 33, 67, 100]);
  });

  it('expands a double-position stop into two stops', () => {
    const gradient = parseGradient('linear-gradient(red 20% 40%, blue)', BOX)!;
    const positions = gradient.stops.map((s) => Math.round(s.position * 100));

    expect(positions).toContain(20);
    expect(positions).toContain(40);
  });

  it('clamps decreasing stop positions', () => {
    const gradient = parseGradient('linear-gradient(red 60%, blue 20%)', BOX)!;
    const positions = gradient.stops.map((s) => s.position);

    expect(positions[1]).toBeGreaterThanOrEqual(positions[0]!);
  });

  it('unrolls a repeating gradient across the whole axis', () => {
    // Figma has no repeat mode, so the pattern is expanded instead.
    const gradient = parseGradient(
      'repeating-linear-gradient(90deg, red 0px, red 10px, blue 10px, blue 20px)',
      { width: 100, height: 100 },
    )!;

    expect(gradient.stops.length).toBeGreaterThan(4);
    expect(Math.max(...gradient.stops.map((s) => s.position))).toBeLessThanOrEqual(1);
  });

  it('reads radial position and shape', () => {
    const gradient = parseGradient('radial-gradient(circle at 25% 75%, red, blue)', BOX)!;

    expect(gradient.gradientKind).toBe('RADIAL');
    expect(gradient.center).toEqual({ x: 0.25, y: 0.75 });
  });

  it('reads a conic starting angle', () => {
    const gradient = parseGradient('conic-gradient(from 45deg, red, blue)', BOX)!;

    expect(gradient.gradientKind).toBe('CONIC');
    expect(gradient.angle).toBe(45);
  });

  it('ignores colour hints', () => {
    // `50%` on its own is an interpolation hint, not a stop; reading it as one
    // would insert a black stop in the middle of the gradient.
    const gradient = parseGradient('linear-gradient(red, 50%, blue)', BOX)!;
    expect(gradient.stops).toHaveLength(2);
  });
});

describe('box-shadow', () => {
  it('parses Chromium colour-first serialization', () => {
    const [shadow] = parseBoxShadow('rgba(0, 0, 0, 0.5) 2px 4px 8px 1px');

    expect(shadow).toMatchObject({
      kind: 'DROP_SHADOW',
      offset: { x: 2, y: 4 },
      radius: 8,
      spread: 1,
    });
    expect(shadow!.color.a).toBeCloseTo(0.5);
  });

  it('parses author colour-last order', () => {
    const [shadow] = parseBoxShadow('2px 4px 8px rgb(255, 0, 0)');
    expect(shadow).toMatchObject({ offset: { x: 2, y: 4 }, radius: 8 });
  });

  it('detects inset shadows', () => {
    const [shadow] = parseBoxShadow('rgba(0, 0, 0, 1) 0px 2px 4px 0px inset');
    expect(shadow!.kind).toBe('INNER_SHADOW');
  });

  it('parses a multi-layer shadow', () => {
    const shadows = parseBoxShadow(
      'rgba(0, 0, 0, 0.1) 0px 1px 2px 0px, rgba(0, 0, 0, 0.06) 0px 4px 8px 0px',
    );
    expect(shadows).toHaveLength(2);
  });

  it('drops fully transparent shadows', () => {
    expect(parseBoxShadow('rgba(0, 0, 0, 0) 0px 2px 4px')).toHaveLength(0);
    expect(parseBoxShadow('none')).toHaveLength(0);
  });
});

describe('transforms', () => {
  it('treats identity and translation as no transform', () => {
    expect(analyzeTransform('none').kind).toBe('NONE');
    // Translation is already baked into the measured rect.
    expect(analyzeTransform('matrix(1, 0, 0, 1, 40, 20)').kind).toBe('NONE');
  });

  it('decomposes a rotation', () => {
    const cos = Math.cos(Math.PI / 4);
    const sin = Math.sin(Math.PI / 4);
    const result = analyzeTransform(`matrix(${cos}, ${sin}, ${-sin}, ${cos}, 0, 0)`);

    expect(result.kind).toBe('ROTATE');
    expect(result.rotation).toBeCloseTo(45, 4);
  });

  it('decomposes a scale', () => {
    const result = analyzeTransform('matrix(2, 0, 0, 3, 0, 0)');

    expect(result.kind).toBe('ROTATE');
    expect(result.scaleX).toBeCloseTo(2);
    expect(result.scaleY).toBeCloseTo(3);
  });

  it('rejects skew, mirroring and 3D', () => {
    // These have no Figma equivalent, so the element must be rasterized rather
    // than reproduced incorrectly.
    expect(analyzeTransform('matrix(1, 0, 0.5, 1, 0, 0)').kind).toBe('UNSUPPORTED');
    expect(analyzeTransform('matrix(-1, 0, 0, 1, 0, 0)').kind).toBe('UNSUPPORTED');
    expect(analyzeTransform('matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0.002, 0,0,0,1)').kind).toBe(
      'UNSUPPORTED',
    );
  });

  it('rejects a degenerate matrix', () => {
    expect(analyzeTransform('matrix(0, 0, 0, 0, 0, 0)').kind).toBe('UNSUPPORTED');
  });
});

describe('font properties', () => {
  it('normalizes weights', () => {
    expect(parseFontWeight('bold')).toBe(700);
    expect(parseFontWeight('normal')).toBe(400);
    expect(parseFontWeight('437')).toBe(400);
    expect(parseFontWeight('650')).toBe(700);
    expect(parseFontWeight(undefined)).toBe(400);
  });

  it('detects italic and oblique', () => {
    expect(isItalic('italic')).toBe(true);
    expect(isItalic('oblique 10deg')).toBe(true);
    expect(isItalic('normal')).toBe(false);
  });
});
