import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type BrowserContext, type Worker } from 'playwright';
import { validateCapture, type Capture, type ElementNode, type SceneNode } from '@h2f/schema';
import { parseCaptureArgs, runCapture } from '@h2f/cli';
import { serve, type StaticServer } from '../../cli/test/serve.js';

/**
 * End-to-end tests for the extension.
 *
 * They load the built extension into a real Chromium and drive the service
 * worker, because everything that makes the extension different from the CLI —
 * injecting the engine, screenshotting through `captureVisibleTab`, fetching
 * assets from a worker, saving through an offscreen document — only exists
 * inside a browser that has actually loaded it.
 *
 * The bar is not "the extension produces something": it is "the extension
 * produces what the CLI produces from the same page", since the two hosts share
 * a capture engine and are supposed to be interchangeable.
 */

const DIST = resolve(import.meta.dirname, '../dist');
const FIXTURES = resolve(import.meta.dirname, '../../../fixtures');

let context: BrowserContext;
let worker: Worker;
let server: StaticServer;
let profile: string;
let downloads: string;

interface RunState {
  status: string;
  message?: string;
  summary?: {
    filename: string;
    layers: number;
    assets: number;
    fonts: number;
    warnings: { code: string; count: number }[];
  };
}

beforeAll(async () => {
  server = await serve(FIXTURES);
  profile = mkdtempSync(join(tmpdir(), 'h2f-profile-'));
  downloads = mkdtempSync(join(tmpdir(), 'h2f-downloads-'));

  context = await chromium.launchPersistentContext(profile, {
    // Extensions need a full Chrome; the headless shell Playwright prefers by
    // default cannot load them at all.
    ...(process.env.H2F_CHROMIUM
      ? { executablePath: process.env.H2F_CHROMIUM }
      : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    // Fixed so a capture can be compared against the CLI at the same width.
    viewport: { width: 1200, height: 800 },
  });

  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

  // Downloads would otherwise land in the real user's Downloads folder.
  const session = await context.browser()!.newBrowserCDPSession();
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
}, 120_000);

afterAll(async () => {
  await context?.close();
  await server?.close();
  for (const path of [profile, downloads]) {
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

async function captureWithExtension(
  fixture: string,
): Promise<{ state: RunState; capture: Capture }> {
  const page = await context.newPage();
  await page.goto(`${server.origin}/${fixture}`, { waitUntil: 'networkidle' });

  const before = new Set(readdirSync(downloads));

  const state = (await worker.evaluate(
    async (tabId) =>
      (
        globalThis as unknown as {
          __h2fWorker: { run(options: { tabId: number }): Promise<unknown> };
        }
      ).__h2fWorker.run({ tabId }),
    await tabIdOf(page.url()),
  )) as RunState;

  await page.close();

  expect(state.status, state.message).toBe('done');

  // Chrome renames downloads redirected through CDP, so the new file is
  // identified by being new rather than by its name.
  const written = readdirSync(downloads).filter((name) => !before.has(name));
  expect(written, 'the extension did not save a file').toHaveLength(1);

  return {
    state,
    capture: JSON.parse(readFileSync(join(downloads, written[0]!), 'utf8')) as Capture,
  };
}

/** The worker resolves its own tabs; the tests have to ask it which is which. */
function tabIdOf(url: string): Promise<number> {
  return worker.evaluate(async (target) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === target);
    if (!tab?.id) throw new Error(`no tab for ${target}`);
    return tab.id;
  }, url);
}

function walk(node: SceneNode | Capture['roots'][number], out: SceneNode[] = []): SceneNode[] {
  out.push(node as SceneNode);
  for (const child of (node as ElementNode).children ?? []) walk(child, out);
  return out;
}

describe('capturing through the extension', () => {
  let result: { state: RunState; capture: Capture };

  beforeAll(async () => {
    result = await captureWithExtension('site.html');
  }, 180_000);

  it('writes a capture file that passes validation', () => {
    expect(validateCapture(result.capture)).toMatchObject({ ok: true, errors: [] });
  });

  it('records the page it captured', () => {
    expect(result.capture.meta.url).toBe(`${server.origin}/site.html`);
    expect(result.capture.meta.generator).toMatch(/@h2f\/capture/);
  });

  it('resolves image bytes the page itself could not have fetched', () => {
    const bitmaps = Object.values(result.capture.assets).filter((a) => a.kind === 'BITMAP');
    expect(bitmaps.length).toBeGreaterThan(0);
    for (const bitmap of bitmaps) {
      expect(bitmap.kind === 'BITMAP' && bitmap.bytes.length).toBeGreaterThan(0);
    }
  });

  it('leaves no unresolved assets behind', () => {
    for (const asset of Object.values(result.capture.assets)) {
      expect(asset.kind).not.toBe('PENDING');
    }
  });

  it('reports the same layer count it wrote to the file', () => {
    expect(result.state.summary!.layers).toBe(walk(result.capture.roots[0]!).length);
  });
});

describe('rasterizing what Figma cannot draw', () => {
  let capture: Capture;

  beforeAll(async () => {
    // The visuals fixture holds a skewed element and a clip-path, which are the
    // two cases the walker flags for a screenshot.
    capture = (await captureWithExtension('visuals.html')).capture;
  }, 180_000);

  it('fills in a bitmap for every element flagged for rasterizing', () => {
    const rasterized = walk(capture.roots[0]!).filter(
      (node): node is ElementNode => (node as ElementNode).rasterize !== undefined,
    );

    expect(rasterized.length).toBeGreaterThan(0);
    for (const node of rasterized) {
      const asset = capture.assets[node.rasterize!];
      expect(asset?.kind, `${node.name} has no bitmap`).toBe('BITMAP');
      expect(asset?.kind === 'BITMAP' && asset.width).toBeGreaterThan(0);
    }
  });

  /**
   * The crop is cut out of a screenshot of the whole viewport, so a mistake in
   * the scale or the offset still produces a perfectly valid image — of the
   * wrong part of the page. Matching the bitmap against the element's own
   * rectangle is what catches that.
   */
  it('cuts out the element and not some other part of the screenshot', () => {
    const rasterized = walk(capture.roots[0]!).filter(
      (node): node is ElementNode => (node as ElementNode).rasterize !== undefined,
    );

    for (const node of rasterized) {
      const asset = capture.assets[node.rasterize!];
      if (asset?.kind !== 'BITMAP') continue;

      // Device pixel ratio is 1 in the test browser, so bitmap pixels and CSS
      // pixels line up; a pixel of rounding each way is expected.
      expect(Math.abs(asset.width - node.rect.width), node.name).toBeLessThanOrEqual(1);
      expect(Math.abs(asset.height - node.rect.height), node.name).toBeLessThanOrEqual(1);
    }
  });
});

describe('against the CLI', () => {
  /**
   * The two hosts share a capture engine, so a page captured through either
   * should come back the same shape. This is the test that would catch the
   * extension host drifting away from the Playwright one.
   */
  it('produces the same tree as capturing the same page with the CLI', async () => {
    const fromExtension = (await captureWithExtension('layout.html')).capture;

    const cli = await runCapture(
      parseCaptureArgs([
        `${server.origin}/layout.html`,
        '--viewport',
        String(fromExtension.roots[0]!.viewportWidth),
        '--viewport-height',
        '720',
      ]),
    );

    const names = (capture: Capture): string[] => walk(capture.roots[0]!).map((node) => node.name);
    expect(names(fromExtension)).toEqual(names(cli.capture));
  }, 180_000);
});
