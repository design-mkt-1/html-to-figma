import type { BuilderApi } from '../src/build.js';

/**
 * An in-memory stand-in for the parts of the Figma API the builder uses.
 *
 * The point is to be able to assert the *actual node tree* the plugin produces
 * — sizes, positions, layout modes, fills — in Node, with no Figma editor
 * involved. That means the mock has to do more than record calls: it has to
 * reproduce Figma's auto-layout arithmetic, because the builder's
 * self-correcting layout pass reads back the positions Figma computed and
 * reverts to absolute positioning when they disagree with the capture. A mock
 * that left children where they were put would make that check vacuous and the
 * tests would pass no matter what the inference did.
 */

export interface MockNode {
  type: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  blendMode: string;
  rotation: number;
  visible: boolean;
  parent: MockFrame | null;
  removed: boolean;
  [key: string]: unknown;
}

export interface MockFrame extends MockNode {
  type: 'FRAME';
  children: MockNode[];
  layoutMode: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
  layoutWrap: 'NO_WRAP' | 'WRAP';
  itemSpacing: number;
  counterAxisSpacing: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  primaryAxisAlignItems: string;
  counterAxisAlignItems: string;
  primaryAxisSizingMode: string;
  counterAxisSizingMode: string;
}

export interface MockText extends MockNode {
  type: 'TEXT';
  characters: string;
  fontName: { family: string; style: string };
  ranges: Array<{ start: number; end: number; property: string; value: unknown }>;
}

let idCounter = 0;

function baseNode(type: string): MockNode {
  const node: MockNode = {
    type,
    name: type,
    id: `mock:${idCounter++}`,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    opacity: 1,
    blendMode: 'NORMAL',
    rotation: 0,
    visible: true,
    parent: null,
    removed: false,
    fills: [],
    strokes: [],
    effects: [],
    resize(width: number, height: number) {
      node.width = width;
      node.height = height;
      // Resizing a child of an auto-layout frame re-flows its siblings, just
      // as it does in Figma.
      if (node.parent) relayout(node.parent);
    },
    remove() {
      node.removed = true;
      if (node.parent) {
        node.parent.children = node.parent.children.filter((c) => c !== node);
        node.parent = null;
      }
    },
  };
  return node;
}

function createFrame(): MockFrame {
  const frame = baseNode('FRAME') as MockFrame;
  frame.children = [];
  frame.layoutMode = 'NONE';
  frame.layoutWrap = 'NO_WRAP';
  frame.itemSpacing = 0;
  frame.counterAxisSpacing = 0;
  frame.paddingTop = 0;
  frame.paddingRight = 0;
  frame.paddingBottom = 0;
  frame.paddingLeft = 0;
  frame.primaryAxisAlignItems = 'MIN';
  frame.counterAxisAlignItems = 'MIN';
  frame.primaryAxisSizingMode = 'AUTO';
  frame.counterAxisSizingMode = 'AUTO';
  frame.clipsContent = true;

  frame.appendChild = (child: MockNode) => {
    if (child.parent) {
      child.parent.children = child.parent.children.filter((c) => c !== child);
    }
    child.parent = frame;
    frame.children.push(child);
    relayout(frame);
  };

  // Figma applies layout as soon as the property is set, not lazily; the
  // builder depends on reading positions back immediately afterwards.
  return new Proxy(frame, {
    set(target, property, value) {
      (target as Record<string | symbol, unknown>)[property] = value;
      if (LAYOUT_PROPERTIES.has(String(property))) relayout(target);
      return true;
    },
  }) as MockFrame;
}

const LAYOUT_PROPERTIES = new Set([
  'layoutMode',
  'layoutWrap',
  'itemSpacing',
  'counterAxisSpacing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'primaryAxisAlignItems',
  'counterAxisAlignItems',
  'width',
  'height',
]);

/**
 * Reproduce Figma's auto-layout placement.
 *
 * Deliberately covers only what the capture side can emit: a single row or
 * column, or a wrapping row, with fixed-size children. Anything else is what
 * the drift check exists to catch.
 */
