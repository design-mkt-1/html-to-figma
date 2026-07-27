import { describe, expect, it } from 'vitest';
import { inferLayout, type LayoutChild } from '../src/layout.js';

/**
 * Layout inference reads only a handful of properties off the computed style,
 * so a plain object stands in for `CSSStyleDeclaration` here. That keeps these
 * tests in Node with no browser, which matters because this is the logic most
 * likely to regress.
 */
function style(overrides: Record<string, string> = {}): CSSStyleDeclaration {
  return {
    display: 'block',
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    ...overrides,
  } as unknown as CSSStyleDeclaration;
}

function child(
  x: number,
  y: number,
  width: number,
  height: number,
  overrides: Partial<LayoutChild> = {},
): LayoutChild {
  return {
    rect: { x, y, width, height },
    outOfFlow: false,
    grow: 0,
    stretches: false,
    ...overrides,
  };
}

describe('axis selection', () => {
  it('follows flex-direction', () => {
    const children = [child(0, 0, 50, 50), child(60, 0, 50, 50)];
    const result = inferLayout(
      style({ display: 'flex', flexDirection: 'row' }),
      children,
      { width: 110, height: 50 },
      true,
    );

    expect(result.layout.mode).toBe('HORIZONTAL');
  });

  it('infers a column for a flex column', () => {
    const children = [child(0, 0, 50, 50), child(0, 60, 50, 50)];
    const result = inferLayout(
      style({ display: 'flex', flexDirection: 'column' }),
      children,
      { width: 50, height: 110 },
      true,
    );

    expect(result.layout.mode).toBe('VERTICAL');
  });

  it('infers the axis of a grid from where its children actually landed', () => {
    // Figma has no grid, so the only useful question is which single axis, if
    // any, the grid resolved to.
    const children = [child(0, 0, 50, 50), child(60, 0, 50, 50), child(120, 0, 50, 50)];
    const result = inferLayout(
      style({ display: 'grid' }),
      children,
      { width: 170, height: 50 },
      true,
    );

    expect(result.layout.mode).toBe('HORIZONTAL');
  });
});

describe('gaps and padding', () => {
  /**
   * The central design decision: spacing comes from the rendered rectangles,
   * not from the CSS `margin` and `gap` properties. Here the two children have
   * collapsing margins, so no CSS property holds the number 20 — only the
   * geometry does.
   */
  it('measures gaps from geometry rather than CSS properties', () => {
    const children = [child(0, 0, 100, 40), child(0, 60, 100, 40)];
    const result = inferLayout(style(), children, { width: 100, height: 100 }, true);

    expect(result.layout).toMatchObject({ mode: 'VERTICAL', gap: 20 });
  });

  it('derives padding from the extremes of the content', () => {
    const children = [child(16, 24, 100, 40), child(16, 84, 100, 40)];
    const result = inferLayout(style(), children, { width: 132, height: 148 }, true);

    expect(result.layout).toMatchObject({
      mode: 'VERTICAL',
      padding: { top: 24, right: 16, bottom: 24, left: 16 },
    });
  });

  it('falls back to absolute when gaps are not uniform', () => {
    const children = [child(0, 0, 100, 40), child(0, 50, 100, 40), child(0, 200, 100, 40)];
    const result = inferLayout(style(), children, { width: 100, height: 240 }, true);

    expect(result.layout.mode).toBe('ABSOLUTE');
  });

  it('tolerates sub-pixel gap variation', () => {
    // Real pages produce 19.99px next to 20.01px constantly; treating those as
    // different would reject almost every layout.
    const children = [child(0, 0, 100, 40), child(0, 60.01, 100, 40), child(0, 119.99, 100, 40)];
    const result = inferLayout(style(), children, { width: 100, height: 160 }, true);

    expect(result.layout.mode).toBe('VERTICAL');
  });
});

