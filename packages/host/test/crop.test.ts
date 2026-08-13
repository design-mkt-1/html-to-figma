import { describe, expect, it } from 'vitest';
import { cropRegion } from '../src/crop.js';

/**
 * The crop is the only piece of the extension's screenshot path that can be
 * tested without a browser, and it is where the mistakes are: a screenshot is
 * in device pixels, an element rectangle is in CSS pixels, and the two are only
 * equal on a display nobody designs on.
 */

const IMAGE_1X = { width: 1280, height: 720 };
const IMAGE_2X = { width: 2560, height: 1440 };

describe('cropRegion', () => {
  it('passes the rectangle through unchanged at 1x', () => {
    const region = cropRegion({ x: 100, y: 50, width: 200, height: 80 }, IMAGE_1X, 1);

    expect(region).toEqual({
      sx: 100,
      sy: 50,
      sWidth: 200,
      sHeight: 80,
      width: 200,
      height: 80,
      clipped: false,
    });
  });

  it('scales CSS pixels to device pixels at 2x', () => {
    const region = cropRegion({ x: 100, y: 50, width: 200, height: 80 }, IMAGE_2X, 2);

    expect(region).toMatchObject({ sx: 200, sy: 100, sWidth: 400, sHeight: 160, clipped: false });
  });

  it('derives the scale from the image, not from devicePixelRatio', () => {
    // A capped capture: the display is 2x but Chrome returned a 1x image.
    const region = cropRegion({ x: 10, y: 10, width: 100, height: 100 }, IMAGE_1X, 1);
    expect(region).toMatchObject({ sx: 10, sWidth: 100 });
  });

  it('rounds sub-pixel rectangles rather than dropping fractions', () => {
    const region = cropRegion({ x: 10.4, y: 10.6, width: 100.2, height: 99.9 }, IMAGE_1X, 1);

    // Edges round independently: left 10.4 to 10 and right 110.6 to 111 widen
    // the crop, which is what keeps a hairline border inside the screenshot.
    expect(region).toMatchObject({ sx: 10, sy: 11, sWidth: 101, sHeight: 100 });
  });

  it('clamps to the image and reports an element that ran off the bottom', () => {
    const region = cropRegion({ x: 0, y: 600, width: 1280, height: 400 }, IMAGE_1X, 1);

    expect(region).toMatchObject({ sy: 600, sHeight: 120, clipped: true });
  });

  it('reports an element that starts above the viewport', () => {
    const region = cropRegion({ x: 0, y: -50, width: 100, height: 200 }, IMAGE_1X, 1);

    expect(region).toMatchObject({ sy: 0, sHeight: 150, clipped: true });
  });

  it('returns null when the element is entirely outside the capture', () => {
    expect(cropRegion({ x: 0, y: 800, width: 100, height: 100 }, IMAGE_1X, 1)).toBeNull();
    expect(cropRegion({ x: -200, y: 0, width: 100, height: 100 }, IMAGE_1X, 1)).toBeNull();
  });

  it('returns null for a zero-sized element or an empty image', () => {
    expect(cropRegion({ x: 0, y: 0, width: 0, height: 10 }, IMAGE_1X, 1)).toBeNull();
    expect(
      cropRegion({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 }, 1),
    ).toBeNull();
    expect(cropRegion({ x: 0, y: 0, width: 10, height: 10 }, IMAGE_1X, 0)).toBeNull();
  });
});
