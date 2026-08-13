import { countPendingAssets, resolveAssets } from '@h2f/host';
import { validateCapture, type Capture } from '@h2f/schema';
import { createAssetAdapter } from './assets-adapter.js';
import { injectEngine, preparePage, walkPage } from './inject.js';
import { rasterizeMarked } from './raster.js';
import type { CaptureSettings, Phase } from './protocol.js';

export interface RunContext {
  tabId: number;
  windowId: number;
  settings: CaptureSettings;
  report: (phase: Phase, done: number, total: number) => void;
  isCancelled: () => boolean;
}

export class CancelledError extends Error {
  constructor() {
    super('Capture cancelled.');
  }
}

/**
 * Drive one capture of one tab.
 *
 * The order matches `packages/cli/src/capture.ts` deliberately: prepare, walk,
 * screenshot, then fetch. Screenshotting has to happen before the asset pass
 * because it scrolls the page, and the measurements the walk just took describe
 * the document as it stands right now.
 */
export async function runCapture(context: RunContext): Promise<Capture> {
  const { tabId, settings } = context;

  context.report('preparing', 0, 0);
  await injectEngine(tabId);
  await preparePage(tabId, settings.hideSelectors);
  throwIfCancelled(context);

  context.report('walking', 0, 0);
  const capture = await walkPage(tabId, settings.autoLayout);
  throwIfCancelled(context);

  context.report('rasterizing', 0, 0);
  capture.warnings.push(
    ...(await rasterizeMarked(capture, {
      tabId,
      windowId: context.windowId,
      onProgress: (done, total) => context.report('rasterizing', done, total),
      isCancelled: context.isCancelled,
    })),
  );
  throwIfCancelled(context);

  const pending = countPendingAssets(capture);
  context.report('assets', 0, pending);
  capture.warnings.push(
    ...(await resolveAssets(capture, createAssetAdapter(), {
      maxImageDim: settings.maxImageDim,
      concurrency: settings.concurrency,
      onProgress: (done, total) => context.report('assets', done, total),
    })),
  );
  throwIfCancelled(context);

  const validation = validateCapture(capture);
  if (!validation.ok) {
    throw new Error(
      `The capture failed validation, which is a bug. Please report it with the URL.\n` +
        validation.errors
          .slice(0, 5)
          .map((error) => `  - ${error}`)
          .join('\n'),
    );
  }

  return capture;
}

/**
 * Pages Chrome refuses to let an extension read, with an explanation a user can
 * act on. Without this the failure surfaces as a bare "Cannot access contents
 * of the page", which reads like a bug in the extension.
 */
export async function blockedReason(url: string | undefined): Promise<string | null> {
  if (!url) return 'This tab has not finished loading.';

  if (/^(chrome|edge|about|devtools|view-source):/i.test(url)) {
    return 'Browser pages cannot be captured. Open a website first.';
  }
  if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url)) {
    return 'Chrome blocks extensions on the Web Store. Try another page.';
  }
  if (url.startsWith('file://') && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    return 'Local files need “Allow access to file URLs” on the extension’s details page.';
  }
  return null;
}

export function captureFilename(capture: Capture, compress: boolean): string {
  let host = 'capture';
  try {
    host = new URL(capture.meta.url).hostname.replace(/^www\./, '') || host;
  } catch {
    // A blob or file URL: the fallback name is fine.
  }

  const stamp = capture.meta.capturedAt.slice(0, 19).replace(/[:T]/g, '-');
  return `${host}-${stamp}.h2d.json${compress ? '.gz' : ''}`;
}

export function countLayers(capture: Capture): number {
  const visit = (node: { children?: unknown[] }): number => {
    let total = 1;
    for (const child of node.children ?? []) total += visit(child as { children?: unknown[] });
    return total;
  };
  return capture.roots.reduce((sum, root) => sum + visit(root), 0);
}

export function groupWarnings(capture: Capture): { code: string; count: number }[] {
  const byCode = new Map<string, number>();
  for (const warning of capture.warnings) {
    byCode.set(warning.code, (byCode.get(warning.code) ?? 0) + 1);
  }
  return [...byCode].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
}

function throwIfCancelled(context: RunContext): void {
  if (context.isCancelled()) throw new CancelledError();
}
