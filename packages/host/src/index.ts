/**
 * Host-side logic shared by every capture host.
 *
 * A "host" is whatever drives the capture engine and owns the network: the
 * Playwright CLI in Node, and the extension's service worker in Chrome. The
 * parts that differ between them are narrow — fetching bytes, decoding an
 * image, taking a screenshot — and are injected. Everything else lives here so
 * the two hosts cannot drift apart, which matters most for the rules that
 * decide whether a capture passes validation.
 */

export { toBase64, fromBase64 } from './base64.js';
export { cropRegion, type CropRegion, type Rect, type Size } from './crop.js';
export { decodeDataUrl, decodeUtf8, looksLikeSvg, type RawBytes } from './data-url.js';
export { readImageSize, type ImageSize } from './image-size.js';
export { dropUnresolvedRasters, pruneMissingAssets } from './prune.js';
export {
  countPendingAssets,
  resolveAssets,
  type AssetAdapter,
  type DecodedImage,
  type ResolveOptions,
} from './resolve-assets.js';
