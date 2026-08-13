import { cropRegion, readImageSize, toBase64, dropUnresolvedRasters } from '@h2f/host';
import type { Capture, Warning } from '@h2f/schema';
import { focusRasterTarget, listRasterTargets, resetScroll } from './inject.js';

/**
 * Screenshot every element the walker flagged as unconvertible.
 *
 * Playwright can photograph an element directly; an extension cannot. All it
 * has is `captureVisibleTab`, which returns the visible viewport and nothing
 * else, so each element is scrolled into view, the viewport is captured, and
 * the element's rectangle is cut out of it.
 */

/**
 * Chrome allows roughly two `captureVisibleTab` calls a second and throws for
 * the rest, so the pass paces itself instead of failing and retrying its way
 * through a page.
 */
const CAPTURE_INTERVAL_MS = 550;

/**
 * A page with hundreds of flagged elements would take longer than anyone will
 * wait at half a second each. Past this many, the rest are reported rather than
 * captured — the layers still import, just without their bitmaps.
 */
const MAX_TARGETS = 60;

export interface RasterOptions {
  tabId: number;
  windowId: number;
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
}

export async function rasterizeMarked(
  capture: Capture,
  options: RasterOptions,
): Promise<Warning[]> {
  const warnings: Warning[] = [];
  const ids = (await listRasterTargets(options.tabId)).filter(
    (id) => `raster:${id}` in capture.assets,
  );

  const targets = ids.slice(0, MAX_TARGETS);
  if (ids.length > targets.length) {
    warnings.push({
      code: 'raster.skipped',
      message: `${ids.length - targets.length} elements were left without a flattened image because the page had more than ${MAX_TARGETS} of them`,
    });
  }

  let lastCaptureAt = 0;

  for (const [index, id] of targets.entries()) {
    if (options.isCancelled?.()) break;

    try {
      const target = await focusRasterTarget(options.tabId, id);
      if (!target) throw new Error('the element disappeared while capturing');

      const wait = CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
      if (wait > 0) await delay(wait);

      const dataUrl = await captureVisibleTab(options.windowId);
      lastCaptureAt = Date.now();

      const shot = await createImageBitmap(await (await fetch(dataUrl)).blob());
      try {
        // The screenshot is in device pixels and the rectangle in CSS pixels;
        // deriving the ratio from the image covers displays where Chrome caps
        // the capture below `devicePixelRatio`.
        const scale = shot.width / target.viewport.width;
        const region = cropRegion(target.rect, { width: shot.width, height: shot.height }, scale);
        if (!region) throw new Error('the element was not visible after scrolling to it');

        if (region.clipped) {
          warnings.push({
            code: 'raster.clipped',
            message: `Only the visible part of an element could be flattened; it is larger than the window`,
          });
        }

        const canvas = new OffscreenCanvas(region.width, region.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('no 2d context');

        context.drawImage(
          shot,
          region.sx,
          region.sy,
          region.sWidth,
          region.sHeight,
          0,
          0,
          region.width,
          region.height,
        );

        const bytes = new Uint8Array(
          await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
        );
        const size = readImageSize(bytes);

        capture.assets[`raster:${id}`] = {
          kind: 'BITMAP',
          bytes: toBase64(bytes),
          mimeType: 'image/png',
          width: size?.width ?? region.width,
          height: size?.height ?? region.height,
        };
      } finally {
        shot.close();
      }
    } catch (error) {
      delete capture.assets[`raster:${id}`];
      warnings.push({
        code: 'raster.failed',
        message: `Could not screenshot an element: ${(error as Error).message}`,
      });
    }

    options.onProgress?.(index + 1, targets.length);
  }

  await resetScroll(options.tabId).catch(() => undefined);

  // Anything still pending never got a screenshot. Drop it so validation stays
  // clean; the element itself survives as a plain frame.
  dropUnresolvedRasters(capture);
  return warnings;
}

/**
 * Photograph the visible viewport, retrying once if Chrome's rate limit was hit
 * anyway — the pacing above is a guess at a limit Chrome does not publish
 * exactly, and being wrong should cost a second rather than an element.
 */
async function captureVisibleTab(windowId: number): Promise<string> {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (error) {
    if (!/per second/i.test((error as Error).message)) throw error;
    await delay(1_000);
    return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
