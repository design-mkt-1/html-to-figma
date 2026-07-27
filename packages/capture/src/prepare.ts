/**
 * Put the page into a stable, fully-rendered state before anything is measured.
 *
 * Skipping this step is the single biggest source of bad captures: lazy images
 * never load, scroll-triggered content stays hidden, webfonts swap in halfway
 * through the walk and every text measurement taken before the swap is wrong.
 */

const FREEZE_STYLE_ID = 'h2f-freeze';

export interface PrepareOptions {
  /** Pause between scroll steps, in ms. */
  scrollDelay: number;
  /** Extra settle time after scrolling back to the top. */
  settleDelay: number;
  /** Selectors to remove before capturing, e.g. cookie banners. */
  hideSelectors: string[];
}

export const DEFAULT_PREPARE_OPTIONS: PrepareOptions = {
  scrollDelay: 60,
  settleDelay: 250,
  hideSelectors: [],
};

export async function preparePage(options: PrepareOptions): Promise<void> {
  freezeAnimations();
  hide(options.hideSelectors);

  await scrollThroughPage(options.scrollDelay);
  await waitForFonts();
  await waitForImages();

  window.scrollTo(0, 0);
  await delay(options.settleDelay);
}

/**
 * Stop animations and transitions so that two measurements of the same element
 * taken a frame apart agree with each other.
 */
function freezeAnimations(): void {
  if (document.getElementById(FREEZE_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = FREEZE_STYLE_ID;
  style.textContent = `
    *, *::before, *::after {
      animation-play-state: paused !important;
      animation-delay: 0s !important;
      animation-duration: 0s !important;
      transition: none !important;
      caret-color: transparent !important;
      scroll-behavior: auto !important;
    }
  `;
  document.head.appendChild(style);

  // CSS alone does not rewind an animation that is already mid-flight.
  if (typeof document.getAnimations === 'function') {
    for (const animation of document.getAnimations()) {
      try {
        animation.currentTime = 0;
        animation.pause();
      } catch {
        // Some animations are not seekable; a paused-in-place one is fine.
      }
    }
  }
}

function hide(selectors: string[]): void {
  for (const selector of selectors) {
    let matches: NodeListOf<Element>;
    try {
      matches = document.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const element of Array.from(matches)) {
      element.remove();
    }
  }
}

/**
 * Walk the full scroll height in viewport-sized steps.
 *
 * This is what triggers `IntersectionObserver`-driven lazy loading and reveal
 * animations. Going straight to the bottom misses everything in between,
 * because observers fire per intersection, not per scroll position.
 */
async function scrollThroughPage(stepDelay: number): Promise<void> {
  const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
  const maxScroll = () =>
    Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0,
    ) - window.innerHeight;

  let position = 0;
  let guard = 0;

  // The page can grow as content loads, so the limit is re-read each step.
  while (position < maxScroll() && guard < 200) {
    window.scrollTo(0, position);
    await delay(stepDelay);
    position += step;
    guard++;
  }

  window.scrollTo(0, maxScroll());
  await delay(stepDelay);

  // Nested scrollers hide content too; reset them so their children measure at
  // their natural offsets rather than at wherever the user last left them.
  for (const element of Array.from(document.querySelectorAll('*'))) {
    if (element.scrollTop !== 0 || element.scrollLeft !== 0) {
      element.scrollTop = 0;
      element.scrollLeft = 0;
    }
  }
}

async function waitForFonts(): Promise<void> {
  if (!document.fonts) return;
  try {
    await Promise.race([document.fonts.ready, delay(10_000)]);
  } catch {
    // A font that never resolves should not fail the whole capture.
  }
}

/**
 * Wait for every image to finish decoding.
 *
 * `complete` is not enough — an image can be marked complete before its bitmap
 * is decodable, and `naturalWidth` reads as 0 in that window.
 */
async function waitForImages(): Promise<void> {
  const images = Array.from(document.images);
  const pending = images.map(async (image) => {
    if (image.complete && image.naturalWidth > 0) return;
    try {
      await Promise.race([image.decode(), delay(5_000)]);
    } catch {
      // Broken images are captured as empty boxes, which is what they render as.
    }
  });

  await Promise.all(pending);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
