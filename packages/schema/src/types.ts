/**
 * The intermediate representation (IR) exchanged between the capture side
 * (browser) and the Figma plugin.
 *
 * Design rules for anything added here:
 *
 *  1. Plain JSON only. The whole document round-trips through `JSON.stringify`
 *     and through Figma's `postMessage` structured clone.
 *  2. No Figma vocabulary. The capture side must never need to know what a
 *     `SolidPaint` is; all Figma-specific mapping lives in `@h2f/plugin`.
 *  3. No CSS vocabulary either, where it can be avoided. Values are resolved,
 *     absolute and unit-less (pixels, degrees, 0..1 ratios) so the plugin never
 *     has to parse a string.
 */

/** Bumped whenever a change makes older capture files unreadable. */
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface Capture {
  version: number;
  meta: CaptureMeta;
  /** One root per requested viewport, laid out side by side in Figma. */
  roots: RootNode[];
  /** Deduplicated by content hash; keys are referenced by `AssetRef`. */
  assets: Record<string, Asset>;
  /** Every distinct font the page actually rendered text with. */
  fonts: FontUsage[];
  /** Everything the capture had to approximate, surfaced in the plugin UI. */
  warnings: Warning[];
}

export interface CaptureMeta {
  url: string;
  title: string;
  /** ISO 8601. */
  capturedAt: string;
  colorScheme: ColorScheme;
  locale: string;
  /** Version of the capture engine that produced this document. */
  generator: string;
}

export type ColorScheme = 'light' | 'dark';

