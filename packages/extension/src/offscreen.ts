import type { OffscreenMessage, OffscreenResult } from './protocol.js';

/**
 * A document that exists solely to hold a blob.
 *
 * `URL.createObjectURL` does not exist in a service worker, and the downloads
 * API will not take tens of megabytes as a data URL, so the capture is
 * reassembled here and handed back as a `blob:` URL the worker can download.
 * Offscreen documents can reach `chrome.runtime` and nothing else, which is why
 * the download itself still happens in the worker.
 */

let chunks: string[] = [];

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  switch (message.type) {
    case 'begin':
      chunks = [];
      sendResponse(true);
      return false;

    case 'chunk':
      chunks.push(message.text);
      sendResponse(true);
      return false;

    case 'finish':
      void finish(message.compress).then(sendResponse);
      // Keeps the message channel open across the await, which is what lets the
      // worker treat `sendMessage` as a plain promise.
      return true;

    case 'revoke':
      URL.revokeObjectURL(message.url);
      chunks = [];
      sendResponse(true);
      return false;
  }
});

async function finish(compress: boolean): Promise<OffscreenResult> {
  const json = new Blob(chunks, { type: 'application/json' });
  chunks = [];

  const blob = compress ? await gzip(json) : json;
  return { url: URL.createObjectURL(blob), bytes: blob.size };
}

/**
 * Gzip through the streams API rather than a library: the plugin already sniffs
 * the magic bytes and inflates with `DecompressionStream`, so the two halves
 * use the same primitive from opposite ends.
 */
async function gzip(blob: Blob): Promise<Blob> {
  const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}
