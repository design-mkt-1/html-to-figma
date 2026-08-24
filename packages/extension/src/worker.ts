import { mergeCaptures } from '@h2f/host';
import type { Capture } from '@h2f/schema';
import {
  blockedReason,
  captureFilename,
  CancelledError,
  countLayers,
  groupWarnings,
  runCapture,
} from './capture-run.js';
import { ViewportEmulator } from './viewport.js';
import {
  CHUNK_SIZE,
  DEFAULT_SETTINGS,
  type CaptureSettings,
  type OffscreenMessage,
  type OffscreenResult,
  type PopupMessage,
  type RunState,
  type WorkerMessage,
} from './protocol.js';

/**
 * The service worker owns every capture from start to saved file.
 *
 * Nothing lives in the popup because a popup is destroyed the instant the user
 * clicks anywhere else, and a capture of a real page takes long enough that
 * they will. The popup connects, watches, and may vanish at any point.
 */

const SETTINGS_KEY = 'settings';

let state: RunState = { status: 'idle' };
let settings: CaptureSettings = { ...DEFAULT_SETTINGS };
let running = false;
let cancelled = false;

/**
 * The last capture's JSON, for "Copy for the Figma plugin".
 *
 * Held in memory only: Chrome may kill an idle service worker after ~30s, and
 * losing it is fine — the popup gets `copyUnavailable` and tells the user to
 * capture again. Persisting a multi-megabyte string to survive that would cost
 * more than the click it saves.
 */
let lastJson: string | null = null;

const ports = new Set<chrome.runtime.Port>();

// Registered synchronously: an event that arrives while the worker is still
// starting up is dropped if the listener is added inside a promise.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;

  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((message: PopupMessage) => void handlePopupMessage(message, port));

  send(port, { type: 'settings', settings });
  send(port, { type: 'state', state });
});

void loadSettings();

async function loadSettings(): Promise<void> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = stored[SETTINGS_KEY] as Partial<CaptureSettings> | undefined;
  if (saved) settings = { ...DEFAULT_SETTINGS, ...saved };
  broadcast({ type: 'settings', settings });
}

async function handlePopupMessage(message: PopupMessage, port: chrome.runtime.Port): Promise<void> {
  if (message.type === 'saveSettings') {
    settings = message.settings;
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    return;
  }

  if (message.type === 'cancel') {
    cancelled = true;
    return;
  }

  if (message.type === 'copy') {
    if (lastJson === null) {
      send(port, { type: 'copyUnavailable' });
      return;
    }
    for (let offset = 0; offset < lastJson.length; offset += CHUNK_SIZE) {
      send(port, {
        type: 'captureJson',
        chunk: lastJson.slice(offset, offset + CHUNK_SIZE),
        done: offset + CHUNK_SIZE >= lastJson.length,
      });
    }
    return;
  }

  if (message.type === 'start') {
    settings = message.settings;
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    await start();
  }
}

/**
 * @param tabId  Capture this tab instead of whichever one is in front. Only the
 *               test harness passes it; the popup always means "this page".
 */
