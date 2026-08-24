/**
 * Viewport emulation through the debugger protocol.
 *
 * `Emulation.setDeviceMetricsOverride` is the only way an extension can reflow
 * a page to a width the window does not have — Chrome will not resize a window
 * below ~500px, which rules out every phone breakpoint. The cost is Chrome's
 * "started debugging this browser" banner for the duration of the capture; it
 * disappears again on detach.
 */

const PROTOCOL_VERSION = '1.3';

/** Chromium's own mobile breakpoint heuristic: at or below an iPhone Plus. */
const MOBILE_MAX_WIDTH = 812;

export class ViewportEmulator {
  private attached = false;

  constructor(private readonly tabId: number) {}

  async setWidth(width: number): Promise<void> {
    if (!this.attached) {
      await chrome.debugger.attach({ tabId: this.tabId }, PROTOCOL_VERSION);
      this.attached = true;
    }

    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      // Zero keeps the window's real height; only the width is being emulated.
      height: 0,
      deviceScaleFactor: 0,
      mobile: width <= MOBILE_MAX_WIDTH,
    });

    await this.settle(width);
  }

  /** Remove the override and the debugger banner. Safe to call repeatedly. */
  async restore(): Promise<void> {
    if (!this.attached) return;
    this.attached = false;

    try {
      await this.send('Emulation.clearDeviceMetricsOverride', {});
    } catch {
      // The tab may have navigated or closed; detaching still matters.
    }
    try {
      await chrome.debugger.detach({ tabId: this.tabId });
    } catch {
      // Already detached (user clicked "Cancel" on the banner).
    }
  }

  /**
   * Wait until the page actually reflowed to the emulated width.
   *
   * The override is asynchronous: layout, media queries and any JS resize
   * handlers all run after the command returns. Polling `innerWidth` catches
   * the reflow; the trailing delay gives responsive images and resize
   * listeners a beat to finish.
   */
  private async settle(width: number): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: () => window.innerWidth,
      });
      if (result?.result === width) break;
      await delay(100);
    }
    await delay(400);
  }

  private send(method: string, params: Record<string, unknown>): Promise<unknown> {
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
