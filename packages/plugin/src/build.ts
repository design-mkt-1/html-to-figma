import type {
  Capture,
  ElementNode,
  ImageNode,
  RootNode,
  SceneNode as IrNode,
  SizingMode,
  Stroke,
  SvgNode,
  TextNode as IrTextNode,
  Warning,
} from '@h2f/schema';
import { FontResolver } from './convert/font.js';
import { toEffects } from './convert/effects.js';
import { toPaints, toRgb } from './convert/paint.js';
import { mergeStyle, resolveStyle, toLetterSpacing, toLineHeight } from './convert/text.js';
import type { ImportOptions } from './messages.js';

/**
 * The slice of the Figma API the builder uses.
 *
 * Depending on this rather than the `figma` global is what lets the whole
 * builder run under a mock in Node, so the tree it produces can be asserted
 * without a Figma editor in the loop.
 */
export type BuilderApi = Pick<
  PluginAPI,
  | 'createFrame'
  | 'createText'
  | 'createRectangle'
  | 'createImage'
  | 'createNodeFromSvg'
  | 'loadFontAsync'
  | 'listAvailableFontsAsync'
>;

/**
 * How far a child may drift from its captured position before the parent's
 * auto-layout is considered a bad guess. One pixel is below the threshold of
 * visibility but well above floating-point noise.
 */
const LAYOUT_TOLERANCE = 1;

/** Nodes to build between yields, so Figma's UI keeps repainting. */
const YIELD_INTERVAL = 250;

export interface BuildResult {
  roots: FrameNode[];
  layers: number;
  warnings: Warning[];
}

export interface BuildCallbacks {
  onProgress?(phase: string, done: number, total: number): void;
}

export class Builder {
  private readonly warnings: Warning[] = [];
  private readonly imageHashes = new Map<string, string>();
  /**
   * Text layers whose box had to grow beyond the captured width to keep the
   * captured line breaks (Figma's font metrics rarely match the browser's to
   * the pixel). Value is the final width; positions and the layout check use
   * it instead of the captured width.
   */
  private readonly widthOverrides = new Map<SceneNode, number>();
  /** How far a widened text layer must shift left so its glyphs stay put. */
  private readonly xNudges = new Map<SceneNode, number>();
  private fonts!: FontResolver;
  private layers = 0;
  private sinceYield = 0;

  constructor(
    private readonly api: BuilderApi,
    private readonly capture: Capture,
    private readonly assetBytes: Map<string, Uint8Array>,
    private readonly options: ImportOptions,
    private readonly callbacks: BuildCallbacks = {},
  ) {}

  async build(): Promise<BuildResult> {
    this.warnings.push(...this.capture.warnings);

    await this.prepareFonts();
    this.prepareImages();

    const roots: FrameNode[] = [];
    let offsetX = 0;

    for (const root of this.capture.roots) {
      const frame = (await this.buildNode(root, null)) as FrameNode | null;
      if (!frame) continue;

      // Multiple viewports sit side by side with a visible gutter rather than
      // stacked, which is how anyone comparing breakpoints wants to see them.
      frame.x = offsetX;
      frame.y = 0;
      offsetX += frame.width + 120;

      roots.push(frame);
    }

    return { roots, layers: this.layers, warnings: this.warnings };
  }

  // -------------------------------------------------------------------------
  // Preparation
  // -------------------------------------------------------------------------

  /**
   * Load every font before any text node exists.
   *
   * `createText` and every range setter throw if the font is not already
   * loaded, and the error surfaces far from the cause, so this happens up front
   * for the whole document.
   */
  private async prepareFonts(): Promise<void> {
    const available = await this.api.listAvailableFontsAsync();
    this.fonts = new FontResolver(available.map((font) => font.fontName));

    const { fonts, missing } = this.fonts.resolveAll(this.capture.fonts);

    for (const [index, fontName] of fonts.entries()) {
      this.callbacks.onProgress?.('Loading fonts', index + 1, fonts.length);
      try {
        await this.api.loadFontAsync(fontName);
      } catch {
        this.warnings.push({
          code: 'font.loadFailed',
          message: `Could not load ${fontName.family} ${fontName.style}`,
        });
      }
    }

    if (missing.length > 0) {
      this.warnings.push({
        code: 'font.missing',
        message: `Not installed in Figma, substituted: ${missing.slice(0, 8).join(', ')}${
          missing.length > 8 ? `, +${missing.length - 8} more` : ''
        }`,
      });
    }
  }

