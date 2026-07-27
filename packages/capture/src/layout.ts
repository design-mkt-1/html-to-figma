import type { AxisAlign, LayoutSpec, Rect, SizingMode } from '@h2f/schema';

/** Geometry tolerance, in pixels, for treating measurements as equal. */
const EPSILON = 0.75;

export interface LayoutChild {
  rect: Rect;
  /** `position: absolute | fixed | sticky` — takes the parent out of flow. */
  outOfFlow: boolean;
  /** Resolved `flex-grow`. */
  grow: number;
  /** True when the child stretches on the counter axis. */
  stretches: boolean;
}

export interface LayoutResult {
  layout: LayoutSpec;
  /** Sizing for each child, index-aligned with the input. */
  sizing: Array<{ horizontal: SizingMode; vertical: SizingMode }>;
}

const ABSOLUTE_RESULT = (count: number): LayoutResult => ({
  layout: { mode: 'ABSOLUTE' },
  sizing: Array.from({ length: count }, () => ({
    horizontal: 'FIXED' as SizingMode,
    vertical: 'FIXED' as SizingMode,
  })),
});

/**
 * Decide whether a container can be reproduced as a Figma auto-layout frame,
 * and with what parameters.
 *
 * The inference works from *measured geometry* rather than from the CSS box
 * properties. That is deliberate: `margin` values do not survive margin
 * collapsing, `gap` does not account for a stray `margin-top` on one child, and
 * percentage padding resolves against a containing block that is not always the
 * parent. The rendered rectangles are the ground truth, and reproducing them is
 * the whole job.
 *
 * The CSS `display` value is still consulted, but only to pick the axis and to
 * recognise `space-between`.
 */
export function inferLayout(
  style: CSSStyleDeclaration,
  children: LayoutChild[],
  parent: { width: number; height: number },
  autoLayoutEnabled: boolean,
): LayoutResult {
  if (!autoLayoutEnabled || children.length === 0) {
    return ABSOLUTE_RESULT(children.length);
  }

  // Anything positioned out of flow overlaps its siblings by design; a flow
  // layout cannot describe that.
  if (children.some((c) => c.outOfFlow)) {
    return ABSOLUTE_RESULT(children.length);
  }

  const axis = pickAxis(style, children);
  if (!axis) return ABSOLUTE_RESULT(children.length);

  const rows = groupIntoLines(children, axis);
  if (rows.length === 0) return ABSOLUTE_RESULT(children.length);

  if (rows.length === 1) {
    return singleLine(style, children, parent, axis);
  }

  // Multiple lines only make sense as a wrapping horizontal layout.
  if (axis !== 'HORIZONTAL') return ABSOLUTE_RESULT(children.length);
  return wrapped(style, children, rows, parent);
}

type Axis = 'HORIZONTAL' | 'VERTICAL';

function pickAxis(style: CSSStyleDeclaration, children: LayoutChild[]): Axis | null {
  const display = style.display;

  if (display.includes('flex')) {
    return style.flexDirection.startsWith('column') ? 'VERTICAL' : 'HORIZONTAL';
  }

  if (display.includes('grid')) {
    // A grid's axis is whatever its children actually formed.
    return inferAxisFromGeometry(children);
  }

  if (display === 'none' || display === 'contents') return null;

  // Normal flow: block-level children stack vertically, inline ones flow
  // horizontally. Measuring tells us which happened without having to
  // replicate the block/inline determination for every child.
  return inferAxisFromGeometry(children) ?? 'VERTICAL';
}

function inferAxisFromGeometry(children: LayoutChild[]): Axis | null {
  if (children.length === 1) return 'VERTICAL';

  const sameRow = children.every((c) => Math.abs(c.rect.y - children[0]!.rect.y) < EPSILON);
  if (sameRow) return 'HORIZONTAL';

  const sameColumn = children.every((c) => Math.abs(c.rect.x - children[0]!.rect.x) < EPSILON);
  if (sameColumn) return 'VERTICAL';

  // Neither cleanly aligned — could still be a wrapping row.
  const sorted = [...children].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const firstRowCount = sorted.filter(
    (c) => Math.abs(c.rect.y - sorted[0]!.rect.y) < EPSILON,
  ).length;
  return firstRowCount > 1 ? 'HORIZONTAL' : 'VERTICAL';
}

