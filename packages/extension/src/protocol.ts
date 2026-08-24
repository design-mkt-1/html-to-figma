/**
 * Messages between the three contexts the extension runs in.
 *
 * The popup is the only one a user sees and the only one that can disappear
 * mid-run — Chrome tears it down the moment focus leaves it. So the popup owns
 * no state: it connects, renders whatever the worker reports, and can be closed
 * and reopened at any point during a capture without affecting it.
 */

export interface CaptureSettings {
  /** Infer auto-layout, or emit everything absolutely positioned. */
  autoLayout: boolean;
  /** Selectors removed before capturing, e.g. cookie banners. */
  hideSelectors: string[];
  /** Write a gzipped `.h2d.gz`; the plugin reads either. */
  compress: boolean;
  /** Figma rejects images above 4096px, so anything larger is downscaled. */
  maxImageDim: number;
  /** Parallel asset fetches. */
  concurrency: number;
  /**
   * Widths to capture, side by side in one file. `0` means the browser's
   * current width and needs no emulation; every other width reflows the page
   * through the debugger protocol for the duration of the capture.
   */
  viewports: number[];
}

export const DEFAULT_SETTINGS: CaptureSettings = {
  autoLayout: true,
  hideSelectors: [],
  compress: false,
  maxImageDim: 4096,
  concurrency: 8,
  viewports: [0],
};

export type Phase = 'preparing' | 'walking' | 'rasterizing' | 'assets' | 'writing';

export const PHASE_LABELS: Record<Phase, string> = {
  preparing: 'Loading the whole page',
  walking: 'Reading the DOM',
  rasterizing: 'Screenshotting what Figma cannot draw',
  assets: 'Downloading images',
  writing: 'Writing the capture file',
};

export interface WarningCount {
  code: string;
  count: number;
}

export interface CaptureSummary {
  title: string;
  url: string;
  filename: string;
  layers: number;
  assets: number;
  fonts: number;
  bytes: number;
  elapsedMs: number;
  warnings: WarningCount[];
}

export type RunState =
  | { status: 'idle' }
  | { status: 'running'; phase: Phase; done: number; total: number }
  | { status: 'done'; summary: CaptureSummary }
  | { status: 'error'; message: string };

/** popup → worker */
export type PopupMessage =
  | { type: 'start'; settings: CaptureSettings }
  | { type: 'cancel' }
  | { type: 'saveSettings'; settings: CaptureSettings }
  /** Ask for the last capture's JSON, to put on the clipboard for the plugin. */
  | { type: 'copy' };

/** worker → popup */
export type WorkerMessage =
  | { type: 'state'; state: RunState }
  | { type: 'settings'; settings: CaptureSettings }
  /**
   * The last capture, streamed in chunks — one multi-megabyte port message is
   * the same call that fails on the offscreen bridge, so the same chunking.
   */
  | { type: 'captureJson'; chunk: string; done: boolean }
  /** The worker restarted since the capture; its JSON is gone. */
  | { type: 'copyUnavailable' };

/**
 * worker → offscreen document.
 *
 * A capture of a media-heavy page runs to tens of megabytes of JSON, so it
 * crosses in chunks rather than as one string — the same reason the Figma
 * plugin streams assets across its own bridge.
 */
export type OffscreenMessage =
  | { target: 'offscreen'; type: 'begin' }
  | { target: 'offscreen'; type: 'chunk'; text: string }
  | { target: 'offscreen'; type: 'finish'; compress: boolean }
  | { target: 'offscreen'; type: 'revoke'; url: string };

export interface OffscreenResult {
  url: string;
  bytes: number;
}

export const CHUNK_SIZE = 4_000_000;