  private prepareImages(): void {
    let done = 0;

    for (const [ref, asset] of Object.entries(this.capture.assets)) {
      done++;
      if (asset.kind !== 'BITMAP') continue;

      const bytes = this.assetBytes.get(ref);
      if (!bytes || bytes.length === 0) continue;

      try {
        this.imageHashes.set(ref, this.api.createImage(bytes).hash);
      } catch (error) {
        this.warnings.push({
          code: 'image.rejected',
          message: `Figma rejected an image: ${(error as Error).message}`,
        });
      }

      this.callbacks.onProgress?.('Creating images', done, Object.keys(this.capture.assets).length);
    }
  }

  private lookupImage = (ref: string): string | null => this.imageHashes.get(ref) ?? null;

  // -------------------------------------------------------------------------
  // Node construction
  // -------------------------------------------------------------------------

  private async buildNode(
    node: IrNode | RootNode,
    parent: FrameNode | null,
  ): Promise<SceneNode | null> {
    if (this.sinceYield++ >= YIELD_INTERVAL) {
      this.sinceYield = 0;
      this.callbacks.onProgress?.('Building layers', this.layers, 0);
      await yieldToUi();
    }

    let built: SceneNode | null;

    switch (node.kind) {
      case 'ROOT':
      case 'ELEMENT':
        built = await this.buildFrame(node);
        break;
      case 'TEXT':
        built = this.buildText(node);
        break;
      case 'IMAGE':
        built = this.buildImage(node);
        break;
      case 'SVG':
        built = this.buildSvg(node);
        break;
      default:
        built = null;
    }

    if (!built) return null;

    // Parenting happens here rather than in each builder so every node kind is
    // attached exactly once, whatever it turned out to be.
    if (parent) parent.appendChild(built);
    this.layers++;

    built.name = node.name || built.name;
    if (node.opacity < 1 && 'opacity' in built) built.opacity = node.opacity;
    if (node.blendMode !== 'NORMAL' && 'blendMode' in built) built.blendMode = node.blendMode;

    // CSS rotation is clockwise, Figma's is counter-clockwise.
    if (node.rotation !== 0 && 'rotation' in built) {
      built.rotation = -node.rotation;
    }

    return built;
  }