async function start(tabId?: number): Promise<RunState> {
  if (running) return state;

  running = true;
  cancelled = false;
  const started = Date.now();

  try {
    const tab = tabId === undefined ? await activeTab() : await chrome.tabs.get(tabId);
    if (!tab?.id || tab.windowId === undefined) throw new Error('No page to capture.');

    const blocked = await blockedReason(tab.url);
    if (blocked) throw new Error(blocked);

    // The browser's own width (0) needs no emulation; every other width
    // reflows the page through the debugger for the duration of its capture.
    const widths = [...new Set(settings.viewports)];
    if (widths.length === 0) widths.push(0);

    const captures: Capture[] = [];
    const emulator = new ViewportEmulator(tab.id);
    try {
      for (const width of widths) {
        if (cancelled) throw new CancelledError();
        if (width > 0) await emulator.setWidth(width);
        captures.push(
          await runCapture({
            tabId: tab.id,
            windowId: tab.windowId,
            settings,
            report: (phase, done, total) => setState({ status: 'running', phase, done, total }),
            isCancelled: () => cancelled,
          }),
        );
      }
    } finally {
      await emulator.restore();
    }

    const capture = mergeCaptures(captures);

    setState({ status: 'running', phase: 'writing', done: 0, total: 0 });
    const filename = captureFilename(capture, settings.compress);
    const json = JSON.stringify(capture);
    lastJson = json;
    const bytes = await save(json, filename, settings.compress);

    setState({
      status: 'done',
      summary: {
        title: capture.meta.title,
        url: capture.meta.url,
        filename,
        layers: countLayers(capture),
        assets: Object.keys(capture.assets).length,
        fonts: capture.fonts.length,
        bytes,
        elapsedMs: Date.now() - started,
        warnings: groupWarnings(capture),
      },
    });
  } catch (error) {
    setState(
      error instanceof CancelledError
        ? { status: 'idle' }
        : { status: 'error', message: (error as Error).message },
    );
  } finally {
    running = false;
  }

  return state;
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * The worker's own API, for the end-to-end tests.
 *
 * This global lives in the service worker's scope, which no web page can reach
 * — only extension contexts, and the only one is the popup. Exposing it lets
 * the tests drive the real capture path rather than a copy of it, which is the
 * only way to cover the parts that exist solely because this is an extension:
 * script injection, `captureVisibleTab`, and the offscreen download.
 */
Object.assign(self, {
  __h2fWorker: {
    run: (options: { settings?: Partial<CaptureSettings>; tabId?: number } = {}) => {
      settings = { ...settings, ...options.settings };
      return start(options.tabId);
    },
    state: () => state,
  },
});

/**
 * Hand the capture to the offscreen document and download what it hands back.
 *
 * A service worker has no `URL.createObjectURL`, and a capture of a media-heavy
 * page is far too big to pass to the downloads API as a data URL — hence the
 * offscreen document, whose only job is to be a context that has both.
 */
async function save(json: string, filename: string, compress: boolean): Promise<number> {
  await ensureOffscreen();

  await toOffscreen({ target: 'offscreen', type: 'begin' });

  // Chunked because a single multi-megabyte message across the extension
  // messaging bridge is the one call that reliably fails on a heavy page.
  for (let offset = 0; offset < json.length; offset += CHUNK_SIZE) {
    await toOffscreen({
      target: 'offscreen',
      type: 'chunk',
      text: json.slice(offset, offset + CHUNK_SIZE),
    });
  }

  const result = (await toOffscreen({
    target: 'offscreen',
    type: 'finish',
    compress,
  })) as OffscreenResult;

  const downloadId = await chrome.downloads.download({
    url: result.url,
    filename,
    saveAs: false,
  });

  // The blob has to outlive the download, so cleanup waits for Chrome to say it
  // is finished rather than happening on the next line.
  await new Promise<void>((resolve) => {
    const listener = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'in_progress') return;

      chrome.downloads.onChanged.removeListener(listener);
      resolve();
    };
    chrome.downloads.onChanged.addListener(listener);
  });

  await toOffscreen({ target: 'offscreen', type: 'revoke', url: result.url });
  await chrome.offscreen.closeDocument().catch(() => undefined);

  return result.bytes;
}

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.BLOBS],
    justification: 'Assemble the capture file as a blob so it can be saved to disk.',
  });
}

function toOffscreen(message: OffscreenMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

function setState(next: RunState): void {
  state = next;
  broadcast({ type: 'state', state });
}

function broadcast(message: WorkerMessage): void {
  for (const port of ports) send(port, message);
}

function send(port: chrome.runtime.Port, message: WorkerMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // The popup closed between the check and the post; nothing to do.
    ports.delete(port);
  }
}
