import type { GradientPaint, Paint as IrPaint, Rgba, SolidPaint as IrSolid } from '@h2f/schema';

/**
 * IR paints → Figma paints.
 *
 * Pure: no `figma` global, no side effects. Image paints need an image hash
 * that only the sandbox can mint, so it is passed in rather than looked up.
 */

export type ImageHashLookup = (assetRef: string) => string | null;

export function toPaints(paints: IrPaint[], lookup: ImageHashLookup): Paint[] {
  const out: Paint[] = [];
  for (const paint of paints) {
    const converted = toPaint(paint, lookup);
    if (converted) out.push(converted);
  }
  return out;
}

export function toPaint(paint: IrPaint, lookup: ImageHashLookup): Paint | null {
  switch (paint.kind) {
    case 'SOLID':
      return toSolidPaint(paint);
    case 'GRADIENT':
      return toGradientPaint(paint);
    case 'IMAGE': {
      const imageHash = lookup(paint.asset);
      if (!imageHash) return null;
      return {
        type: 'IMAGE',
        imageHash,
        // CROP requires an imageTransform we cannot derive reliably from CSS
        // background-position alone, so it degrades to FILL rather than
        // producing a confidently wrong crop.
        scaleMode: paint.scaleMode === 'CROP' ? 'FILL' : paint.scaleMode,
        opacity: paint.opacity,
        ...(paint.scaleMode === 'TILE' ? { scalingFactor: paint.scalingFactor ?? 1 } : {}),
        ...(paint.blendMode ? { blendMode: paint.blendMode } : {}),
      } as ImagePaint;
    }
    default:
      return null;
  }
}

function toSolidPaint(paint: IrSolid): SolidPaint {
  return {
    type: 'SOLID',
    color: { r: paint.color.r, g: paint.color.g, b: paint.color.b },
    // CSS keeps alpha on the colour; Figma keeps it on the paint.
    opacity: clamp01(paint.color.a * paint.opacity),
    ...(paint.blendMode ? { blendMode: paint.blendMode } : {}),
  };
}

function toGradientPaint(paint: GradientPaint): GradientPaint_Figma {
  const stops: ColorStop[] = paint.stops.map((stop) => ({
    position: clamp01(stop.position),
    color: toRgba(stop.color),
  }));

  // Figma needs at least two stops and will not accept an unsorted list.
  if (stops.length === 1) stops.push({ ...stops[0]!, position: 1 });

  return {
    type: gradientType(paint.gradientKind),
    gradientStops: stops,
    gradientTransform: gradientTransform(paint),
    opacity: paint.opacity,
    ...(paint.blendMode ? { blendMode: paint.blendMode } : {}),
  } as GradientPaint_Figma;
}

type GradientPaint_Figma = Extract<Paint, { type: `GRADIENT_${string}` }>;

function gradientType(kind: GradientPaint['gradientKind']): GradientPaint_Figma['type'] {
  switch (kind) {
    case 'RADIAL':
      return 'GRADIENT_RADIAL';
    case 'CONIC':
      return 'GRADIENT_ANGULAR';
    case 'DIAMOND':
      return 'GRADIENT_DIAMOND';
    default:
      return 'GRADIENT_LINEAR';
  }
}

/**
 * Build Figma's `gradientTransform`.
 *
 * Figma defines a gradient in its own unit space and maps the layer into it
 * with this matrix — the inverse of how CSS thinks about gradients, which is
 * why this cannot just be an angle. For a linear gradient the matrix has to
 * send the layer's normalized coordinates to the gradient parameter `t`, so
 * that `t = 0` and `t = 1` land exactly on the ends of the CSS gradient line.
 */
export function gradientTransform(paint: GradientPaint): Transform {
  if (paint.gradientKind === 'RADIAL' || paint.gradientKind === 'DIAMOND') {
    // Map the layer so the gradient's unit circle covers the CSS ellipse.
    const rx = Math.max(paint.radius.x, 1e-4);
    const ry = Math.max(paint.radius.y, 1e-4);
    const sx = 0.5 / rx;
    const sy = 0.5 / ry;
    return [
      [sx, 0, 0.5 - paint.center.x * sx],
      [0, sy, 0.5 - paint.center.y * sy],
    ];
  }

  if (paint.gradientKind === 'CONIC') {
    // A rotation about the gradient's centre. Figma's angular gradient sweeps
    // from the positive x axis, CSS from straight up, hence the quarter turn.
    const angle = ((paint.angle - 90) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const { x: cx, y: cy } = paint.center;
    return [
      [cos, -sin, cx - cx * cos + cy * sin],
      [sin, cos, cy - cx * sin - cy * cos],
    ];
  }

  // Linear. In normalized layer space the CSS gradient parameter is
  //   t = 0.5 + ((p - centre) · d) / L
  // with direction d = (sin θ, −cos θ) and gradient-line length
  //   L = |w·sin θ| + |h·cos θ|.
  // Expanding that in normalized coordinates gives the first row directly; the
  // ratios w/L and h/L reduce to pure trigonometry, so the layer's pixel size
  // cancels out entirely.
  const theta = (paint.angle * Math.PI) / 180;
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);

  const denominator = Math.abs(sin) + Math.abs(cos) || 1;
  const a = sin / denominator;
  const b = -cos / denominator;
  const c = 0.5 - (a + b) / 2;

  return [
    [a, b, c],
    // Any invertible second row works — Figma reads only the first for a
    // linear gradient — but keeping it perpendicular avoids a degenerate
    // matrix when the gradient is axis-aligned.
    [-b, a, 0.5 - (-b + a) / 2],
  ];
}

export function toRgba(color: Rgba): RGBA {
  return { r: color.r, g: color.g, b: color.b, a: color.a };
}

export function toRgb(color: Rgba): RGB {
  return { r: color.r, g: color.g, b: color.b };
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
