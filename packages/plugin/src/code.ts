import { validateCapture, type Capture, type Warning } from '@h2f/schema';
import { Builder } from './build.js';
import {
  DEFAULT_IMPORT_OPTIONS,
  type CodeToUi,
  type ImportOptions,
  type UiToCode,
  type WarningSummary,
} from './messages.js';

/**
 * Sandbox entry point.
 *
 * Runs in Figma's QuickJS environment: the Figma API is available, the DOM is
 * not. Anything needing `atob`, `FileReader` or `fetch` lives in the UI.
 */

figma.showUI(__html__, { width: 380, height: 520, themeColors: true });

interface Session {
  capture: Capture;
  options: ImportOptions;
  assets: Map<string, Uint8Array>;
  assetCount: number;
}

let session: Session | null = null;

figma.ui.onmessage = (message: UiToCode) => {
  switch (message.type) {
    case 'begin':
      session = {
        capture: message.capture,
        options: message.options ?? DEFAULT_IMPORT_OPTIONS,
        assets: new Map(),
        assetCount: message.assetCount,
      };
      break;

    case 'asset':
      session?.assets.set(message.ref, message.bytes);
      break;

    case 'commit':
      void runImport();
      break;

    case 'resize':
      figma.ui.resize(Math.max(320, message.width), Math.max(320, message.height));
      break;

    case 'cancel':
      figma.closePlugin();
      break;
  }
};

async function runImport(): Promise<void> {
  const current = session;
  session = null;

  if (!current) {
    post({ type: 'error', message: 'No capture was loaded.' });
    return;
  }

  const validation = validateCapture(current.capture);
  if (!validation.ok) {
    post({
      type: 'error',
      message: `This file is not a valid capture:\n${validation.errors.slice(0, 5).join('\n')}`,
    });
    return;
  }

  const started = Date.now();

  try {
    const builder = new Builder(figma, current.capture, current.assets, current.options, {
      onProgress(phase, done, total) {
        post({ type: 'progress', phase, done, total });
      },
    });

    const result = await builder.build();

    for (const root of result.roots) {
      figma.currentPage.appendChild(root);
    }

    if (result.roots.length > 0) {
      placeBesideExistingContent(result.roots);
      figma.currentPage.selection = result.roots;
      figma.viewport.scrollAndZoomIntoView(result.roots);
    }

    post({
      type: 'done',
      layers: result.layers,
      warnings: summarize(result.warnings),
      elapsedMs: Date.now() - started,
    });
  } catch (error) {
    post({ type: 'error', message: (error as Error).message ?? String(error) });
  }
}

/**
 * Drop the import to the right of whatever is already on the page, so running
 * the plugin twice does not stack two pages on top of each other.
 */
function placeBesideExistingContent(roots: FrameNode[]): void {
  const others = figma.currentPage.children.filter((child) => !roots.includes(child as FrameNode));
  if (others.length === 0) return;

  const right = Math.max(...others.map((node) => node.x + node.width));
  const top = Math.min(...others.map((node) => node.y));

  const shift = right + 200 - roots[0]!.x;
  for (const root of roots) {
    root.x += shift;
    root.y = top;
  }
}

/** Collapse per-node warnings into one line per kind. */
function summarize(warnings: Warning[]): WarningSummary[] {
  const byCode = new Map<string, WarningSummary>();

  for (const warning of warnings) {
    const existing = byCode.get(warning.code);
    if (existing) {
      existing.count++;
      continue;
    }
    byCode.set(warning.code, { code: warning.code, message: warning.message, count: 1 });
  }

  return [...byCode.values()].sort((a, b) => b.count - a.count);
}

function post(message: CodeToUi): void {
  figma.ui.postMessage(message);
}
