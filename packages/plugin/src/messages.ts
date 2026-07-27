import type { Capture } from '@h2f/schema';

/**
 * Messages between the plugin UI (an iframe, with DOM and `atob`) and the
 * sandbox (which has the Figma API but no DOM).
 *
 * Assets travel separately from the document because a media-heavy page
 * produces tens of megabytes of image bytes, and Figma's `postMessage` bridge
 * is not reliable at that size in a single call. Streaming them one at a time
 * also gives the UI something honest to show a progress bar with.
 */

export interface ImportOptions {
  /** Infer auto-layout, or place everything absolutely. */
  autoLayout: boolean;
  /** Create local paint and text styles for repeated values. */
  createStyles: boolean;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  autoLayout: true,
  createStyles: false,
};

/** Capture with image bytes removed; those arrive as separate messages. */
export type CaptureShell = Capture;

export type UiToCode =
  | { type: 'begin'; capture: CaptureShell; options: ImportOptions; assetCount: number }
  | { type: 'asset'; ref: string; bytes: Uint8Array }
  | { type: 'commit' }
  | { type: 'cancel' }
  | { type: 'resize'; width: number; height: number };

export type CodeToUi =
  | { type: 'progress'; phase: string; done: number; total: number }
  | { type: 'done'; layers: number; warnings: WarningSummary[]; elapsedMs: number }
  | { type: 'error'; message: string };

export interface WarningSummary {
  code: string;
  message: string;
  count: number;
}