/** Group children into visual lines along the counter axis. */
function groupIntoLines(children: LayoutChild[], axis: Axis): LayoutChild[][] {
  if (axis === 'VERTICAL') {
    // A vertical stack is one "line" by definition.
    return [[...children].sort((a, b) => a.rect.y - b.rect.y)];
  }

  const sorted = [...children].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const lines: LayoutChild[][] = [];

  for (const child of sorted) {
    const line = lines[lines.length - 1];
    // A child belongs to the current line if it overlaps it vertically.
    if (line) {
      const lineBottom = Math.max(...line.map((c) => c.rect.y + c.rect.height));
      if (child.rect.y < lineBottom - EPSILON) {
        line.push(child);
        continue;
      }
    }
    lines.push([child]);
  }

  for (const line of lines) line.sort((a, b) => a.rect.x - b.rect.x);
  return lines;
}

// ---------------------------------------------------------------------------
// Single-line layouts
// ---------------------------------------------------------------------------

function singleLine(
  style: CSSStyleDeclaration,
  children: LayoutChild[],
  parent: { width: number; height: number },
  axis: Axis,
): LayoutResult {
  const horizontal = axis === 'HORIZONTAL';
  const ordered = [...children].sort((a, b) =>
    horizontal ? a.rect.x - b.rect.x : a.rect.y - b.rect.y,
  );

  const primaryStart = (c: LayoutChild) => (horizontal ? c.rect.x : c.rect.y);
  const primaryEnd = (c: LayoutChild) =>
    horizontal ? c.rect.x + c.rect.width : c.rect.y + c.rect.height;
  const counterStart = (c: LayoutChild) => (horizontal ? c.rect.y : c.rect.x);
  const counterEnd = (c: LayoutChild) =>
    horizontal ? c.rect.y + c.rect.height : c.rect.x + c.rect.width;

  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    gaps.push(primaryStart(ordered[i]!) - primaryEnd(ordered[i - 1]!));
  }

  // Overlapping children cannot be a flow layout.
  if (gaps.some((g) => g < -EPSILON)) return ABSOLUTE_RESULT(children.length);

  const uniformGap = uniform(gaps);
  const spaceBetween = style.justifyContent === 'space-between' && ordered.length > 1;
  if (uniformGap === null && !spaceBetween) return ABSOLUTE_RESULT(children.length);

  const counter = analyzeCounterAxis(ordered, parent, counterStart, counterEnd, horizontal);
  if (!counter) return ABSOLUTE_RESULT(children.length);

  const primaryPad = {
    start: primaryStart(ordered[0]!),
    end: (horizontal ? parent.width : parent.height) - primaryEnd(ordered[ordered.length - 1]!),
  };
  if (primaryPad.start < -EPSILON || primaryPad.end < -EPSILON) {
    return ABSOLUTE_RESULT(children.length);
  }

  const padding = horizontal
    ? {
        top: counter.padStart,
        right: Math.max(0, primaryPad.end),
        bottom: counter.padEnd,
        left: Math.max(0, primaryPad.start),
      }
    : {
        top: Math.max(0, primaryPad.start),
        right: counter.padEnd,
        bottom: Math.max(0, primaryPad.end),
        left: counter.padStart,
      };

  const primaryAlign: AxisAlign = spaceBetween ? 'SPACE_BETWEEN' : 'MIN';

  return {
    layout: {
      mode: axis,
      gap: spaceBetween ? 0 : Math.max(0, uniformGap ?? 0),
      counterGap: 0,
      padding,
      wrap: false,
      primaryAlign,
      counterAlign: counter.align,
    },
    sizing: orderedSizingBackToInput(children, ordered, horizontal, counter.fill),
  };
}

interface CounterAnalysis {
  align: Exclude<AxisAlign, 'SPACE_BETWEEN'>;
  padStart: number;
  padEnd: number;
  /** True when children should stretch to fill the counter axis. */
  fill: boolean;
}

/**
 * Work out how children sit on the counter axis. They must agree — a row where
 * one item is top-aligned and another is centred has no auto-layout equivalent,
 * so it falls back to absolute.
 */
