/**
 * Bundle entry point.
 *
 * The build emits this as an IIFE assigned to `window.__h2f`, which is how both
 * hosts reach the engine: the CLI evaluates the bundle then calls
 * `__h2f.capture(...)`, and the browser extension will load the identical file
 * as a content script.
 */
export { capture, GENERATOR, RASTER_ATTRIBUTE } from './index.js';
export type { CaptureOptions } from './index.js';

// Exposed separately so a host can prepare the page, do its own work (resize,
// dismiss dialogs, switch theme) and only then walk the DOM.
export { preparePage, DEFAULT_PREPARE_OPTIONS } from './prepare.js';
