import type {
  BlendMode,
  ElementNode,
  FontUsage,
  ImageNode,
  ImageScaleMode,
  Rect,
  RootNode,
  SceneNode,
  SizingMode,
  SvgNode,
  TextNode,
  Warning,
} from '@h2f/schema';
import { AssetRegistry, resolveUrl } from './assets.js';
import { inferLayout, type LayoutChild } from './layout.js';
import { nameFor } from './naming.js';
import { parseBackground } from './styles/background.js';
import { parseBorder, parseCorners } from './styles/border.js';
import { toPixels } from './styles/css-values.js';
import { parseEffects } from './styles/effects.js';
import { isItalic, parseFontWeight } from './styles/font.js';
import { analyzeTransform } from './styles/transform.js';
import {
  extractText,
  readMaxLines,
  readTextAlign,
  readTextStyle,
  readVerticalAlign,
} from './text.js';

export interface WalkOptions {
  /** Infer auto-layout, or emit everything absolutely positioned. */
  autoLayout: boolean;
  /** Hard ceiling so a pathological page cannot hang the capture. */
  maxNodes: number;
  maxDepth: number;
}

export const DEFAULT_WALK_OPTIONS: WalkOptions = {
  autoLayout: true,
  maxNodes: 20_000,
  maxDepth: 64,
};

/** Marks elements the host has to screenshot; read back by the CLI. */
export const RASTER_ATTRIBUTE = 'data-h2f-raster';

/** Tags that never produce a visible box. */
const SKIPPED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'LINK',
  'META',
  'HEAD',
  'TITLE',
  'NOSCRIPT',
  'TEMPLATE',
  'BASE',
  'PARAM',
  'SOURCE',
  'TRACK',
  'MAP',
  'AREA',
]);

const BLEND_MODES: Record<string, BlendMode> = {
  normal: 'NORMAL',
  multiply: 'MULTIPLY',
  screen: 'SCREEN',
  overlay: 'OVERLAY',
  darken: 'DARKEN',
  lighten: 'LIGHTEN',
  'color-dodge': 'COLOR_DODGE',
  'color-burn': 'COLOR_BURN',
  'hard-light': 'HARD_LIGHT',
  'soft-light': 'SOFT_LIGHT',
  difference: 'DIFFERENCE',
  exclusion: 'EXCLUSION',
  hue: 'HUE',
  saturation: 'SATURATION',
  color: 'COLOR',
  luminosity: 'LUMINOSITY',
};

interface DocRect extends Rect {}

const DEFAULT_SIZING = { horizontal: 'FIXED' as SizingMode, vertical: 'FIXED' as SizingMode };

export class Walker {
  readonly assets = new AssetRegistry();
  readonly warnings: Warning[] = [];

  private readonly fonts = new Map<string, FontUsage>();
  private nodeCount = 0;
  private idCounter = 0;

  constructor(private readonly options: WalkOptions) {}

  fontList(): FontUsage[] {
    return [...this.fonts.values()];
  }

  /**
   * Build the root frame for the current document.
   *
   * The root takes its background from `<html>`/`<body>` — CSS propagates the
   * body background to the canvas, so reading it off `<body>` alone would leave
   * the page transparent in Figma for a large share of real sites.
   */
  walkRoot(viewportWidth: number): RootNode {
    const html = document.documentElement;
    const body = document.body;

    const width = Math.max(html.scrollWidth, viewportWidth);
    const height = Math.max(html.scrollHeight, body?.scrollHeight ?? 0, window.innerHeight);

    const rootRect: DocRect = { x: 0, y: 0, width, height };
    const htmlStyle = window.getComputedStyle(html);
    const bodyStyle = body ? window.getComputedStyle(body) : htmlStyle;

    const canvasSource = hasOwnBackground(htmlStyle) ? htmlStyle : bodyStyle;
    const background = parseBackground(canvasSource, { width, height }, this.assets);

    const children: SceneNode[] = [];
    if (body) {
      const node = this.walkElement(body, rootRect, 0);
      if (node) children.push(node);
    }

    return {
      kind: 'ROOT',
      id: this.nextId(),
      name: `${viewportWidth}px`,
      viewportWidth,
      rect: rootRect,
      opacity: 1,
      blendMode: 'NORMAL',
      rotation: 0,
      sizing: { ...DEFAULT_SIZING },
      fills: background.paints,
      stroke: null,
      corners: [0, 0, 0, 0],
      effects: [],
      clipsContent: true,
      layout: { mode: 'ABSOLUTE' },
      children,
    };
  }

