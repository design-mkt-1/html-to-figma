import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { CAPTURE_BUNDLE } from '@h2f/capture/bundle';
import { validateCapture, type Capture, type Warning } from '@h2f/schema';
import { mergeCaptures } from './merge.js';
import type { CaptureCommandOptions } from './options.js';
import { rasterizeMarked } from './raster.js';
import { resolveAssets } from './resolve-assets.js';

export interface CaptureRunResult {
  capture: Capture;
  screenshot: Buffer | null;
}

/** Shape of the global the capture bundle installs. */
interface CaptureGlobal {
  capture(options: Record<string, unknown>): Promise<Capture>;
  preparePage(options: Record<string, unknown>): Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __h2f: CaptureGlobal;
}

export async function runCapture(options: CaptureCommandOptions): Promise<CaptureRunResult> {
  const browser = await chromium.launch({
    headless: true,
    // Lets a sandboxed or air-gapped environment point at a Chromium it already
    // has, instead of requiring `playwright install` to reach the network.
    ...(process.env.H2F_CHROMIUM ? { executablePath: process.env.H2F_CHROMIUM } : {}),
    ...(options.proxy
      ? { proxy: { server: options.proxy, bypass: options.proxyBypass.join(',') } }
      : {}),
  });

  try {
    const captures: Capture[] = [];
    let screenshot: Buffer | null = null;

    for (const [index, width] of options.viewports.entries()) {
      log(options, `capturing ${width}px`);

      const context = await browser.newContext({
        viewport: { width, height: options.viewportHeight },
        deviceScaleFactor: options.deviceScaleFactor,
        colorScheme: options.theme,
        locale: options.locale,
        // Needed behind a TLS-intercepting proxy, and for staging environments
        // with self-signed certificates.
        ignoreHTTPSErrors: options.insecure,
      });

      try {
        const result = await captureViewport(browser, context, width, options);
        captures.push(result.capture);
        if (index === 0) screenshot = result.screenshot;
      } finally {
        await context.close();
      }
    }

    const merged = mergeCaptures(captures);

    const validation = validateCapture(merged);
    if (!validation.ok) {
      throw new Error(
        `The capture failed validation, which is a bug. Please report it with the URL.\n` +
          validation.errors
            .slice(0, 10)
            .map((e) => `  - ${e}`)
            .join('\n'),
      );
    }

    return { capture: merged, screenshot };
  } finally {
    await browser.close();
  }
}

async function captureViewport(
  browser: Browser,
  context: BrowserContext,
  width: number,
  options: CaptureCommandOptions,
): Promise<CaptureRunResult> {
  const page = await context.newPage();
  const warnings: Warning[] = [];

  await page.goto(options.url, {
    waitUntil: options.waitUntil,
    timeout: options.timeout,
  });

  await dismissOverlays(page, options, warnings);
  if (options.delay > 0) await page.waitForTimeout(options.delay);

  // The bundle is injected rather than imported so the exact same file can be
  // shipped as an extension content script later.
  await page.evaluate(CAPTURE_BUNDLE);

  log(options, '  preparing page');
  await page.evaluate(
    (hideSelectors) =>
      globalThis.__h2f.preparePage({ scrollDelay: 60, settleDelay: 250, hideSelectors }),
    options.hideSelectors,
  );

  log(options, '  walking the DOM');
  const capture = (await page.evaluate(
    (input) =>
      globalThis.__h2f.capture({
        viewportWidth: input.viewportWidth,
        colorScheme: input.colorScheme,
        locale: input.locale,
        autoLayout: input.autoLayout,
        // Preparation already ran; repeating the scroll pass would only cost
        // time and risk re-triggering reveal animations.
        skipPrepare: true,
      }),
    {
      viewportWidth: width,
      colorScheme: options.theme,
      locale: options.locale,
      autoLayout: options.autoLayout,
    },
  )) as Capture;

  capture.warnings.push(...warnings);

  // Screenshots have to happen before assets, because resolving assets may
  // navigate the helper page and we want the document untouched until then.
  capture.warnings.push(...(await rasterizeMarked(page, capture, options)));

  const helperPage = await context.newPage();
  try {
    capture.warnings.push(
      ...(await resolveAssets(capture, context.request, helperPage, {
        maxImageDim: options.maxImageDim,
        verbose: options.verbose,
      })),
    );
  } finally {
    await helperPage.close();
  }

  let screenshot: Buffer | null = null;
  if (options.screenshot) {
    log(options, '  taking reference screenshot');
    await page.evaluate(() => window.scrollTo(0, 0));
    screenshot = await page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' });
  }

  await page.close();
  return { capture, screenshot };
}

/**
 * Click away consent dialogs before capturing.
 *
 * A cookie banner is the single most common way an otherwise perfect capture
 * comes back as a full-page overlay, so failures here are reported rather than
 * swallowed — the user needs to know their selector did not match.
 */
async function dismissOverlays(
  page: Page,
  options: CaptureCommandOptions,
  warnings: Warning[],
): Promise<void> {
  for (const selector of options.clickSelectors) {
    try {
      await page.click(selector, { timeout: 5_000 });
      await page.waitForTimeout(200);
    } catch {
      warnings.push({
        code: 'click.notFound',
        message: `--click selector never matched: ${selector}`,
      });
    }
  }
}

function log(options: CaptureCommandOptions, message: string): void {
  if (options.verbose) process.stderr.write(`${message}\n`);
}
