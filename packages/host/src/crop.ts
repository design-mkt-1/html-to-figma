export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface CropRegion {
  /** Source rectangle, in pixels of the captured image. */
  sx: number;
  sy: number;
  sWidth: number;
  sHeight: number;
  /** Output size, which is the source size — cropping never rescales. */
  width: number;
  height: number;
  /**
   * The element extended past the captured area and only part of it is here.
   * A screenshot host cannot fix this by cropping harder, so it reports it.
   */
  clipped: boolean;
}

/**
 * Work out which part of a viewport screenshot holds a given element.
 *
 * `chrome.tabs.captureVisibleTab` can only ever return the visible viewport, at
 * whatever pixel density the display uses — and that density is not always
 * `devicePixelRatio`, because the capture is capped on some platforms. Deriving
 * the scale from the returned image instead of assuming it keeps the crop
 * correct on a Retina display, on a 100% display and on a capped one alike.
 *
 * @param element  Element rectangle in CSS pixels, relative to the viewport.
 * @param image    Size of the captured screenshot, in image pixels.
 * @param scale    Image pixels per CSS pixel, i.e. `image.width / innerWidth`.
 */
export function cropRegion(element: Rect, image: Size, scale: number): CropRegion | null {
  if (!(scale > 0) || image.width <= 0 || image.height <= 0) return null;

  const left = element.x * scale;
  const top = element.y * scale;
  const right = (element.x + element.width) * scale;
  const bottom = (element.y + element.height) * scale;

  const sx = Math.max(0, Math.round(left));
  const sy = Math.max(0, Math.round(top));
  const sRight = Math.min(image.width, Math.round(right));
  const sBottom = Math.min(image.height, Math.round(bottom));

  const sWidth = sRight - sx;
  const sHeight = sBottom - sy;
  if (sWidth <= 0 || sHeight <= 0) return null;

  // A sub-pixel difference is rounding, not clipping; anything more means the
  // element genuinely ran off the captured area.
  const clipped =
    left < -0.5 || top < -0.5 || right > image.width + 0.5 || bottom > image.height + 0.5;

  return { sx, sy, sWidth, sHeight, width: sWidth, height: sHeight, clipped };
}