  // -------------------------------------------------------------------------

  private walkElement(element: Element, parentRect: DocRect, depth: number): SceneNode | null {
    if (this.nodeCount >= this.options.maxNodes) return null;
    if (depth > this.options.maxDepth) {
      this.warn('depth.exceeded', `Stopped at depth ${depth}`, nameFor(element));
      return null;
    }
    if (SKIPPED_TAGS.has(element.tagName)) return null;

    const style = window.getComputedStyle(element);
    if (style.display === 'none') return null;

    // `display: contents` boxes generate no geometry of their own; their
    // children participate in the parent's layout directly.
    if (style.display === 'contents') return null;

    const geometry = this.measure(element, style, parentRect);
    if (!geometry) return null;

    this.nodeCount++;
    const { rect, docRect, transform } = geometry;

    // A leaf with no size and nothing to paint is not worth a layer.
    if (rect.width < 0.5 && rect.height < 0.5 && element.childElementCount === 0) return null;

    const raster = this.rasterReason(element, style, transform);
    if (raster) {
      return this.rasterNode(element, style, rect, raster);
    }

    const special = this.specialElement(element, style, rect);
    if (special) return special;

    const text = this.textNode(element, style, rect);
    if (text) return text;

    return this.elementNode(element, style, rect, docRect, depth);
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  private measure(
    element: Element,
    style: CSSStyleDeclaration,
    parentRect: DocRect,
  ): { rect: Rect; docRect: DocRect; transform: ReturnType<typeof analyzeTransform> } | null {
    const box = element.getBoundingClientRect();
    if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) return null;

    const transform = analyzeTransform(style.transform);

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    let width = box.width;
    let height = box.height;
    let left = box.left + scrollX;
    let top = box.top + scrollY;

    if (transform.kind === 'ROTATE') {
      // `getBoundingClientRect` returns the axis-aligned bounds of the
      // *transformed* box, which is larger than the element for any rotation.
      // The layout size comes from `offsetWidth`/`offsetHeight`, which ignore
      // transforms, and the centre of the AABB is the image of the element's
      // centre under any affine map — so the two together recover the real box.
      const layoutWidth = (element as HTMLElement).offsetWidth || box.width;
      const layoutHeight = (element as HTMLElement).offsetHeight || box.height;

      width = layoutWidth * transform.scaleX;
      height = layoutHeight * transform.scaleY;
      left = box.left + scrollX + box.width / 2 - width / 2;
      top = box.top + scrollY + box.height / 2 - height / 2;
    }

    const docRect: DocRect = { x: left, y: top, width, height };
    const rect: Rect = {
      x: round(left - parentRect.x),
      y: round(top - parentRect.y),
      width: round(Math.max(0, width)),
      height: round(Math.max(0, height)),
    };

    return { rect, docRect, transform };
  }

  // -------------------------------------------------------------------------
  // Rasterization
  // -------------------------------------------------------------------------

  /**
   * Decide whether an element has to be flattened to a bitmap.
   *
   * This is the escape hatch that keeps the rest of the converter honest: CSS
   * that genuinely has no Figma equivalent produces a correct-looking image
   * rather than a silently wrong vector.
   */
  private rasterReason(
    element: Element,
    style: CSSStyleDeclaration,
    transform: ReturnType<typeof analyzeTransform>,
  ): string | null {
    if (transform.kind === 'UNSUPPORTED') return 'transform';

    // Rotation is representable, but only on a leaf: a rotated container's
    // descendants would all be measured in the rotated frame and come out
    // doubly transformed.
    if (transform.kind === 'ROTATE' && Math.abs(transform.rotation) > 0.01) {
      if (element.childElementCount > 0) return 'transform.rotatedContainer';
    }

    const mask = style.getPropertyValue('mask-image') || style.getPropertyValue('-webkit-mask-image');
    if (mask && mask !== 'none') return 'mask';

    if (style.clipPath && style.clipPath !== 'none') return 'clip-path';

    const { unsupportedFilters } = parseEffects(style);
    if (unsupportedFilters.length > 0) return `filter:${unsupportedFilters.join(',')}`;

    if (element.tagName === 'IFRAME' && !isSameOriginFrame(element as HTMLIFrameElement)) {
      return 'iframe.crossOrigin';
    }

    return null;
  }

