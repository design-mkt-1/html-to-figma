import { describe, expect, it } from 'vitest';
import type { GradientPaint } from '@h2f/schema';
import { gradientTransform, toPaint, toPaints } from '../src/convert/paint.js';
import { toEffects } from '../src/convert/effects.js';
import { FontResolver, parseStyleName } from '../src/convert/font.js';
import { mergeStyle, toLineHeight } from '../src/convert/text.js';

const noImages = () => null;

describe('paint conversion', () => {
  it('moves colour alpha onto the paint, as Figma expects', () => {
    // CSS keeps alpha in the colour, Figma keeps it on the paint. Getting this
    // wrong makes every translucent overlay fully opaque.
    const paint = toPaint(
      { kind: 'SOLID', color: { r: 1, g: 0, b: 0, a: 0.5 }, opacity: 1 },
      noImages,
    ) as SolidPaint;

    expect(paint.color).toEqual({ r: 1, g: 0, b: 0 });
    expect(paint.opacity).toBeCloseTo(0.5);
  });

  it('multiplies colour alpha by paint opacity', () => {
    const paint = toPaint(
      { kind: 'SOLID', color: { r: 0, g: 0, b: 0, a: 0.5 }, opacity: 0.5 },
      noImages,
    ) as SolidPaint;

    expect(paint.opacity).toBeCloseTo(0.25);
  });

  it('drops an image paint whose asset never arrived', () => {
    const paints = toPaints(
      [
        { kind: 'IMAGE', asset: 'missing', scaleMode: 'FILL', opacity: 1 },
        { kind: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1 },
      ],
      noImages,
    );

    expect(paints).toHaveLength(1);
    expect(paints[0]!.type).toBe('SOLID');
  });

  it('resolves an image paint when the hash exists', () => {
    const paint = toPaint(
      { kind: 'IMAGE', asset: 'img:0', scaleMode: 'FIT', opacity: 1 },
      () => 'hash:1',
    ) as ImagePaint;

    expect(paint).toMatchObject({ type: 'IMAGE', imageHash: 'hash:1', scaleMode: 'FIT' });
  });

  it('duplicates a lone gradient stop so Figma accepts the paint', () => {
    const paint = toPaint(
      {
        kind: 'GRADIENT',
        gradientKind: 'LINEAR',
        stops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }],
        angle: 90,
        center: { x: 0.5, y: 0.5 },
        radius: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      noImages,
    ) as GradientPaint & { gradientStops: ColorStop[] };

    expect(paint.gradientStops).toHaveLength(2);
  });
});

