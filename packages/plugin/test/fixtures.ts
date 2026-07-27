import { SCHEMA_VERSION } from '@h2f/schema';
import type {
  Capture,
  ElementNode,
  LayoutSpec,
  Rect,
  RootNode,
  SceneNode,
  TextNode,
  TextStyle,
} from '@h2f/schema';

/** Builders for compact, readable test captures. */

export function makeCapture(root: RootNode, overrides: Partial<Capture> = {}): Capture {
  return {
    version: SCHEMA_VERSION,
    meta: {
      url: 'https://example.test/',
      title: 'Test',
      capturedAt: '2026-01-01T00:00:00.000Z',
      colorScheme: 'light',
      locale: 'en-US',
      generator: 'test',
    },
    roots: [root],
    assets: {},
    fonts: [],
    warnings: [],
    ...overrides,
  };
}

let counter = 0;
export function resetIds(): void {
  counter = 0;
}

function nextId(): string {
  return `n${counter++}`;
}

export function makeRoot(children: SceneNode[], rect: Partial<Rect> = {}): RootNode {
  return {
    ...makeElement(children, rect),
    kind: 'ROOT',
    viewportWidth: rect.width ?? 1000,
    name: `${rect.width ?? 1000}px`,
  } as RootNode;
}

export function makeElement(
  children: SceneNode[] = [],
  rect: Partial<Rect> = {},
  overrides: Partial<ElementNode> = {},
): ElementNode {
  return {
    kind: 'ELEMENT',
    id: nextId(),
    name: 'div',
    rect: { x: 0, y: 0, width: 100, height: 100, ...rect },
    opacity: 1,
    blendMode: 'NORMAL',
    rotation: 0,
    sizing: { horizontal: 'FIXED', vertical: 'FIXED' },
    fills: [],
    stroke: null,
    corners: [0, 0, 0, 0],
    effects: [],
    clipsContent: false,
    layout: { mode: 'ABSOLUTE' },
    children,
    ...overrides,
  };
}

export const TEST_STYLE: TextStyle = {
  family: 'Inter',
  weight: 400,
  italic: false,
  size: 16,
  lineHeight: 24,
  letterSpacing: 0,
  fills: [{ kind: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1 }],
  decoration: 'NONE',
  textCase: 'ORIGINAL',
};

export function makeText(
  characters: string,
  rect: Partial<Rect> = {},
  overrides: Partial<TextNode> = {},
): TextNode {
  return {
    kind: 'TEXT',
    id: nextId(),
    name: characters.slice(0, 20),
    rect: { x: 0, y: 0, width: 200, height: 24, ...rect },
    opacity: 1,
    blendMode: 'NORMAL',
    rotation: 0,
    sizing: { horizontal: 'FIXED', vertical: 'FIXED' },
    characters,
    base: TEST_STYLE,
    segments: [],
    align: 'LEFT',
    verticalAlign: 'TOP',
    maxLines: null,
    fills: [],
    stroke: null,
    corners: [0, 0, 0, 0],
    effects: [],
    ...overrides,
  };
}

export function horizontal(gap: number, padding = 0): LayoutSpec {
  return {
    mode: 'HORIZONTAL',
    gap,
    counterGap: 0,
    padding: { top: padding, right: padding, bottom: padding, left: padding },
    wrap: false,
    primaryAlign: 'MIN',
    counterAlign: 'MIN',
  };
}

export function vertical(gap: number, padding = 0): LayoutSpec {
  return {
    mode: 'VERTICAL',
    gap,
    counterGap: 0,
    padding: { top: padding, right: padding, bottom: padding, left: padding },
    wrap: false,
    primaryAlign: 'MIN',
    counterAlign: 'MIN',
  };
}
