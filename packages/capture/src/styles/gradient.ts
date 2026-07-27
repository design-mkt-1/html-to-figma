import type { GradientPaint, GradientStop, Rgba } from '@h2f/schema';
import { parseColor } from './color.js';
import { parseFunction, splitTopLevel, splitWhitespace, toDegrees, toPixels } from './css-values.js';

export interface Box {
  width: number;
  height: number;
}

/** Repeating gradients are unrolled; this caps pathological cases. */
const MAX_REPETITIONS = 64;

/**
 * Parse a single CSS gradient function into a resolution-independent
 * `GradientPaint`.
 *
 * Angles use CSS semantics throughout (0° points up, clockwise); converting to
 * Figma's gradient transform matrix is the plugin's job.
 */
export function parseGradient(value: string, box: Box): GradientPaint | null {
  const fn = parseFunction(value.trim());
  if (!fn) return null;

  const repeating = fn.name.startsWith('repeating-');
  const kind = repeating ? fn.name.slice('repeating-'.length) : fn.name;

  switch (kind) {
    case 'linear-gradient':
      return parseLinear(fn.args, box, repeating);
    case 'radial-gradient':
      return parseRadial(fn.args, box, repeating);
    case 'conic-gradient':
      return parseConic(fn.args, box, repeating);
    default:
      return null;
  }
}