  private rasterNode(
    element: Element,
    style: CSSStyleDeclaration,
    rect: Rect,
    reason: string,
  ): ElementNode {
    const id = this.nextId();
    // The host locates the element by this attribute to screenshot it.
    element.setAttribute(RASTER_ATTRIBUTE, id);

    this.warn(
      `rasterized.${reason.split(':')[0]}`,
      `Flattened to an image because of ${reason}`,
      nameFor(element),
    );

    return {
      kind: 'ELEMENT',
      id,
      name: nameFor(element),
      rect,
      opacity: opacityOf(style),
      blendMode: blendModeOf(style),
      rotation: 0,
      sizing: { ...DEFAULT_SIZING },
      fills: [],
      stroke: null,
      corners: [0, 0, 0, 0],
      effects: [],
      clipsContent: false,
      layout: { mode: 'ABSOLUTE' },
      rasterize: this.assets.addRasterPlaceholder(id, Math.ceil(rect.width), Math.ceil(rect.height)),
      children: [],
    };
  }

  // -------------------------------------------------------------------------
  // Replaced elements
  // -------------------------------------------------------------------------

  private specialElement(
    element: Element,
    style: CSSStyleDeclaration,
    rect: Rect,
  ): SceneNode | null {
    const tag = element.tagName;

    if (tag === 'IMG') {
      return this.imageNode(element as HTMLImageElement, style, rect);
    }

    if (tag === 'svg') {
      return this.svgNode(element as SVGElement, style, rect);
    }

    if (tag === 'CANVAS') {
      return this.canvasNode(element as HTMLCanvasElement, style, rect);
    }

    if (tag === 'VIDEO') {
      const poster = (element as HTMLVideoElement).poster;
      if (poster) {
        const ref = this.assets.addPending(poster, Math.ceil(rect.width), Math.ceil(rect.height));
        if (ref) return this.makeImageNode(element, style, rect, ref, 'FILL', 'video poster');
      }
      this.warn('video.noPoster', 'Video has no poster frame; captured as an empty box', nameFor(element));
      return null;
    }

    return null;
  }

  private imageNode(
    element: HTMLImageElement,
    style: CSSStyleDeclaration,
    rect: Rect,
  ): SceneNode | null {
    // `currentSrc` is what the browser actually picked out of `srcset`, so the
    // capture inherits the correct responsive variant for the viewport.
    const src = element.currentSrc || element.src;
    if (!src) return null;

    const ref = this.assets.addPending(
      src,
      Math.max(element.naturalWidth, Math.ceil(rect.width)),
      Math.max(element.naturalHeight, Math.ceil(rect.height)),
    );
    if (!ref) return null;

    return this.makeImageNode(element, style, rect, ref, objectFitToScaleMode(style.objectFit), element.alt);
  }

  private svgNode(element: SVGElement, style: CSSStyleDeclaration, rect: Rect): SvgNode | null {
    let markup: string;
    try {
      markup = serializeSvg(element, rect);
    } catch {
      return null;
    }

    return {
      kind: 'SVG',
      id: this.nextId(),
      name: nameFor(element),
      rect,
      opacity: opacityOf(style),
      blendMode: blendModeOf(style),
      rotation: 0,
      sizing: { ...DEFAULT_SIZING },
      asset: this.assets.addSvg(markup, Math.ceil(rect.width), Math.ceil(rect.height)),
    };
  }

  private canvasNode(
    element: HTMLCanvasElement,
    style: CSSStyleDeclaration,
    rect: Rect,
  ): SceneNode | null {
    let dataUrl: string;
    try {
      // Throws for a canvas tainted by cross-origin drawing.
      dataUrl = element.toDataURL('image/png');
    } catch {
      this.warn('canvas.tainted', 'Canvas is cross-origin tainted and could not be read', nameFor(element));
      return null;
    }

    const ref = this.assets.addPending(dataUrl, element.width, element.height);
    if (!ref) return null;
    return this.makeImageNode(element, style, rect, ref, 'FILL', 'canvas');
  }