export interface Warning {
  /** Machine-readable bucket, e.g. `transform.skew`, `font.missing`. */
  code: string;
  message: string;
  /** `name` of the node that triggered it, when applicable. */
  nodeName?: string;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export type AssetRef = string;

export type Asset = BitmapAsset | SvgAsset;

export interface BitmapAsset {
  kind: 'BITMAP';
  /** Base64, no data-URI prefix. Populated by the host, not by the capture. */
  bytes: string;
  mimeType: string;
  width: number;
  height: number;
  /** Original URL, kept for debugging and for the plugin's warning messages. */
  source?: string;
}

export interface SvgAsset {
  kind: 'SVG';
  /** Serialized `<svg>` markup, ready for `figma.createNodeFromSvg`. */
  markup: string;
  width: number;
  height: number;
  source?: string;
}

/**
 * An asset the capture identified but could not resolve to bytes in the page.
 * The host fetches these — Playwright in the CLI, the service worker in the
 * extension, neither bound by CORS — and replaces them with a real
 * `BitmapAsset`. Any that survive into the final document are dropped and
 * reported as a warning.
 */
export interface PendingAsset {
  kind: 'PENDING';
  url: string;
  /** Intrinsic size as the browser measured it, used to size the layer. */
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Rect {
  /** Relative to the parent node's border box. Root nodes use `0, 0`. */
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

export type Paint = SolidPaint | GradientPaint | ImagePaint;

/** Straight (non-premultiplied) RGBA, all channels 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface SolidPaint {
  kind: 'SOLID';
  color: Rgba;
  opacity: number;
  blendMode?: BlendMode;
}

export type GradientKind = 'LINEAR' | 'RADIAL' | 'CONIC' | 'DIAMOND';

export interface GradientStop {
  /** 0..1 along the gradient axis. */
  position: number;
  color: Rgba;
}

export interface GradientPaint {
  kind: 'GRADIENT';
  gradientKind: GradientKind;
  stops: GradientStop[];
  /**
   * Degrees clockwise from "pointing up", matching CSS `linear-gradient` angle
   * semantics. Only meaningful for LINEAR and CONIC.
   */
  angle: number;
  /** Center as a 0..1 fraction of the box. Only for RADIAL/CONIC/DIAMOND. */
  center: { x: number; y: number };
  /** Radii as a 0..1 fraction of the box. Only for RADIAL/DIAMOND. */
  radius: { x: number; y: number };
  opacity: number;
  blendMode?: BlendMode;
}

export type ImageScaleMode = 'FILL' | 'FIT' | 'CROP' | 'TILE';

export interface ImagePaint {
  kind: 'IMAGE';
  asset: AssetRef;
  scaleMode: ImageScaleMode;
  opacity: number;
  blendMode?: BlendMode;
  /** For TILE: size of one repetition relative to the box. */
  scalingFactor?: number;
  /** For CROP: normalized offset of the visible region. */
  offset?: { x: number; y: number };
}

export type BlendMode =
  | 'NORMAL'
  | 'MULTIPLY'
  | 'SCREEN'
  | 'OVERLAY'
  | 'DARKEN'
  | 'LIGHTEN'
  | 'COLOR_DODGE'
  | 'COLOR_BURN'
  | 'HARD_LIGHT'
  | 'SOFT_LIGHT'
  | 'DIFFERENCE'
  | 'EXCLUSION'
  | 'HUE'
  | 'SATURATION'
  | 'COLOR'
  | 'LUMINOSITY';

// ---------------------------------------------------------------------------
// Strokes, corners, effects
// ---------------------------------------------------------------------------

export interface Stroke {
  paints: Paint[];
  /** CSS border widths are per side; Figma supports this on frames and rects. */
  weights: { top: number; right: number; bottom: number; left: number };
  /**
   * Always `INSIDE`. CSS borders grow inward from the border box, so this is
   * what keeps padding maths consistent between the two models.
   */
  align: 'INSIDE';
  /** Empty for solid borders. */
  dashPattern: number[];
}

/** Clockwise from top-left, in pixels. */
export type Corners = [number, number, number, number];

export type Effect = ShadowEffect | BlurEffect;

export interface ShadowEffect {
  kind: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: Rgba;
  offset: { x: number; y: number };
  radius: number;
  spread: number;
  blendMode?: BlendMode;
}

export interface BlurEffect {
  kind: 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  radius: number;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type AxisAlign = 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';

export type LayoutSpec = AbsoluteLayout | AutoLayout;

export interface AbsoluteLayout {
  mode: 'ABSOLUTE';
}

export interface AutoLayout {
  mode: 'HORIZONTAL' | 'VERTICAL';
  /** Along the primary axis. */
  gap: number;
  /** Between wrapped lines. Only meaningful when `wrap` is true. */
  counterGap: number;
  padding: { top: number; right: number; bottom: number; left: number };
  wrap: boolean;
  primaryAlign: AxisAlign;
  counterAlign: Exclude<AxisAlign, 'SPACE_BETWEEN'>;
}

/** How a child behaves inside its parent's auto-layout. */
export type SizingMode = 'FIXED' | 'HUG' | 'FILL';

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export interface FontUsage {
  family: string;
  /** 100..900, already resolved from keywords like `bold`. */
  weight: number;
  italic: boolean;
}

export type TextDecoration = 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
export type TextCase = 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';

export interface TextStyle {
  family: string;
  weight: number;
  italic: boolean;
  size: number;
  /** Absolute pixels. `null` means the font's natural leading. */
  lineHeight: number | null;
  /** Absolute pixels. */
  letterSpacing: number;
  fills: Paint[];
  decoration: TextDecoration;
  textCase: TextCase;
}

export type TextAlign = 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
export type TextVerticalAlign = 'TOP' | 'CENTER' | 'BOTTOM';

/** A run of characters whose style differs from the node's base style. */
export interface TextSegment {
  start: number;
  end: number;
  style: Partial<TextStyle>;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type SceneNode = ElementNode | TextNode | ImageNode | SvgNode;

interface NodeBase {
  /** Stable within one capture; used for warning attribution and debugging. */
  id: string;
  /** Human-facing layer name, derived from tag + id/class/aria-label. */
  name: string;
  rect: Rect;
  opacity: number;
  blendMode: BlendMode;
  /** Degrees clockwise. Non-zero only for representable CSS transforms. */
  rotation: number;
  /** How this node sizes itself inside a parent auto-layout. */
  sizing: { horizontal: SizingMode; vertical: SizingMode };
}

export interface RootNode extends Omit<ElementNode, 'kind'> {
  kind: 'ROOT';
  /** Viewport width this root was captured at, used for the frame name. */
  viewportWidth: number;
}

export interface ElementNode extends NodeBase {
  kind: 'ELEMENT';
  fills: Paint[];
  stroke: Stroke | null;
  corners: Corners;
  effects: Effect[];
  clipsContent: boolean;
  layout: LayoutSpec;
  /**
   * Set when the element used CSS the IR cannot express (skew, mask-image,
   * complex clip-path, `<canvas>`, cross-origin iframe). The plugin renders it
   * as a single image and ignores `children`.
   */
  rasterize?: AssetRef;
  children: SceneNode[];
}

export interface TextNode extends NodeBase {
  kind: 'TEXT';
  characters: string;
  base: TextStyle;
  segments: TextSegment[];
  align: TextAlign;
  verticalAlign: TextVerticalAlign;
  /** Set when the element used `-webkit-line-clamp` or `text-overflow`. */
  maxLines: number | null;
  /** Text nodes can carry a background/border of their own. */
  fills: Paint[];
  stroke: Stroke | null;
  corners: Corners;
  effects: Effect[];
}

export interface ImageNode extends NodeBase {
  kind: 'IMAGE';
  asset: AssetRef;
  scaleMode: ImageScaleMode;
  corners: Corners;
  stroke: Stroke | null;
  effects: Effect[];
  /** Alt text, kept as the layer description. */
  alt: string;
}

export interface SvgNode extends NodeBase {
  kind: 'SVG';
  asset: AssetRef;
}