function analyzeCounterAxis(
  ordered: LayoutChild[],
  parent: { width: number; height: number },
  start: (c: LayoutChild) => number,
  end: (c: LayoutChild) => number,
  horizontal: boolean,
): CounterAnalysis | null {
  const extent = horizontal ? parent.height : parent.width;
  const starts = ordered.map(start);
  const ends = ordered.map(end);

  const minStart = Math.min(...starts);
  const maxEnd = Math.max(...ends);
  if (minStart < -EPSILON || maxEnd > extent + EPSILON) return null;

  const padStart = Math.max(0, minStart);
  const padEnd = Math.max(0, extent - maxEnd);

  // All children span the full content box: stretch.
  const allFill = ordered.every(
    (c, i) =>
      Math.abs(starts[i]! - padStart) < EPSILON && Math.abs(ends[i]! - (extent - padEnd)) < EPSILON,
  );
  if (allFill) return { align: 'MIN', padStart, padEnd, fill: true };

  // All share a start edge.
  if (starts.every((s) => Math.abs(s - minStart) < EPSILON)) {
    return { align: 'MIN', padStart, padEnd, fill: false };
  }

  // All share an end edge.
  if (ends.every((e) => Math.abs(e - maxEnd) < EPSILON)) {
    return { align: 'MAX', padStart, padEnd, fill: false };
  }

  // All centred within the same content box.
  const contentStart = padStart;
  const contentEnd = extent - padEnd;
  const centred = ordered.every((c, i) => {
    const leading = starts[i]! - contentStart;
    const trailing = contentEnd - ends[i]!;
    return Math.abs(leading - trailing) < EPSILON * 2;
  });
  if (centred) return { align: 'CENTER', padStart, padEnd, fill: false };

  return null;
}

function orderedSizingBackToInput(
  children: LayoutChild[],
  ordered: LayoutChild[],
  horizontal: boolean,
  counterFill: boolean,
): LayoutResult['sizing'] {
  return children.map((child) => {
    const growsOnPrimary = child.grow > 0 && ordered.includes(child);
    const primary: SizingMode = growsOnPrimary ? 'FILL' : 'FIXED';
    const counter: SizingMode = counterFill && child.stretches ? 'FILL' : 'FIXED';
    return horizontal
      ? { horizontal: primary, vertical: counter }
      : { horizontal: counter, vertical: primary };
  });
}

// ---------------------------------------------------------------------------
// Wrapping layouts
// ---------------------------------------------------------------------------

function wrapped(
  style: CSSStyleDeclaration,
  children: LayoutChild[],
  rows: LayoutChild[][],
  parent: { width: number; height: number },
): LayoutResult {
  // Every row must use the same horizontal gap, and the rows the same vertical
  // gap, or Figma's wrap will not land on the captured positions.
  const rowGaps: number[] = [];
  for (const row of rows) {
    for (let i = 1; i < row.length; i++) {
      rowGaps.push(row[i]!.rect.x - (row[i - 1]!.rect.x + row[i - 1]!.rect.width));
    }
  }

  const lineGaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prevBottom = Math.max(...rows[i - 1]!.map((c) => c.rect.y + c.rect.height));
    const currentTop = Math.min(...rows[i]!.map((c) => c.rect.y));
    lineGaps.push(currentTop - prevBottom);
  }

  const gap = uniform(rowGaps);
  const counterGap = uniform(lineGaps);
  if (gap === null || counterGap === null || gap < -EPSILON || counterGap < -EPSILON) {
    return ABSOLUTE_RESULT(children.length);
  }

  const left = Math.min(...children.map((c) => c.rect.x));
  const right = parent.width - Math.max(...children.map((c) => c.rect.x + c.rect.width));
  const top = Math.min(...children.map((c) => c.rect.y));
  const bottom = parent.height - Math.max(...children.map((c) => c.rect.y + c.rect.height));

  if (left < -EPSILON || right < -EPSILON || top < -EPSILON || bottom < -EPSILON) {
    return ABSOLUTE_RESULT(children.length);
  }

  return {
    layout: {
      mode: 'HORIZONTAL',
      gap: Math.max(0, gap),
      counterGap: Math.max(0, counterGap),
      padding: {
        top: Math.max(0, top),
        right: Math.max(0, right),
        bottom: Math.max(0, bottom),
        left: Math.max(0, left),
      },
      wrap: true,
      primaryAlign: style.justifyContent === 'space-between' ? 'SPACE_BETWEEN' : 'MIN',
      counterAlign: 'MIN',
    },
    sizing: children.map(() => ({
      horizontal: 'FIXED' as SizingMode,
      vertical: 'FIXED' as SizingMode,
    })),
  };
}

// ---------------------------------------------------------------------------

/** Returns the shared value if all entries agree within tolerance, else null. */
function uniform(values: number[]): number | null {
  if (values.length === 0) return 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min > EPSILON) return null;
  return (min + max) / 2;
}