  private makeImageNode(
    element: Element,
    style: CSSStyleDeclaration,
    rect: Rect,
    asset: string,
    scaleMode: ImageScaleMode,
    alt: string,
  ): ImageNode {
    const { corners } = parseCorners(style, rect.width, rect.height);
    const { stroke } = parseBorder(style);
    const { effects } = parseEffects(style);

    return {
      kind: 'IMAGE',
      id: this.nextId(),
      name: nameFor(element, alt || undefined),
      rect,
      opacity: opacityOf(style),
      blendMode: blendModeOf(style),
      rotation: 0,
      sizing: { ...DEFAULT_SIZING },
      asset,
      scaleMode,
      corners,
      stroke,
      effects,
      alt,
    };
  }

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  private textNode(element: Element, style: CSSStyleDeclaration, rect: Rect): TextNode | null {
    if (!isTextContainer(element)) return null;

    const sample = element.textContent ?? '';
    const base = readTextStyle(style, sample);
    const content = extractText(element, base);
    if (!content) return null;

    this.recordFont(base.family, base.weight, base.italic);
    for (const segment of content.segments) {
      this.recordFont(
        segment.style.family ?? base.family,
        segment.style.weight ?? base.weight,
        segment.style.italic ?? base.italic,
      );
    }

    const { corners } = parseCorners(style, rect.width, rect.height);
    const { stroke } = parseBorder(style);
    const { effects } = parseEffects(style);
    const background = parseBackground(style, rect, this.assets);

    return {
      kind: 'TEXT',
      id: this.nextId(),
      name: nameFor(element, content.characters),
      rect,
      opacity: opacityOf(style),
      blendMode: blendModeOf(style),
      rotation: 0,
      sizing: { ...DEFAULT_SIZING },
      characters: content.characters,
      base,
      segments: content.segments,
      align: readTextAlign(style),
      verticalAlign: readVerticalAlign(style),
      maxLines: readMaxLines(style),
      fills: background.paints,
      stroke,
      corners,
      effects,
    };
  }

  // -------------------------------------------------------------------------
  // Generic elements
  // -------------------------------------------------------------------------

  private elementNode(
    element: Element,
    style: CSSStyleDeclaration,
    rect: Rect,
    docRect: DocRect,
    depth: number,
  ): ElementNode {
    const id = this.nextId();
    const transform = analyzeTransform(style.transform);

    const children: SceneNode[] = [];
    const layoutChildren: LayoutChild[] = [];

    for (const child of childElementsOf(element)) {
      const node = this.walkElement(child, docRect, depth + 1);
      if (!node) continue;

      children.push(node);
      const childStyle = window.getComputedStyle(child);
      layoutChildren.push({
        rect: node.rect,
        outOfFlow: isOutOfFlow(childStyle.position),
        grow: Number.parseFloat(childStyle.flexGrow) || 0,
        stretches: childStyle.alignSelf === 'stretch' || style.alignItems === 'stretch',
      });
    }

    for (const pseudo of this.pseudoNodes(element, style, rect)) {
      // Pseudo-elements paint before and after the element's own children, but
      // their geometry is approximate, so they never take part in layout
      // inference — a wrong guess there would move real content.
      children.unshift(pseudo);
      layoutChildren.length = 0;
    }

    const { layout, sizing } = inferLayout(
      style,
      layoutChildren,
      { width: rect.width, height: rect.height },
      this.options.autoLayout && layoutChildren.length === children.length,
    );

    for (let i = 0; i < children.length && i < sizing.length; i++) {
      children[i]!.sizing = sizing[i]!;
    }

    const background = parseBackground(style, rect, this.assets);
    for (const unsupported of background.unsupported) {
      this.warn('background.unsupported', `Could not convert background "${unsupported}"`, nameFor(element));
    }

    const { stroke, mixedColors } = parseBorder(style);
    if (mixedColors) {
      this.warn(
        'border.mixedColors',
        'Border sides use different colours; Figma supports only one stroke colour',
        nameFor(element),
      );
    }

    const { corners, elliptical } = parseCorners(style, rect.width, rect.height);
    if (elliptical) {
      this.warn('corner.elliptical', 'Elliptical corner radius approximated', nameFor(element));
    }

    const { effects } = parseEffects(style);

    return {
      kind: 'ELEMENT',
      id,
      name: nameFor(element),
      rect,
      opacity: opacityOf(style),
      blendMode: blendModeOf(style),
      rotation: transform.kind === 'ROTATE' ? transform.rotation : 0,
      sizing: { ...DEFAULT_SIZING },
      fills: visibilityOf(style) ? background.paints : [],
      stroke: visibilityOf(style) ? stroke : null,
      corners,
      effects,
      clipsContent: clipsContent(style),
      layout,
      children,
    };
  }