describe('gradient transform', () => {
  function linear(angle: number): GradientPaint {
    return {
      kind: 'GRADIENT',
      gradientKind: 'LINEAR',
      stops: [
        { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
      ],
      angle,
      center: { x: 0.5, y: 0.5 },
      radius: { x: 0.5, y: 0.5 },
      opacity: 1,
    };
  }

  /**
   * The transform maps normalized layer coordinates to the gradient parameter
   * `t`. Checking the corners is the direct way to verify it: for a
   * left-to-right gradient, the left edge must be t=0 and the right edge t=1.
   */
  function paramAt(transform: Transform, x: number, y: number): number {
    const [row] = transform;
    return row[0] * x + row[1] * y + row[2];
  }

  it('maps a 90deg gradient left-to-right', () => {
    const transform = gradientTransform(linear(90));

    expect(paramAt(transform, 0, 0.5)).toBeCloseTo(0, 5);
    expect(paramAt(transform, 1, 0.5)).toBeCloseTo(1, 5);
  });

  it('maps a 180deg gradient top-to-bottom', () => {
    const transform = gradientTransform(linear(180));

    expect(paramAt(transform, 0.5, 0)).toBeCloseTo(0, 5);
    expect(paramAt(transform, 0.5, 1)).toBeCloseTo(1, 5);
  });

  it('maps a 0deg gradient bottom-to-top', () => {
    const transform = gradientTransform(linear(0));

    expect(paramAt(transform, 0.5, 1)).toBeCloseTo(0, 5);
    expect(paramAt(transform, 0.5, 0)).toBeCloseTo(1, 5);
  });

  it('keeps the centre at t=0.5 for a diagonal gradient', () => {
    expect(paramAt(gradientTransform(linear(45)), 0.5, 0.5)).toBeCloseTo(0.5, 5);
  });

  it('places a radial gradient centre and radius', () => {
    const transform = gradientTransform({
      ...linear(0),
      gradientKind: 'RADIAL',
      center: { x: 0.25, y: 0.75 },
      radius: { x: 0.25, y: 0.5 },
    });

    // The gradient's centre must map to the unit circle's centre.
    expect(transform[0]![0] * 0.25 + transform[0]![2]!).toBeCloseTo(0.5, 5);
    expect(transform[1]![1] * 0.75 + transform[1]![2]!).toBeCloseTo(0.5, 5);
  });
});

describe('effects', () => {
  it('keeps a drop shadow visible behind a translucent layer', () => {
    // CSS always paints the shadow behind the box; Figma hides it by default.
    const [effect] = toEffects([
      {
        kind: 'DROP_SHADOW',
        color: { r: 0, g: 0, b: 0, a: 0.5 },
        offset: { x: 0, y: 2 },
        radius: 4,
        spread: 0,
      },
    ]);

    expect(effect).toMatchObject({ type: 'DROP_SHADOW', showShadowBehindNode: true });
  });

  it('tags blurs as normal rather than progressive', () => {
    const [effect] = toEffects([{ kind: 'LAYER_BLUR', radius: 8 }]);
    expect(effect).toMatchObject({ type: 'LAYER_BLUR', blurType: 'NORMAL', radius: 8 });
  });
});

describe('font style names', () => {
  it('reads weight and slant out of a style name', () => {
    expect(parseStyleName('Regular')).toEqual({ weight: 400, italic: false });
    expect(parseStyleName('Bold')).toEqual({ weight: 700, italic: false });
    expect(parseStyleName('Italic')).toEqual({ weight: 400, italic: true });
    expect(parseStyleName('Bold Italic')).toEqual({ weight: 700, italic: true });
  });

  it('does not read "SemiBold" as "Bold"', () => {
    // Substring matching in the wrong order turns every 600 into a 700.
    expect(parseStyleName('SemiBold').weight).toBe(600);
    expect(parseStyleName('Semi Bold').weight).toBe(600);
    expect(parseStyleName('DemiBold').weight).toBe(600);
    expect(parseStyleName('ExtraBold').weight).toBe(800);
  });

  it('handles foundry spelling variants', () => {
    expect(parseStyleName('Extra Light').weight).toBe(200);
    expect(parseStyleName('ultra-light').weight).toBe(200);
    expect(parseStyleName('Book').weight).toBe(400);
    expect(parseStyleName('Black').weight).toBe(900);
  });

  it('falls back to a numeric style name', () => {
    expect(parseStyleName('300').weight).toBe(300);
  });
});

describe('font resolution', () => {
  const available = [
    { family: 'Inter', style: 'Regular' },
    { family: 'Inter', style: 'Medium' },
    { family: 'Inter', style: 'Bold' },
    { family: 'Inter', style: 'Italic' },
    { family: 'Roboto Mono', style: 'Regular' },
  ];

  it('matches a family case-insensitively', () => {
    const resolver = new FontResolver(available);
    const result = resolver.resolve({ family: 'inter', weight: 700, italic: false });

    expect(result).toEqual({ fontName: { family: 'Inter', style: 'Bold' }, substituted: false });
  });

  it('picks the closest available weight', () => {
    const resolver = new FontResolver(available);
    // No 600 exists; 500 is closer than 700.
    const result = resolver.resolve({ family: 'Inter', weight: 600, italic: false });

    expect(result.fontName.style).toBe('Medium');
  });

  it('prefers matching the slant over matching the weight', () => {
    // A roman face where an italic was asked for is far more obvious than a
    // weight being one step off.
    const resolver = new FontResolver(available);
    const result = resolver.resolve({ family: 'Inter', weight: 700, italic: true });

    expect(result.fontName.style).toBe('Italic');
  });

  it('substitutes an unknown family and flags it', () => {
    const resolver = new FontResolver(available);
    const result = resolver.resolve({ family: 'Proprietary Display', weight: 400, italic: false });

    expect(result.substituted).toBe(true);
    expect(result.fontName.family).toBe('Inter');
  });

  it('deduplicates the preload list', () => {
    const resolver = new FontResolver(available);
    const { fonts, missing } = resolver.resolveAll([
      { family: 'Inter', weight: 400, italic: false },
      { family: 'Inter', weight: 400, italic: false },
      { family: 'Inter', weight: 700, italic: false },
      { family: 'Missing', weight: 400, italic: false },
    ]);

    expect(fonts).toHaveLength(2);
    expect(missing).toEqual(['Missing']);
  });
});

describe('text style merging', () => {
  const base = {
    family: 'Inter',
    weight: 400,
    italic: false,
    size: 16,
    lineHeight: 24,
    letterSpacing: 0,
    fills: [],
    decoration: 'NONE' as const,
    textCase: 'ORIGINAL' as const,
  };

  it('overlays only the properties a segment carries', () => {
    const merged = mergeStyle(base, { weight: 700 });

    expect(merged.weight).toBe(700);
    expect(merged.family).toBe('Inter');
    expect(merged.size).toBe(16);
  });

  it('lets a segment set lineHeight back to auto', () => {
    // `null` is a real value here, not an absent one, so `??` would lose it.
    expect(mergeStyle(base, { lineHeight: null }).lineHeight).toBeNull();
  });

  it('maps a null line height to AUTO', () => {
    expect(toLineHeight(null)).toEqual({ unit: 'AUTO' });
    expect(toLineHeight(24)).toEqual({ value: 24, unit: 'PIXELS' });
  });
});