  private async buildFrame(node: ElementNode | RootNode): Promise<FrameNode> {
    const frame = this.api.createFrame();
    // Figma frames default to a white fill; a page whose divs are all opaque
    // white would otherwise look right by accident and wrong everywhere else.
    frame.fills = [];
    frame.clipsContent = node.clipsContent;

    resize(frame, node.rect.width, node.rect.height);

    if (node.rasterize) {
      const hash = this.lookupImage(node.rasterize);
      if (hash) {
        frame.fills = [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' }];
        return frame;
      }
    }

    frame.fills = toPaints(node.fills, this.lookupImage);
    applyStroke(frame, node.stroke);
    applyCorners(frame, node.corners);
    frame.effects = toEffects(node.effects);

    for (const child of node.children) {
      const built = await this.buildNode(child, frame);
      if (!built) continue;
      // Position is meaningful only while the frame has no auto-layout; the
      // layout pass below either keeps these or restores them after a revert.
      built.x = child.rect.x - (this.xNudges.get(built) ?? 0);
      built.y = child.rect.y;
    }

    this.applyLayout(frame, node);
    return frame;
  }

  private buildText(node: IrTextNode): TextNode | null {
    const text = this.api.createText();

    const baseFont = this.fonts.resolve({
      family: node.base.family,
      weight: node.base.weight,
      italic: node.base.italic,
    });

    try {
      text.fontName = baseFont.fontName;
      text.characters = node.characters;
    } catch (error) {
      this.warnings.push({
        code: 'text.failed',
        message: `Could not create a text layer: ${(error as Error).message}`,
        nodeName: node.name,
      });
      text.remove();
      return null;
    }

    const base = resolveStyle(node.base, baseFont.fontName);
    text.fontSize = base.fontSize;
    text.lineHeight = base.lineHeight;
    text.letterSpacing = base.letterSpacing;
    text.textDecoration = base.textDecoration;
    text.textCase = base.textCase;
    text.textAlignHorizontal = node.align;
    text.textAlignVertical = node.verticalAlign;
    text.fills = toPaints(node.base.fills, this.lookupImage);

    // Segments first: a bolder run reflows the layer, so the box can only be
    // sized once every range carries its final font.
    this.applySegments(text, node);
    this.fitToCapture(text, node, lineHeightPx(base.lineHeight, base.fontSize));

    if (node.maxLines !== null) {
      text.textTruncation = 'ENDING';
      text.maxLines = node.maxLines;
    }

    return text;
  }

  /**
   * Size the box to the captured rect without letting the text re-wrap.
   *
   * The captured rect is measured against the browser's font; Figma's copy of
   * the same family (or a substitute) is usually a hair wider, and a box sized
   * to the browser's pixel re-wraps — "Acme" becomes "Acm / e" and everything
   * below the extra line is overlapped. So the box grows by the smallest amount
   * that restores the captured line count, and centred or right-aligned layers
   * are nudged left so the glyphs stay where they were captured.
   *
   * Under the Node mock, `resize` never reflows, so both measurements read back
   * the values just written and this is a no-op beyond the captured size.
   */
  private fitToCapture(text: TextNode, node: IrTextNode, lineHeight: number): void {
    const captured = node.rect;
    const capturedLines = Math.max(1, Math.round(captured.height / lineHeight));
    let width = captured.width;

    if (capturedLines === 1) {
      // A single captured line must never wrap: Figma reports the natural
      // width, and the box keeps whichever is wider. The baseline resize is
      // what makes this a no-op under the mock, whose resize never reflows.
      resize(text, captured.width, captured.height);
      text.textAutoResize = 'WIDTH_AND_HEIGHT';
      if (text.width > captured.width) width = text.width + 0.5;
    } else {
      text.textAutoResize = 'HEIGHT';
      resize(text, captured.width, captured.height);

      // Grow until the natural height fits the captured line count, within
      // reason — a substitute font 25% wider is beyond rescuing.
      const targetHeight = captured.height + lineHeight / 2;
      const maxWidth = captured.width * 1.25 + 8;
      while (text.height > targetHeight && width < maxWidth) {
        width = Math.min(maxWidth, width * 1.02 + 1);
        resize(text, width, text.height);
      }
    }

    text.textAutoResize = 'NONE';
    resize(text, width, captured.height);

    const delta = width - captured.width;
    if (delta > 0) {
      this.widthOverrides.set(text, width);
      if (node.align === 'CENTER') this.xNudges.set(text, delta / 2);
      else if (node.align === 'RIGHT') this.xNudges.set(text, delta);
    }
  }

  /**
   * Apply per-range styling for inline runs.
   *
   * Each range setter can throw independently (an unloaded font, an out-of-
   * range index after `textCase` changed the character count), and losing one
   * bold word is much better than losing the whole paragraph — so each is
   * guarded on its own.
   */
  private applySegments(text: TextNode, node: IrTextNode): void {
    for (const segment of node.segments) {
      const start = Math.max(0, segment.start);
      const end = Math.min(text.characters.length, segment.end);
      if (start >= end) continue;

      const merged = mergeStyle(node.base, segment.style);

      const apply = (fn: () => void) => {
        try {
          fn();
        } catch {
          // Reported once per node rather than once per property.
        }
      };

      if (segment.style.family || segment.style.weight || segment.style.italic !== undefined) {
        const font = this.fonts.resolve({
          family: merged.family,
          weight: merged.weight,
          italic: merged.italic,
        });
        apply(() => text.setRangeFontName(start, end, font.fontName));
      }

      if (segment.style.size !== undefined) {
        apply(() => text.setRangeFontSize(start, end, Math.max(1, merged.size)));
      }
      if (segment.style.lineHeight !== undefined) {
        apply(() => text.setRangeLineHeight(start, end, toLineHeight(merged.lineHeight)));
      }
      if (segment.style.letterSpacing !== undefined) {
        apply(() => text.setRangeLetterSpacing(start, end, toLetterSpacing(merged.letterSpacing)));
      }
      if (segment.style.decoration !== undefined) {
        apply(() => text.setRangeTextDecoration(start, end, merged.decoration));
      }
      if (segment.style.textCase !== undefined) {
        apply(() => text.setRangeTextCase(start, end, merged.textCase));
      }
      if (segment.style.fills !== undefined) {
        apply(() => text.setRangeFills(start, end, toPaints(merged.fills, this.lookupImage)));
      }
    }
  }

  private buildImage(node: ImageNode): SceneNode | null {
    const hash = this.lookupImage(node.asset);
    if (!hash) return null;

    const rect = this.api.createRectangle();
    resize(rect, node.rect.width, node.rect.height);

    rect.fills = [
      {
        type: 'IMAGE',
        imageHash: hash,
        scaleMode: node.scaleMode === 'CROP' ? 'FILL' : node.scaleMode,
      },
    ];

    applyStroke(rect, node.stroke);
    applyCorners(rect, node.corners);
    rect.effects = toEffects(node.effects);

    return rect;
  }

  private buildSvg(node: SvgNode): SceneNode | null {
    const asset = this.capture.assets[node.asset];
    if (!asset || asset.kind !== 'SVG') return null;

    try {
      const frame = this.api.createNodeFromSvg(asset.markup);
      resize(frame, node.rect.width, node.rect.height);
      return frame;
    } catch (error) {
      this.warnings.push({
        code: 'svg.failed',
        message: `Could not import an SVG: ${(error as Error).message}`,
        nodeName: node.name,
      });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Auto-layout, with verification
  // -------------------------------------------------------------------------

  /**
   * Apply inferred auto-layout, then check it actually reproduced the capture.
   *
   * This is the safety net that makes layout inference worth doing at all.
   * Auto-layout is a guess: Figma's box model is not CSS's, and a container
   * whose children Figma lays out even slightly differently would shift
   * everything inside it. So the result is measured against the captured
   * rectangles and reverted to absolute positioning if it does not match.
   * Auto-layout can therefore only ever be an improvement.
   */
  private applyLayout(frame: FrameNode, node: ElementNode | RootNode): void {
    const layout = node.layout;
    if (layout.mode === 'ABSOLUTE' || !this.options.autoLayout) return;
    if (frame.children.length === 0) return;

    try {
      frame.layoutMode = layout.mode;
      frame.itemSpacing = layout.gap;
      frame.paddingTop = layout.padding.top;
      frame.paddingRight = layout.padding.right;
      frame.paddingBottom = layout.padding.bottom;
      frame.paddingLeft = layout.padding.left;
      frame.primaryAxisAlignItems = layout.primaryAlign;
      frame.counterAxisAlignItems = layout.counterAlign;

      if (layout.wrap) {
        frame.layoutWrap = 'WRAP';
        frame.counterAxisSpacing = layout.counterGap;
      }

      // The frame's own size is known; only the children's placement is being
      // inferred, so both axes stay fixed.
      frame.primaryAxisSizingMode = 'FIXED';
      frame.counterAxisSizingMode = 'FIXED';
      resize(frame, node.rect.width, node.rect.height);

      applyChildSizing(frame, node.children);
    } catch (error) {
      this.revertLayout(frame, node, `Figma rejected the layout: ${(error as Error).message}`);
      return;
    }

    const drift = measureDrift(frame, node.children, this.widthOverrides);
    if (drift > LAYOUT_TOLERANCE) {
      this.revertLayout(frame, node, `auto-layout moved children by up to ${drift.toFixed(1)}px`);
    }
  }

  private revertLayout(frame: FrameNode, node: ElementNode | RootNode, reason: string): void {
    frame.layoutMode = 'NONE';
    resize(frame, node.rect.width, node.rect.height);

    // Children keep whatever Figma's layout left them at, so their captured
    // positions have to be written back explicitly.
    frame.children.forEach((child, index) => {
      const source = node.children[index];
      if (!source) return;
      child.x = source.rect.x - (this.xNudges.get(child) ?? 0);
      child.y = source.rect.y;
      resize(child, this.widthOverrides.get(child) ?? source.rect.width, source.rect.height);
    });

    this.warnings.push({
      code: 'layout.reverted',
      message: `Used absolute positioning because ${reason}`,
      nodeName: node.name,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyChildSizing(frame: FrameNode, sources: IrNode[]): void {
  frame.children.forEach((child, index) => {
    const source = sources[index];
    if (!source) return;

    // Absolutely positioned children are excluded from the flow entirely
    // rather than being allowed to push their siblings around.
    try {
      setSizing(child, 'layoutSizingHorizontal', source.sizing.horizontal);
      setSizing(child, 'layoutSizingVertical', source.sizing.vertical);
    } catch {
      // FILL is rejected on some node types; FIXED is always valid.
    }
  });
}

function setSizing(
  child: SceneNode,
  property: 'layoutSizingHorizontal' | 'layoutSizingVertical',
  mode: SizingMode,
): void {
  if (mode === 'FIXED') return;
  if (property in child) {
    (child as unknown as Record<string, string>)[property] = mode;
  }
}

/** The largest distance any child ended up from where it was captured. */
function measureDrift(
  frame: FrameNode,
  sources: IrNode[],
  widthOverrides: Map<SceneNode, number>,
): number {
  let worst = 0;

  frame.children.forEach((child, index) => {
    const source = sources[index];
    if (!source) return;

    worst = Math.max(
      worst,
      Math.abs(child.x - source.rect.x),
      Math.abs(child.y - source.rect.y),
      Math.abs(child.width - (widthOverrides.get(child) ?? source.rect.width)),
      Math.abs(child.height - source.rect.height),
    );
  });

  return worst;
}

/** The pixel height of one line, from whatever unit the capture recorded. */
function lineHeightPx(lineHeight: LineHeight, fontSize: number): number {
  if (lineHeight.unit === 'PIXELS') return Math.max(1, lineHeight.value);
  if (lineHeight.unit === 'PERCENT') return Math.max(1, (fontSize * lineHeight.value) / 100);
  return fontSize * 1.2;
}

function applyStroke(node: FrameNode | RectangleNode, stroke: Stroke | null): void {
  if (!stroke) return;

  node.strokes = toPaints(stroke.paints, () => null);
  node.strokeAlign = 'INSIDE';
  if (stroke.dashPattern.length > 0) node.dashPattern = stroke.dashPattern;

  // Per-side widths need a uniform strokeWeight set first; Figma treats the
  // individual properties as overrides of it.
  node.strokeWeight = Math.max(
    stroke.weights.top,
    stroke.weights.right,
    stroke.weights.bottom,
    stroke.weights.left,
  );

  node.strokeTopWeight = stroke.weights.top;
  node.strokeRightWeight = stroke.weights.right;
  node.strokeBottomWeight = stroke.weights.bottom;
  node.strokeLeftWeight = stroke.weights.left;
}

function applyCorners(
  node: FrameNode | RectangleNode,
  corners: [number, number, number, number],
): void {
  const [tl, tr, br, bl] = corners;
  if (tl === 0 && tr === 0 && br === 0 && bl === 0) return;

  node.topLeftRadius = tl;
  node.topRightRadius = tr;
  node.bottomRightRadius = br;
  node.bottomLeftRadius = bl;
}

/** Figma throws on a zero or negative dimension. */
function resize(node: SceneNode, width: number, height: number): void {
  if (!('resize' in node)) return;
  (node as FrameNode).resize(Math.max(0.01, width), Math.max(0.01, height));
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export { toRgb };