  // -------------------------------------------------------------------------
  // Pseudo-elements
  // -------------------------------------------------------------------------

  /**
   * Reconstruct `::before` and `::after`.
   *
   * These have no DOM node, so no rect can be measured for them — the geometry
   * here is derived from their computed size and the parent's padding box. It
   * is good enough for the overwhelmingly common cases (icon chips, decorative
   * bars, overlay scrims) and every one is flagged as approximate.
   */
  private *pseudoNodes(
    element: Element,
    parentStyle: CSSStyleDeclaration,
    parentRect: Rect,
  ): Generator<ElementNode> {
    for (const selector of ['::before', '::after'] as const) {
      let style: CSSStyleDeclaration;
      try {
        style = window.getComputedStyle(element, selector);
      } catch {
        continue;
      }

      const content = style.content;
      if (!content || content === 'none' || content === 'normal') continue;
      if (style.display === 'none') continue;

      const width = toPixels(style.width, parentRect.width) ?? 0;
      const height = toPixels(style.height, parentRect.height) ?? 0;

      const background = parseBackground(style, { width, height }, this.assets);
      const hasPaint = background.paints.length > 0 || style.borderStyle !== 'none';
      // Text-bearing pseudo-elements would need font metrics we cannot measure;
      // only decorative boxes are reconstructed.
      if (!hasPaint || width <= 0 || height <= 0) continue;

      const borderLeft = toPixels(parentStyle.borderLeftWidth, 0) ?? 0;
      const borderTop = toPixels(parentStyle.borderTopWidth, 0) ?? 0;
      const isAbsolute = isOutOfFlow(style.position);

      const x = isAbsolute ? (toPixels(style.left, parentRect.width) ?? borderLeft) : borderLeft;
      const y = isAbsolute ? (toPixels(style.top, parentRect.height) ?? borderTop) : borderTop;

      const rect: Rect = { x: round(x), y: round(y), width: round(width), height: round(height) };
      const { corners } = parseCorners(style, width, height);
      const { stroke } = parseBorder(style);
      const { effects } = parseEffects(style);

      this.warn(
        'pseudo.approximate',
        `${selector} reconstructed from computed styles; position is approximate`,
        nameFor(element),
      );

      yield {
        kind: 'ELEMENT',
        id: this.nextId(),
        name: `${nameFor(element)}${selector}`,
        rect,
        opacity: opacityOf(style),
        blendMode: blendModeOf(style),
        rotation: 0,
        sizing: { ...DEFAULT_SIZING },
        fills: background.paints,
        stroke,
        corners,
        effects,
        clipsContent: false,
        layout: { mode: 'ABSOLUTE' },
        children: [],
      };
    }
  }

  // -------------------------------------------------------------------------

  private recordFont(family: string, weight: number, italic: boolean): void {
    const key = `${family}|${weight}|${italic}`;
    if (!this.fonts.has(key)) this.fonts.set(key, { family, weight, italic });
  }

  private warn(code: string, message: string, nodeName?: string): void {
    // Warnings are per-node but the UI shows them grouped; cap the raw list so
    // a page with a thousand rotated icons does not produce a thousand lines.
    if (this.warnings.length >= 500) return;
    this.warnings.push(nodeName ? { code, message, nodeName } : { code, message });
  }

