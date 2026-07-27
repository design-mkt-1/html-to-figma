import type {
  Paint,
  TextAlign,
  TextCase,
  TextDecoration,
  TextSegment,
  TextStyle,
  TextVerticalAlign,
} from '@h2f/schema';
import { isTransparent, parseColor } from './styles/color.js';
import { toPixels } from './styles/css-values.js';
import { isItalic, parseFontWeight, resolveFamily } from './styles/font.js';

/** Read the typographic properties of an element into an IR text style. */
export function readTextStyle(style: CSSStyleDeclaration, sample: string): TextStyle {
  const size = toPixels(style.fontSize, 16) ?? 16;
  const weight = parseFontWeight(style.fontWeight);
  const italic = isItalic(style.fontStyle);

  const color = parseColor(style.color);
  const fills: Paint[] = isTransparent(color) ? [] : [{ kind: 'SOLID', color, opacity: 1 }];

  return {
    family: resolveFamily(style.fontFamily, weight, italic, size, sample),
    weight,
    italic,
    size,
    lineHeight: readLineHeight(style.lineHeight),
    letterSpacing: style.letterSpacing === 'normal' ? 0 : (toPixels(style.letterSpacing, size) ?? 0),
    fills,
    decoration: readDecoration(style),
    textCase: readTextCase(style.textTransform),
  };
}

function readLineHeight(value: string | null | undefined): number | null {
  // `normal` means "whatever the font says", which Figma models as AUTO.
  if (!value || value === 'normal') return null;
  const px = toPixels(value, 0);
  return px !== null && px > 0 ? px : null;
}

function readDecoration(style: CSSStyleDeclaration): TextDecoration {
  const line = style.textDecorationLine || style.textDecoration || '';
  if (line.includes('underline')) return 'UNDERLINE';
  if (line.includes('line-through')) return 'STRIKETHROUGH';
  return 'NONE';
}

function readTextCase(value: string | null | undefined): TextCase {
  switch (value) {
    case 'uppercase':
      return 'UPPER';
    case 'lowercase':
      return 'LOWER';
    case 'capitalize':
      return 'TITLE';
    default:
      return 'ORIGINAL';
  }
}

export function readTextAlign(style: CSSStyleDeclaration): TextAlign {
  switch (style.textAlign) {
    case 'center':
      return 'CENTER';
    case 'right':
      return 'RIGHT';
    case 'justify':
      return 'JUSTIFIED';
    case 'end':
      return style.direction === 'rtl' ? 'LEFT' : 'RIGHT';
    case 'start':
      return style.direction === 'rtl' ? 'RIGHT' : 'LEFT';
    default:
      return 'LEFT';
  }
}

export function readVerticalAlign(style: CSSStyleDeclaration): TextVerticalAlign {
  // Only flex and grid containers reliably express vertical centring in a way
  // that maps onto Figma's text alignment.
  const display = style.display;
  if (display.includes('flex') || display.includes('grid')) {
    switch (style.alignItems) {
      case 'center':
        return 'CENTER';
      case 'flex-end':
      case 'end':
        return 'BOTTOM';
      default:
        return 'TOP';
    }
  }
  return 'TOP';
}