function relayout(frame: MockFrame): void {
  if (frame.layoutMode === 'NONE' || frame.children.length === 0) return;

  const horizontal = frame.layoutMode === 'HORIZONTAL';
  const innerStart = horizontal ? frame.paddingLeft : frame.paddingTop;
  const innerEnd = horizontal ? frame.paddingRight : frame.paddingBottom;
  const crossStart = horizontal ? frame.paddingTop : frame.paddingLeft;
  const crossEnd = horizontal ? frame.paddingBottom : frame.paddingRight;

  const primaryExtent = (horizontal ? frame.width : frame.height) - innerStart - innerEnd;
  const crossExtent = (horizontal ? frame.height : frame.width) - crossStart - crossEnd;

  const primarySize = (n: MockNode) => (horizontal ? n.width : n.height);
  const crossSize = (n: MockNode) => (horizontal ? n.height : n.width);

  // Group into lines. Without wrapping that is always a single line.
  const lines: MockNode[][] = [];
  if (frame.layoutWrap === 'WRAP' && horizontal) {
    let line: MockNode[] = [];
    let used = 0;
    for (const child of frame.children) {
      const needed = primarySize(child) + (line.length > 0 ? frame.itemSpacing : 0);
      if (line.length > 0 && used + needed > primaryExtent + 0.01) {
        lines.push(line);
        line = [child];
        used = primarySize(child);
      } else {
        line.push(child);
        used += needed;
      }
    }
    if (line.length > 0) lines.push(line);
  } else {
    lines.push([...frame.children]);
  }

  let crossCursor = crossStart;

  for (const line of lines) {
    const contentSize =
      line.reduce((sum, child) => sum + primarySize(child), 0) +
      frame.itemSpacing * Math.max(0, line.length - 1);
    const free = primaryExtent - contentSize;

    let cursor = innerStart;
    let spacing = frame.itemSpacing;

    switch (frame.primaryAxisAlignItems) {
      case 'CENTER':
        cursor += free / 2;
        break;
      case 'MAX':
        cursor += free;
        break;
      case 'SPACE_BETWEEN':
        if (line.length > 1) spacing = frame.itemSpacing + free / (line.length - 1);
        break;
    }

    const lineCross = Math.max(0, ...line.map(crossSize));

    for (const child of line) {
      const primaryPosition = cursor;
      let crossPosition = crossCursor;

      switch (frame.counterAxisAlignItems) {
        case 'CENTER':
          crossPosition += (lineCross - crossSize(child)) / 2;
          break;
        case 'MAX':
          crossPosition += lineCross - crossSize(child);
          break;
      }

      // Single-line layouts stretch the counter axis over the whole content
      // box; wrapped lines only over their own line.
      if (lines.length === 1 && frame.counterAxisAlignItems === 'CENTER') {
        crossPosition = crossStart + (crossExtent - crossSize(child)) / 2;
      } else if (lines.length === 1 && frame.counterAxisAlignItems === 'MAX') {
        crossPosition = crossStart + crossExtent - crossSize(child);
      }

      if (horizontal) {
        child.x = primaryPosition;
        child.y = crossPosition;
      } else {
        child.y = primaryPosition;
        child.x = crossPosition;
      }

      cursor += primarySize(child) + spacing;
    }

    crossCursor += lineCross + frame.counterAxisSpacing;
  }
}

function createRectangle(): MockNode {
  const node = baseNode('RECTANGLE');
  node.topLeftRadius = 0;
  node.topRightRadius = 0;
  node.bottomRightRadius = 0;
  node.bottomLeftRadius = 0;
  return node;
}

