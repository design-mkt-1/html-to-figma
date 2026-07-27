/**
 * CSS transform analysis.
 *
 * The IR can express rotation and scale but not skew or perspective. This
 * module decides which bucket a computed transform falls into so the walker can
 * either reproduce it faithfully or fall back to rasterizing the element.
 */

export type TransformKind =
  /** Identity, or a pure translation already reflected in the measured rect. */
  | 'NONE'
  /** Rotation and/or scale — representable. */
  | 'ROTATE'
  /** Skew, perspective or a mirror — not representable. */
  | 'UNSUPPORTED';

export interface TransformInfo {
  kind: TransformKind;
  /** Degrees clockwise, matching CSS. */
  rotation: number;
  scaleX: number;
  scaleY: number;
}

const IDENTITY: TransformInfo = { kind: 'NONE', rotation: 0, scaleX: 1, scaleY: 1 };

export function analyzeTransform(value: string | null | undefined): TransformInfo {
  if (!value || value === 'none') return IDENTITY;

  const matrix = readMatrix(value);
  if (!matrix) {
    // An unrecognized transform syntax is safer to rasterize than to ignore.
    return { kind: 'UNSUPPORTED', rotation: 0, scaleX: 1, scaleY: 1 };
  }

  return decompose(matrix);
}

/** Returns `[a, b, c, d]`; translation is dropped because the measured rect already includes it. */
function readMatrix(value: string): [number, number, number, number] | null {
  const matrix2d = /^matrix\(([^)]+)\)$/.exec(value);
  if (matrix2d) {
    const n = matrix2d[1]!.split(',').map((s) => Number.parseFloat(s));
    if (n.length < 6 || n.some((v) => !Number.isFinite(v))) return null;
    return [n[0]!, n[1]!, n[2]!, n[3]!];
  }

  const matrix3d = /^matrix3d\(([^)]+)\)$/.exec(value);
  if (matrix3d) {
    const n = matrix3d[1]!.split(',').map((s) => Number.parseFloat(s));
    if (n.length < 16 || n.some((v) => !Number.isFinite(v))) return null;
    // Any real 3D component (rotation out of plane or perspective) cannot be
    // flattened; reject rather than silently projecting it.
    const has3d =
      Math.abs(n[2]!) > 1e-6 ||
      Math.abs(n[6]!) > 1e-6 ||
      Math.abs(n[8]!) > 1e-6 ||
      Math.abs(n[9]!) > 1e-6 ||
      Math.abs(n[3]!) > 1e-6 ||
      Math.abs(n[7]!) > 1e-6 ||
      Math.abs(n[11]!) > 1e-6 ||
      Math.abs(n[10]! - 1) > 1e-6;
    if (has3d) return null;
    return [n[0]!, n[1]!, n[4]!, n[5]!];
  }

  return null;
}

/**
 * Standard QR-style decomposition of a 2D affine matrix into
 * rotation · scale · skew.
 */
function decompose([a0, b0, c0, d0]: [number, number, number, number]): TransformInfo {
  let a = a0;
  let b = b0;
  let c = c0;
  let d = d0;

  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-9) {
    // Degenerate (collapsed to a line); nothing sensible to reproduce.
    return { kind: 'UNSUPPORTED', rotation: 0, scaleX: 1, scaleY: 1 };
  }

  let scaleX = Math.hypot(a, b);
  if (scaleX !== 0) {
    a /= scaleX;
    b /= scaleX;
  }

  let shear = a * c + b * d;
  c -= a * shear;
  d -= b * shear;

  let scaleY = Math.hypot(c, d);
  if (scaleY !== 0) {
    shear /= scaleY;
  }

  // A negative determinant means the transform includes a reflection, which
  // Figma cannot express on a frame.
  if (determinant < 0) {
    return { kind: 'UNSUPPORTED', rotation: 0, scaleX: 1, scaleY: 1 };
  }

  if (Math.abs(shear) > 1e-4) {
    return { kind: 'UNSUPPORTED', rotation: 0, scaleX: 1, scaleY: 1 };
  }

  const rotation = (Math.atan2(b, a) * 180) / Math.PI;

  const isIdentity =
    Math.abs(rotation) < 1e-4 && Math.abs(scaleX - 1) < 1e-4 && Math.abs(scaleY - 1) < 1e-4;

  return {
    kind: isIdentity ? 'NONE' : 'ROTATE',
    rotation,
    scaleX: scaleX || 1,
    scaleY: scaleY || 1,
  };
}
