import { SCHEMA_VERSION, type Capture, type ColorScheme } from '@h2f/schema';
import { DEFAULT_PREPARE_OPTIONS, preparePage, type PrepareOptions } from './prepare.js';
import { DEFAULT_WALK_OPTIONS, Walker, type WalkOptions } from './walk.js';

export { RASTER_ATTRIBUTE } from './walk.js';
export type { WalkOptions } from './walk.js';
export type { PrepareOptions } from './prepare.js';

export const GENERATOR = `@h2f/capture ${SCHEMA_VERSION}.0`;

export interface CaptureOptions extends Partial<WalkOptions>, Partial<PrepareOptions> {
  /** Width the host set the viewport to; recorded on the root frame. */
  viewportWidth: number;
  colorScheme?: ColorScheme;
  locale?: string;
  /** Skip page preparation when the host has already done it. */
  skipPrepare?: boolean;
}

/**
 * Capture the current document.
 *
 * Returns a document whose assets are still `PENDING` — resolving those to
 * bytes is the host's job, because only the host can fetch cross-origin URLs
 * and screenshot elements.
 */
export async function capture(options: CaptureOptions): Promise<Capture> {
  const prepareOptions: PrepareOptions = {
    ...DEFAULT_PREPARE_OPTIONS,
    ...pick(options, ['scrollDelay', 'settleDelay', 'hideSelectors']),
  };

  if (!options.skipPrepare) {
    await preparePage(prepareOptions);
  }

  const walkOptions: WalkOptions = {
    ...DEFAULT_WALK_OPTIONS,
    ...pick(options, ['autoLayout', 'maxNodes', 'maxDepth']),
  };

  const walker = new Walker(walkOptions);
  const root = walker.walkRoot(options.viewportWidth);

  return {
    version: SCHEMA_VERSION,
    meta: {
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
      colorScheme: options.colorScheme ?? detectColorScheme(),
      locale: options.locale ?? document.documentElement.lang ?? navigator.language,
      generator: GENERATOR,
    },
    roots: [root],
    // Cast: assets are PENDING at this point and the host replaces them.
    assets: walker.assets.toJSON() as Capture['assets'],
    fonts: walker.fontList(),
    warnings: walker.warnings,
  };
}

function detectColorScheme(): ColorScheme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function pick<T extends object, K extends keyof T>(source: T, keys: K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}