  private nextId(): string {
    return `n${this.idCounter++}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Children to walk, accounting for shadow DOM.
 *
 * Slotted light-DOM children are rendered at their `<slot>` position, so they
 * are walked through the shadow tree and skipped in the light tree — otherwise
 * every slotted element would appear twice.
 */
function childElementsOf(element: Element): Element[] {
  if (element.shadowRoot) {
    return Array.from(element.shadowRoot.children);
  }

  if (element.tagName === 'SLOT' && 'assignedElements' in element) {
    const assigned = (element as HTMLSlotElement).assignedElements();
    return assigned.length > 0 ? assigned : Array.from(element.children);
  }

  if (element.tagName === 'IFRAME') {
    const doc = (element as HTMLIFrameElement).contentDocument;
    return doc?.body ? [doc.body] : [];
  }

  const children = Array.from(element.children);
  // A light-DOM child assigned to a slot is drawn inside the shadow tree, not
  // here; `assignedSlot` is how the platform tells us that.
  return children.filter((child) => !(child as Element & { assignedSlot?: unknown }).assignedSlot);
}

/** An element is a text container when its content is entirely inline. */
function isTextContainer(element: Element): boolean {
  let hasText = false;

  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.nodeValue ?? '').trim() !== '') hasText = true;
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const child = node as Element;
    if (SKIPPED_TAGS.has(child.tagName)) continue;
    if (child.tagName === 'BR') continue;

    const style = window.getComputedStyle(child);
    if (style.display === 'none') continue;

    // Any block-level or replaced child means this is a container, not a text
    // run, and its children must become separate layers.
    if (!style.display.startsWith('inline')) return false;
    if (child.tagName === 'IMG' || child.tagName === 'svg' || child.tagName === 'CANVAS') {
      return false;
    }
    if (!isTextContainer(child) && child.childElementCount > 0) return false;
    if ((child.textContent ?? '').trim() !== '') hasText = true;
  }

  return hasText;
}

function isSameOriginFrame(frame: HTMLIFrameElement): boolean {
  try {
    return frame.contentDocument !== null;
  } catch {
    return false;
  }
}

function isOutOfFlow(position: string): boolean {
  return position === 'absolute' || position === 'fixed' || position === 'sticky';
}

function hasOwnBackground(style: CSSStyleDeclaration): boolean {
  if (style.backgroundImage && style.backgroundImage !== 'none') return true;
  const color = style.backgroundColor;
  return Boolean(color) && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent';
}

function clipsContent(style: CSSStyleDeclaration): boolean {
  const overflow = `${style.overflowX} ${style.overflowY}`;
  return overflow.includes('hidden') || overflow.includes('clip') || overflow.includes('auto') || overflow.includes('scroll');
}

function opacityOf(style: CSSStyleDeclaration): number {
  const value = Number.parseFloat(style.opacity);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

function visibilityOf(style: CSSStyleDeclaration): boolean {
  return style.visibility === 'visible';
}

function blendModeOf(style: CSSStyleDeclaration): BlendMode {
  return BLEND_MODES[style.mixBlendMode] ?? 'NORMAL';
}

function objectFitToScaleMode(objectFit: string): ImageScaleMode {
  switch (objectFit) {
    case 'contain':
    case 'scale-down':
      return 'FIT';
    case 'none':
      return 'CROP';
    default:
      return 'FILL';
  }
}

/**
 * Serialize an inline `<svg>` for `figma.createNodeFromSvg`.
 *
 * Figma's SVG importer needs explicit dimensions; many inline SVGs rely on CSS
 * for sizing and would otherwise import at their intrinsic or zero size.
 */
function serializeSvg(element: SVGElement, rect: Rect): string {
  const clone = element.cloneNode(true) as SVGElement;
  clone.setAttribute('width', String(Math.max(1, Math.round(rect.width))));
  clone.setAttribute('height', String(Math.max(1, Math.round(rect.height))));

  if (!clone.getAttribute('viewBox')) {
    const box = element.getAttribute('viewBox');
    if (box) clone.setAttribute('viewBox', box);
  }
  if (!clone.getAttribute('xmlns')) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }

  // `currentColor` resolves against the element's computed colour, which is
  // lost once the markup leaves the page.
  const color = window.getComputedStyle(element).color;
  return clone.outerHTML.replace(/currentColor/g, color);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
