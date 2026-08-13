import type { Page } from 'playwright';
import type { Capture, Warning } from '@h2f/schema';
import { dropUnresolvedRasters, readImageSize } from '@h2f/host';

/** Kept in sync with `RASTER_ATTRIBUTE` in @h2f/capture. */
const RASTER_ATTRIBUTE = 'data-h2f-raster';

/**
 * Screenshot every element the walker flagged as unconvertible.
 *
 * The walker tags those elements in the live DOM as it goes, so this pass is a
 * single selector query rather than a second tree walk — and it runs against
 * the same page state the measurements were taken from.
 */
export async function rasterizeMarked(
  page: Page,
  capture: Capture,
  options: { verbose: boolean },
): Promise<Warning[]> {
  const warnings: Warning[] = [];
  const handles = await page.$$(`[${RASTER_ATTRIBUTE}]`);

  if (options.verbose && handles.length > 0) {
    process.stderr.write(`  rasterizing ${handles.length} elements\n`);
  }

  for (const handle of handles) {
    const nodeId = await handle.getAttribute(RASTER_ATTRIBUTE);
    if (!nodeId) continue;

    const ref = `raster:${nodeId}`;
    if (!(ref in capture.assets)) continue;

    try {
      // `scale: 'device'` honours the context's deviceScaleFactor so a
      // rasterized element is as crisp as the rest of the import.
      const bytes = await handle.screenshot({
        type: 'png',
        scale: 'device',
        timeout: 15_000,
        animations: 'disabled',
      });

      const size = readImageSize(bytes);
      capture.assets[ref] = {
        kind: 'BITMAP',
        bytes: bytes.toString('base64'),
        mimeType: 'image/png',
        width: size?.width ?? 0,
        height: size?.height ?? 0,
      };
    } catch (error) {
      delete capture.assets[ref];
      warnings.push({
        code: 'raster.failed',
        message: `Could not screenshot an element: ${(error as Error).message}`,
      });
    } finally {
      await handle.dispose();
    }
  }

  // Anything still pending never got a screenshot — an element that scrolled
  // out of existence, for instance. Drop it so validation stays clean.
  dropUnresolvedRasters(capture);

  return warnings;
}
