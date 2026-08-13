import type { Capture } from '@h2f/schema';

/**
 * Everything that runs inside the page.
 *
 * The functions handed to `chrome.scripting.executeScript` are serialized and
 * re-parsed in the page, so each one has to be completely self-contained: no
 * imports, no module-scope constants, nothing captured from an enclosing scope.
 * Anything they need arrives through `args`.
 *
 * They run in the isolated world, which sees the same DOM as the page but none
 * of its JavaScript — the page cannot tamper with a capture in progress, and
 * `globalThis.__h2f` from the injected bundle survives between calls because
 * the isolated world persists for the life of the frame.
 */

/** Kept in sync with `RASTER_ATTRIBUTE` in @h2f/capture. */
const RASTER_ATTRIBUTE = 'data-h2f-raster';

export interface RasterTarget {
  id: string;
  rect: { x: number; y: number; width: number; height: number };
  /** Viewport size in CSS pixels, for working out the screenshot scale. */
  viewport: { width: number; height: number };
}

async function run<Args extends unknown[], Result>(
  tabId: number,
  func: (...args: Args) => Result,
  args: Args,
): Promise<Awaited<Result>> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: func as (...args: unknown[]) => unknown,
    args,
  });

  if (!injection) throw new Error('The page stopped responding.');
  return injection.result as Awaited<Result>;
}

/**
 * Load the capture engine.
 *
 * This is the same `capture.bundle.js` the CLI evaluates through Playwright,
 * byte for byte — the build copies it out of `@h2f/capture` untouched.
 */
export async function injectEngine(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['capture.bundle.js'],
  });
}

export function preparePage(tabId: number, hideSelectors: string[]): Promise<void> {
  return run(
    tabId,
    (selectors: string[]) =>
      globalThis.__h2f.preparePage({
        scrollDelay: 60,
        settleDelay: 250,
        hideSelectors: selectors,
      }),
    [hideSelectors],
  );
}

export function walkPage(tabId: number, autoLayout: boolean): Promise<Capture> {
  return run(
    tabId,
    (layout: boolean) =>
      globalThis.__h2f.capture({
        viewportWidth: window.innerWidth,
        colorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        locale: document.documentElement.lang || navigator.language,
        autoLayout: layout,
        // Preparation already ran; repeating the scroll pass would only cost
        // time and risk re-triggering reveal animations.
        skipPrepare: true,
      }),
    [autoLayout],
  );
}

/** Ids of the elements the walker flagged as unconvertible, in document order. */
export function listRasterTargets(tabId: number, attribute = RASTER_ATTRIBUTE): Promise<string[]> {
  return run(
    tabId,
    (attr: string) =>
      Array.from(document.querySelectorAll(`[${attr}]`))
        .map((element) => element.getAttribute(attr))
        .filter((id): id is string => id !== null),
    [attribute],
  );
}

/**
 * Scroll one flagged element into view and report where it landed.
 *
 * `captureVisibleTab` can only photograph the visible viewport, so every
 * element has to be brought into it first. Two animation frames after the
 * scroll is what makes the returned rectangle describe the pixels Chrome is
 * about to hand back rather than the ones it is still painting.
 */
export function focusRasterTarget(
  tabId: number,
  id: string,
  attribute = RASTER_ATTRIBUTE,
): Promise<RasterTarget | null> {
  return run(
    tabId,
    async (attr: string, nodeId: string) => {
      const element = document.querySelector(`[${attr}="${nodeId}"]`);
      if (!element) return null;

      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const rect = element.getBoundingClientRect();
      return {
        id: nodeId,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    },
    [attribute, id],
  );
}

export function resetScroll(tabId: number): Promise<void> {
  return run(tabId, () => void window.scrollTo(0, 0), []);
}

declare global {
  // eslint-disable-next-line no-var
  var __h2f: {
    capture(options: Record<string, unknown>): Promise<Capture>;
    preparePage(options: Record<string, unknown>): Promise<void>;
  };
}