export function isGradient(value: string): boolean {
  return /^(repeating-)?(linear|radial|conic)-gradient\(/i.test(value.trim());
}

// ---------------------------------------------------------------------------
// linear-gradient
// ---------------------------------------------------------------------------

function parseLinear(args: string, box: Box, repeating: boolean): GradientPaint | null {
  const parts = splitTopLevel(args);
  if (parts.length === 0) return null;

  let angle = 180; // CSS default is `to bottom`.
  let stopStart = 0;

  const head = parts[0]!;
  const asAngle = toDegrees(head);
  if (head.startsWith('to ')) {
    angle = sideOrCornerToAngle(head.slice(3).trim(), box);
    stopStart = 1;
  } else if (asAngle !== null && /^[-+.\d]/.test(head)) {
    angle = asAngle;
    stopStart = 1;
  }

  // The gradient line length determines what an absolute px stop position
  // means as a fraction of the axis.
  const rad = (angle * Math.PI) / 180;
  const lineLength =
    Math.abs(box.width * Math.sin(rad)) + Math.abs(box.height * Math.cos(rad)) || 1;

  const stops = parseStops(parts.slice(stopStart), lineLength, repeating);
  if (stops.length < 2) return null;

  return {
    kind: 'GRADIENT',
    gradientKind: 'LINEAR',
    stops,
    angle: normalizeAngle(angle),
    center: { x: 0.5, y: 0.5 },
    radius: { x: 0.5, y: 0.5 },
    opacity: 1,
  };
}

/**
 * Corner keywords resolve to an angle that depends on the box aspect ratio: the
 * gradient line is perpendicular to the diagonal joining the two neighbouring
 * corners.
 */
function sideOrCornerToAngle(spec: string, box: Box): number {
  const words = new Set(spec.toLowerCase().split(/\s+/).filter(Boolean));
  const top = words.has('top');
  const bottom = words.has('bottom');
  const left = words.has('left');
  const right = words.has('right');

  const w = box.width || 1;
  const h = box.height || 1;
  const diagonal = (Math.atan2(w, h) * 180) / Math.PI;

  if (top && right) return diagonal;
  if (bottom && right) return 180 - diagonal;
  if (bottom && left) return 180 + diagonal;
  if (top && left) return 360 - diagonal;
  if (top) return 0;
  if (right) return 90;
  if (bottom) return 180;
  if (left) return 270;
  return 180;
}

// ---------------------------------------------------------------------------
// radial-gradient
// ---------------------------------------------------------------------------

function parseRadial(args: string, box: Box, repeating: boolean): GradientPaint | null {
  const parts = splitTopLevel(args);
  if (parts.length === 0) return null;

  let center = { x: 0.5, y: 0.5 };
  let radius = { x: 0.5, y: 0.5 };
  let stopStart = 0;

  // The first item is a configuration clause only if it is not a colour stop.
  const head = parts[0]!;
  if (head && !looksLikeColorStop(head)) {
    stopStart = 1;
    const [shapePart, positionPart] = splitOnAt(head);

    if (positionPart) center = parsePosition(positionPart, box);

    const tokens = splitWhitespace(shapePart).filter(Boolean);
    const isCircle = tokens.some((t) => t.toLowerCase() === 'circle');
    const sizeKeyword = tokens.find((t) => SIZE_KEYWORDS.has(t.toLowerCase()));
    const explicit = tokens.filter((t) => /^[-+.\d]/.test(t));

    if (explicit.length > 0) {
      const rx = toPixels(explicit[0]!, box.width);
      const ry = explicit.length > 1 ? toPixels(explicit[1]!, box.height) : rx;
      radius = {
        x: (rx ?? box.width / 2) / (box.width || 1),
        y: (ry ?? box.height / 2) / (box.height || 1),
      };
    } else {
      radius = resolveRadialSize(sizeKeyword ?? 'farthest-corner', isCircle, center, box);
    }
  } else {
    radius = resolveRadialSize('farthest-corner', false, center, box);
  }

  // Absolute stop positions are relative to the horizontal radius.
  const lineLength = (radius.x * box.width) || 1;
  const stops = parseStops(parts.slice(stopStart), lineLength, repeating);
  if (stops.length < 2) return null;

  return {
    kind: 'GRADIENT',
    gradientKind: 'RADIAL',
    stops,
    angle: 0,
    center,
    radius,
    opacity: 1,
  };
}

const SIZE_KEYWORDS = new Set([
  'closest-side',
  'closest-corner',
  'farthest-side',
  'farthest-corner',
]);

function resolveRadialSize(
  keyword: string,
  isCircle: boolean,
  center: { x: number; y: number },
  box: Box,
): { x: number; y: number } {
  const w = box.width || 1;
  const h = box.height || 1;
  const cx = center.x * w;
  const cy = center.y * h;

  const dxNear = Math.min(cx, w - cx);
  const dxFar = Math.max(cx, w - cx);
  const dyNear = Math.min(cy, h - cy);
  const dyFar = Math.max(cy, h - cy);

  let rx: number;
  let ry: number;

  switch (keyword) {
    case 'closest-side':
      rx = dxNear;
      ry = dyNear;
      break;
    case 'farthest-side':
      rx = dxFar;
      ry = dyFar;
      break;
    case 'closest-corner': {
      const d = Math.hypot(dxNear, dyNear);
      if (isCircle) return { x: d / w, y: d / h };
      // Ellipse through the closest corner keeps the closest-side aspect ratio.
      const ratio = dyNear === 0 ? 1 : dxNear / dyNear;
      ry = d / Math.SQRT2;
      rx = ry * ratio;
      break;
    }
    case 'farthest-corner':
    default: {
      const d = Math.hypot(dxFar, dyFar);
      if (isCircle) return { x: d / w, y: d / h };
      const ratio = dyFar === 0 ? 1 : dxFar / dyFar;
      ry = d / Math.SQRT2;
      rx = ry * ratio;
      break;
    }
  }

  if (isCircle) {
    const r = Math.min(rx, ry);
    return { x: r / w, y: r / h };
  }
  return { x: rx / w, y: ry / h };
}

// ---------------------------------------------------------------------------
// conic-gradient
// ---------------------------------------------------------------------------

function parseConic(args: string, box: Box, repeating: boolean): GradientPaint | null {
  const parts = splitTopLevel(args);
  if (parts.length === 0) return null;

  let angle = 0;
  let center = { x: 0.5, y: 0.5 };
  let stopStart = 0;

  const head = parts[0]!;
  if (head && (head.startsWith('from ') || head.startsWith('at ') || /^from|at\b/.test(head))) {
    stopStart = 1;
    const [fromPart, positionPart] = splitOnAt(head);
    if (positionPart) center = parsePosition(positionPart, box);
    const fromTokens = splitWhitespace(fromPart).filter(Boolean);
    const idx = fromTokens.findIndex((t) => t.toLowerCase() === 'from');
    if (idx >= 0 && fromTokens[idx + 1]) {
      angle = toDegrees(fromTokens[idx + 1]!) ?? 0;
    }
  }

  // Conic stop positions are angles; 360° is the full sweep.
  const stops = parseStops(parts.slice(stopStart), 360, repeating, true);
  if (stops.length < 2) return null;

  return {
    kind: 'GRADIENT',
    gradientKind: 'CONIC',
    stops,
    angle: normalizeAngle(angle),
    center,
    radius: { x: 0.5, y: 0.5 },
    opacity: 1,
  };
}

// ---------------------------------------------------------------------------
// Shared: stop lists and positions
// ---------------------------------------------------------------------------

interface RawStop {
  color: Rgba;
  /** 0..1 along the gradient axis, or null when the author omitted it. */
  position: number | null;
}

function parseStops(
  items: string[],
  lineLength: number,
  repeating: boolean,
  angular = false,
): GradientStop[] {
  const raw: RawStop[] = [];

  for (const item of items) {
    const tokens = splitWhitespace(item).filter(Boolean);
    if (tokens.length === 0) continue;

    // A lone position between two colour stops is a colour hint. It only moves
    // the interpolation midpoint, which Figma cannot express, so it is dropped
    // rather than misread as a stop.
    if (!looksLikeColorStop(item)) continue;

    const color = parseColor(tokens[0]!);
    const positions = tokens.slice(1);

    if (positions.length === 0) {
      raw.push({ color, position: null });
      continue;
    }

    // `red 20% 40%` is shorthand for two stops with the same colour.
    for (const token of positions) {
      raw.push({ color, position: resolveStopPosition(token, lineLength, angular) });
    }
  }

  if (raw.length === 0) return [];
  normalizePositions(raw);

  let stops = raw.map((s) => ({ position: s.position ?? 0, color: s.color }));
  if (repeating) stops = unrollRepeating(stops);

  // Figma requires positions inside 0..1 and sorted.
  return stops
    .map((s) => ({ ...s, position: clamp01(s.position) }))
    .sort((a, b) => a.position - b.position);
}

function resolveStopPosition(token: string, lineLength: number, angular: boolean): number | null {
  if (angular) {
    const deg = toDegrees(token);
    if (deg !== null && !token.trim().endsWith('%')) return deg / 360;
  }
  const px = toPixels(token, lineLength);
  if (px === null) return null;
  return px / (lineLength || 1);
}

/**
 * Apply the CSS rules for omitted stop positions: the ends default to 0 and 1,
 * interior runs are distributed evenly, and positions never decrease.
 */
function normalizePositions(stops: RawStop[]): void {
  if (stops.length === 0) return;
  if (stops[0]!.position === null) stops[0]!.position = 0;
  if (stops[stops.length - 1]!.position === null) stops[stops.length - 1]!.position = 1;

  let i = 0;
  while (i < stops.length) {
    if (stops[i]!.position !== null) {
      i++;
      continue;
    }
    // Find the run of unpositioned stops and interpolate across it.
    const start = i - 1;
    let end = i;
    while (end < stops.length && stops[end]!.position === null) end++;

    const from = stops[start]!.position!;
    const to = stops[end]?.position ?? 1;
    const steps = end - start;
    for (let k = i; k < end; k++) {
      stops[k]!.position = from + ((to - from) * (k - start)) / steps;
    }
    i = end;
  }

  // Enforce monotonicity — CSS clamps a stop to the largest preceding one.
  for (let k = 1; k < stops.length; k++) {
    if (stops[k]!.position! < stops[k - 1]!.position!) {
      stops[k]!.position = stops[k - 1]!.position;
    }
  }
}

/**
 * Figma has no repeating gradients, so the authored pattern is unrolled across
 * the whole 0..1 axis. Visually identical for the common case of a stripe
 * pattern, which is what repeating gradients are almost always used for.
 */
function unrollRepeating(stops: GradientStop[]): GradientStop[] {
  const first = stops[0]!.position;
  const last = stops[stops.length - 1]!.position;
  const period = last - first;
  if (period <= 0.0001) return stops;

  const before = Math.ceil(first / period);
  const after = Math.ceil((1 - last) / period);
  const total = before + after + 1;
  if (total > MAX_REPETITIONS) return stops;

  const out: GradientStop[] = [];
  for (let rep = -before; rep <= after; rep++) {
    const shift = rep * period;
    for (const stop of stops) {
      const position = stop.position + shift;
      if (position < -0.001 || position > 1.001) continue;
      out.push({ position, color: stop.color });
    }
  }
  return out.length >= 2 ? out : stops;
}

/** `circle at 50% 50%` → `['circle', '50% 50%']`. */
function splitOnAt(value: string): [string, string | null] {
  const tokens = splitWhitespace(value);
  const idx = tokens.findIndex((t) => t.toLowerCase() === 'at');
  if (idx < 0) return [value, null];
  return [tokens.slice(0, idx).join(' '), tokens.slice(idx + 1).join(' ')];
}

const POSITION_KEYWORDS: Record<string, number> = {
  left: 0,
  top: 0,
  center: 0.5,
  right: 1,
  bottom: 1,
};

/** Parse a background/gradient position into 0..1 fractions of the box. */
export function parsePosition(value: string, box: Box): { x: number; y: number } {
  const tokens = splitWhitespace(value).filter(Boolean);
  if (tokens.length === 0) return { x: 0.5, y: 0.5 };

  let x = 0.5;
  let y = 0.5;
  let seenX = false;
  let seenY = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!.toLowerCase();

    if (token === 'left' || token === 'right') {
      x = POSITION_KEYWORDS[token]!;
      seenX = true;
      continue;
    }
    if (token === 'top' || token === 'bottom') {
      y = POSITION_KEYWORDS[token]!;
      seenY = true;
      continue;
    }
    if (token === 'center') {
      // Binds to whichever axis is still unset.
      if (!seenX) {
        x = 0.5;
        seenX = true;
      } else {
        y = 0.5;
        seenY = true;
      }
      continue;
    }

    const px = toPixels(token, seenX ? box.height : box.width);
    if (px === null) continue;
    if (!seenX) {
      x = px / (box.width || 1);
      seenX = true;
    } else {
      y = px / (box.height || 1);
      seenY = true;
    }
  }

  return { x, y };
}

const COLOR_START =
  /^(#|rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color\(|color-mix|transparent|currentcolor|[a-z]{3,})/i;

function looksLikeColorStop(item: string): boolean {
  const first = splitWhitespace(item)[0];
  if (!first) return false;
  // A hint is a bare length/percentage with no colour in front of it.
  if (/^[-+.\d]/.test(first)) return false;
  return COLOR_START.test(first);
}

function normalizeAngle(deg: number): number {
  const mod = deg % 360;
  return mod < 0 ? mod + 360 : mod;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