describe('alignment', () => {
  it('detects centring on the counter axis', () => {
    const children = [child(50, 0, 100, 40), child(75, 50, 50, 40)];
    const result = inferLayout(style(), children, { width: 200, height: 90 }, true);

    expect(result.layout).toMatchObject({ mode: 'VERTICAL', counterAlign: 'CENTER' });
  });

  it('detects end alignment on the counter axis', () => {
    const children = [child(100, 0, 100, 40), child(150, 50, 50, 40)];
    const result = inferLayout(style(), children, { width: 200, height: 90 }, true);

    expect(result.layout).toMatchObject({ counterAlign: 'MAX' });
  });

  it('falls back to absolute when children disagree on alignment', () => {
    // One left-aligned, one centred: no single auto-layout setting produces both.
    const children = [child(0, 0, 100, 40), child(75, 50, 50, 40)];
    const result = inferLayout(style(), children, { width: 200, height: 90 }, true);

    expect(result.layout.mode).toBe('ABSOLUTE');
  });

  it('uses space-between when the CSS says so', () => {
    const children = [child(0, 0, 100, 40), child(300, 0, 100, 40)];
    const result = inferLayout(
      style({ display: 'flex', justifyContent: 'space-between' }),
      children,
      { width: 400, height: 40 },
      true,
    );

    expect(result.layout).toMatchObject({ mode: 'HORIZONTAL', primaryAlign: 'SPACE_BETWEEN' });
  });
});

describe('bail-outs', () => {
  it('refuses any container with out-of-flow children', () => {
    const children = [child(0, 0, 100, 40), child(0, 50, 100, 40, { outOfFlow: true })];
    const result = inferLayout(style(), children, { width: 100, height: 90 }, true);

    expect(result.layout.mode).toBe('ABSOLUTE');
  });

  it('refuses overlapping children', () => {
    const children = [child(0, 0, 100, 100), child(0, 50, 100, 100)];
    const result = inferLayout(style(), children, { width: 100, height: 150 }, true);

    expect(result.layout.mode).toBe('ABSOLUTE');
  });

  it('refuses children that overflow their parent', () => {
    const children = [child(-20, 0, 100, 40), child(-20, 50, 100, 40)];
    const result = inferLayout(style(), children, { width: 60, height: 90 }, true);

    expect(result.layout.mode).toBe('ABSOLUTE');
  });

  it('emits absolute layout when auto-layout is disabled', () => {
    const children = [child(0, 0, 100, 40), child(0, 50, 100, 40)];
    const result = inferLayout(style(), children, { width: 100, height: 90 }, false);

    expect(result.layout.mode).toBe('ABSOLUTE');
  });

  it('handles an empty container', () => {
    const result = inferLayout(style(), [], { width: 100, height: 100 }, true);

    expect(result.layout.mode).toBe('ABSOLUTE');
    expect(result.sizing).toEqual([]);
  });
});

describe('wrapping', () => {
  it('detects a wrapped row with uniform gaps', () => {
    const children = [
      child(0, 0, 90, 40),
      child(100, 0, 90, 40),
      child(0, 50, 90, 40),
      child(100, 50, 90, 40),
    ];
    const result = inferLayout(
      style({ display: 'flex', flexDirection: 'row' }),
      children,
      { width: 190, height: 90 },
      true,
    );

    expect(result.layout).toMatchObject({
      mode: 'HORIZONTAL',
      wrap: true,
      gap: 10,
      counterGap: 10,
    });
  });

  it('refuses a wrapped row with inconsistent line gaps', () => {
    const children = [
      child(0, 0, 90, 40),
      child(100, 0, 90, 40),
      child(0, 50, 90, 40),
      child(100, 200, 90, 40),
    ];
    const result = inferLayout(
      style({ display: 'flex' }),
      children,
      { width: 190, height: 240 },
      true,
    );

    expect(result.layout.mode).toBe('ABSOLUTE');
  });
});

describe('child sizing', () => {
  it('marks flex-grow children as filling the primary axis', () => {
    const children = [child(0, 0, 100, 40), child(110, 0, 290, 40, { grow: 1 })];
    const result = inferLayout(
      style({ display: 'flex' }),
      children,
      { width: 400, height: 40 },
      true,
    );

    expect(result.sizing[1]!.horizontal).toBe('FILL');
    expect(result.sizing[0]!.horizontal).toBe('FIXED');
  });
});