export function readMaxLines(style: CSSStyleDeclaration): number | null {
  const clamp = style.getPropertyValue('-webkit-line-clamp');
  if (clamp && clamp !== 'none') {
    const n = Number.parseInt(clamp, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Character extraction and segmentation
// ---------------------------------------------------------------------------

export interface TextContent {
  characters: string;
  segments: TextSegment[];
}

interface Run {
  text: string;
  style: TextStyle;
}

/**
 * Flatten an element's inline content into a single string plus the style runs
 * that differ from the element's own style.
 *
 * This is what lets `<p>plain <a>link</a> more</p>` become one editable Figma
 * text layer with a styled range, rather than three layers the user has to
 * reassemble by hand.
 */
export function extractText(element: Element, baseStyle: TextStyle): TextContent | null {
  const runs: Run[] = [];
  collectRuns(element, baseStyle, runs, { pendingSpace: null, atStart: true });

  const characters = runs.map((r) => r.text).join('');
  if (characters.trim() === '') return null;

  return { characters, segments: buildSegments(runs, baseStyle) };
}

interface CollectState {
  /**
   * A collapsed whitespace run waiting to be emitted, along with the style of
   * the text node it came from. Null when no space is pending.
   */
  pendingSpace: TextStyle | null;
  atStart: boolean;
}

function collectRuns(node: Node, style: TextStyle, runs: Run[], state: CollectState): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const raw = child.nodeValue ?? '';
      if (raw === '') continue;

      if (isPreserved(node)) {
        push(runs, raw, style);
        state.pendingSpace = null;
        state.atStart = false;
        continue;
      }

      emitCollapsed(raw, style, runs, state);
      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;

    if (el.tagName === 'BR') {
      push(runs, '\n', style);
      // A line break swallows the whitespace around it.
      state.pendingSpace = null;
      state.atStart = true;
      continue;
    }

    const childStyle = window.getComputedStyle(el);
    if (childStyle.display === 'none' || childStyle.visibility === 'hidden') continue;

    const sample = el.textContent ?? '';
    collectRuns(el, readTextStyle(childStyle, sample), runs, state);
  }
}

function push(runs: Run[], text: string, style: TextStyle): void {
  const last = runs[runs.length - 1];
  if (last && sameStyle(last.style, style)) {
    last.text += text;
    return;
  }
  runs.push({ text, style });
}

/**
 * Apply CSS whitespace collapsing so the captured characters match what the
 * page actually shows. Without this, source indentation turns into runs of
 * spaces inside every Figma text layer.
 */
function emitCollapsed(
  raw: string,
  style: TextStyle,
  runs: Run[],
  state: CollectState,
): void {
  let buffer = '';
  let i = 0;

  const flush = () => {
    if (buffer !== '') {
      push(runs, buffer, style);
      buffer = '';
    }
  };

  while (i < raw.length) {
    if (isWhitespace(raw[i]!)) {
      while (i < raw.length && isWhitespace(raw[i]!)) i++;
      // Leading whitespace in a block is dropped entirely. Elsewhere it becomes
      // a single space — but only once we know a non-space character follows,
      // which may not be until a later text node.
      if (!state.atStart) {
        flush();
        state.pendingSpace = style;
      }
      continue;
    }

    // The pending space carries the style of the text node it came from, not
    // of the node that happens to follow it. `link</a> and` puts the space
    // outside the anchor, so it must not be underlined.
    if (state.pendingSpace) {
      push(runs, ' ', state.pendingSpace);
      state.pendingSpace = null;
    }

    buffer += raw[i]!;
    state.atStart = false;
    i++;
  }

  flush();
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function isPreserved(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const ws = window.getComputedStyle(node as Element).whiteSpace;
  return ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces';
}

function buildSegments(runs: Run[], base: TextStyle): TextSegment[] {
  const segments: TextSegment[] = [];
  let offset = 0;

  for (const run of runs) {
    const start = offset;
    offset += run.text.length;
    if (run.text.length === 0) continue;

    const diff = styleDiff(base, run.style);
    if (diff) segments.push({ start, end: offset, style: diff });
  }

  return segments;
}

/** Only the properties that differ, so the plugin makes the fewest range calls. */
function styleDiff(base: TextStyle, style: TextStyle): Partial<TextStyle> | null {
  const diff: Partial<TextStyle> = {};
  let changed = false;

  if (style.family !== base.family) ((diff.family = style.family), (changed = true));
  if (style.weight !== base.weight) ((diff.weight = style.weight), (changed = true));
  if (style.italic !== base.italic) ((diff.italic = style.italic), (changed = true));
  if (Math.abs(style.size - base.size) > 0.01) ((diff.size = style.size), (changed = true));
  if (style.lineHeight !== base.lineHeight) ((diff.lineHeight = style.lineHeight), (changed = true));
  if (Math.abs(style.letterSpacing - base.letterSpacing) > 0.01) {
    diff.letterSpacing = style.letterSpacing;
    changed = true;
  }
  if (style.decoration !== base.decoration) ((diff.decoration = style.decoration), (changed = true));
  if (style.textCase !== base.textCase) ((diff.textCase = style.textCase), (changed = true));
  if (!sameFills(style.fills, base.fills)) ((diff.fills = style.fills), (changed = true));

  return changed ? diff : null;
}

function sameStyle(a: TextStyle, b: TextStyle): boolean {
  return styleDiff(a, b) === null;
}

function sameFills(a: Paint[], b: Paint[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.kind !== y.kind) return false;
    if (x.kind === 'SOLID' && y.kind === 'SOLID') {
      if (
        Math.abs(x.color.r - y.color.r) > 0.004 ||
        Math.abs(x.color.g - y.color.g) > 0.004 ||
        Math.abs(x.color.b - y.color.b) > 0.004 ||
        Math.abs(x.color.a - y.color.a) > 0.004
      ) {
        return false;
      }
    }
  }
  return true;
}