function createText(): MockText {
  const text = baseNode('TEXT') as MockText;
  text.characters = '';
  text.fontName = { family: 'Inter', style: 'Regular' };
  text.ranges = [];
  text.textAutoResize = 'WIDTH_AND_HEIGHT';

  const record = (property: string) => (start: number, end: number, value: unknown) => {
    if (start < 0 || end > text.characters.length || start >= end) {
      throw new Error(`range [${start}, ${end}) out of bounds`);
    }
    text.ranges.push({ start, end, property, value });
  };

  text.setRangeFontName = record('fontName');
  text.setRangeFontSize = record('fontSize');
  text.setRangeLineHeight = record('lineHeight');
  text.setRangeLetterSpacing = record('letterSpacing');
  text.setRangeTextDecoration = record('textDecoration');
  text.setRangeTextCase = record('textCase');
  text.setRangeFills = record('fills');

  return text;
}

export interface MockFigma extends BuilderApi {
  /** Fonts the builder asked to load, in order. */
  loadedFonts: Array<{ family: string; style: string }>;
  /** Image byte arrays passed to `createImage`, keyed by the hash handed back. */
  images: Map<string, Uint8Array>;
}

export interface MockFigmaOptions {
  /** Fonts to report as installed. Defaults to a small Inter/Arial set. */
  availableFonts?: Array<{ family: string; style: string }>;
  /** Make `createImage` throw, to exercise the rejection path. */
  rejectImages?: boolean;
}

const DEFAULT_FONTS = [
  { family: 'Inter', style: 'Regular' },
  { family: 'Inter', style: 'Medium' },
  { family: 'Inter', style: 'Semi Bold' },
  { family: 'Inter', style: 'Bold' },
  { family: 'Inter', style: 'Italic' },
  { family: 'Inter', style: 'Bold Italic' },
  { family: 'Arial', style: 'Regular' },
  { family: 'Arial', style: 'Bold' },
  { family: 'Arial', style: 'Italic' },
];

export function createMockFigma(options: MockFigmaOptions = {}): MockFigma {
  const loadedFonts: Array<{ family: string; style: string }> = [];
  const images = new Map<string, Uint8Array>();
  const available = options.availableFonts ?? DEFAULT_FONTS;
  let imageCounter = 0;

  return {
    createFrame: (() => createFrame()) as unknown as BuilderApi['createFrame'],
    createText: (() => createText()) as unknown as BuilderApi['createText'],
    createRectangle: (() => createRectangle()) as unknown as BuilderApi['createRectangle'],

    createImage: ((bytes: Uint8Array) => {
      if (options.rejectImages) throw new Error('image too large');
      const hash = `hash:${imageCounter++}`;
      images.set(hash, bytes);
      return { hash };
    }) as unknown as BuilderApi['createImage'],

    createNodeFromSvg: ((markup: string) => {
      if (!markup.includes('<svg')) throw new Error('invalid svg');
      const frame = createFrame();
      frame.name = 'svg';
      return frame;
    }) as unknown as BuilderApi['createNodeFromSvg'],

    loadFontAsync: (async (fontName: { family: string; style: string }) => {
      const exists = available.some(
        (font) => font.family === fontName.family && font.style === fontName.style,
      );
      if (!exists) throw new Error(`font not found: ${fontName.family} ${fontName.style}`);
      loadedFonts.push(fontName);
    }) as unknown as BuilderApi['loadFontAsync'],

    listAvailableFontsAsync: (async () =>
      available.map((fontName) => ({
        fontName,
      }))) as unknown as BuilderApi['listAvailableFontsAsync'],

    loadedFonts,
    images,
  };
}

/** Readable tree dump for assertions and debugging. */
export function describeTree(node: MockNode, depth = 0): string {
  const pad = '  '.repeat(depth);
  const frame = node as MockFrame;
  const layout =
    frame.layoutMode && frame.layoutMode !== 'NONE'
      ? ` [${frame.layoutMode} gap=${frame.itemSpacing}]`
      : '';

  let out = `${pad}${node.type} "${node.name}" ${round(node.width)}x${round(node.height)} @${round(node.x)},${round(node.y)}${layout}\n`;
  for (const child of frame.children ?? []) {
    out += describeTree(child, depth + 1);
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
