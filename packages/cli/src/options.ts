import { parseArgs } from 'node:util';
import type { ColorScheme } from '@h2f/schema';

export interface CaptureCommandOptions {
  url: string;
  viewports: number[];
  viewportHeight: number;
  theme: ColorScheme;
  locale: string;
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  delay: number;
  clickSelectors: string[];
  hideSelectors: string[];
  autoLayout: boolean;
  deviceScaleFactor: number;
  maxImageDim: number;
  compress: boolean;
  screenshot: string | null;
  output: string;
  timeout: number;
  verbose: boolean;
  proxy: string | null;
  proxyBypass: string[];
  insecure: boolean;
}

export const USAGE = `
h2f — capture a website as an editable Figma design

Usage
  h2f capture <url> [options]

Options
  -o, --out <file>          Output path (default: capture.h2d.json)
      --viewport <px>       Viewport width; repeat for multiple (default: 1920)
      --viewport-height <px>  Viewport height (default: 1080)
      --theme <light|dark>  Emulate a colour scheme (default: light)
      --lang <locale>       Browser locale (default: en-US)
      --wait <state>        load | domcontentloaded | networkidle | commit
                            (default: networkidle)
      --delay <ms>          Extra settle time after load (default: 500)
      --click <selector>    Click before capturing; repeatable (cookie banners)
      --hide <selector>     Remove before capturing; repeatable
      --no-auto-layout      Emit everything absolutely positioned
      --scale <n>           Device pixel ratio for images (default: 2)
      --max-image-dim <px>  Downscale images above this size (default: 4096)
      --compress            Write gzipped .h2d.gz instead of plain JSON
      --screenshot <file>   Also save a reference PNG for visual comparison
      --timeout <ms>        Navigation timeout (default: 60000)
      --proxy <url>         HTTP proxy (default: $HTTPS_PROXY / $HTTP_PROXY)
      --no-proxy            Ignore the proxy environment variables
      --insecure            Accept invalid TLS certificates
  -v, --verbose             Log progress
  -h, --help                Show this message

Examples
  h2f capture https://example.com -o example.h2d.json
  h2f capture https://example.com --viewport 1920 --viewport 390 --theme dark
  h2f capture https://example.com --click "#accept" --screenshot ref.png
`;

export function parseCaptureArgs(argv: string[]): CaptureCommandOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      viewport: { type: 'string', multiple: true },
      'viewport-height': { type: 'string' },
      theme: { type: 'string' },
      lang: { type: 'string' },
      wait: { type: 'string' },
      delay: { type: 'string' },
      click: { type: 'string', multiple: true },
      hide: { type: 'string', multiple: true },
      'auto-layout': { type: 'boolean', default: true },
      'no-auto-layout': { type: 'boolean' },
      scale: { type: 'string' },
      'max-image-dim': { type: 'string' },
      compress: { type: 'boolean', default: false },
      screenshot: { type: 'string' },
      timeout: { type: 'string' },
      proxy: { type: 'string' },
      'no-proxy': { type: 'boolean' },
      insecure: { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const url = positionals[0];
  if (!url) {
    throw new Error('A URL is required.\n' + USAGE);
  }

  const viewports = (values.viewport ?? ['1920'])
    .map((v) => Number.parseInt(v, 10))
    .filter((v) => Number.isFinite(v) && v > 0);

  if (viewports.length === 0) {
    throw new Error('At least one valid --viewport width is required.');
  }

  const theme = values.theme === 'dark' ? 'dark' : 'light';
  const compress = values.compress === true;
  const defaultOut = compress ? 'capture.h2d.gz' : 'capture.h2d.json';

  const target = normalizeUrl(url);
  const noProxy = values['no-proxy'] === true || isLoopback(target);

  return {
    url: target,
    viewports: [...new Set(viewports)],
    viewportHeight: positiveInt(values['viewport-height'], 1080),
    theme,
    locale: values.lang ?? 'en-US',
    waitUntil: parseWaitUntil(values.wait),
    delay: positiveInt(values.delay, 500),
    clickSelectors: values.click ?? [],
    hideSelectors: values.hide ?? [],
    autoLayout: values['no-auto-layout'] !== true,
    // Retina by default: rasterized elements and CSS backgrounds otherwise
    // import visibly soft next to Figma's vector layers.
    deviceScaleFactor: clampScale(values.scale),
    maxImageDim: positiveInt(values['max-image-dim'], 4096),
    compress,
    screenshot: values.screenshot ?? null,
    output: values.out ?? defaultOut,
    timeout: positiveInt(values.timeout, 60_000),
    verbose: values.verbose === true,
    // Chromium does not read the proxy environment variables the way Node and
    // curl do, so a machine behind a corporate proxy fails at the first
    // navigation unless the setting is passed through explicitly.
    proxy: noProxy ? null : (values.proxy ?? proxyFromEnvironment()),
    proxyBypass: bypassFromEnvironment(),
    insecure: values.insecure === true,
  };
}

function proxyFromEnvironment(): string | null {
  return (
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    null
  );
}

/**
 * Chromium accepts a narrower bypass syntax than `NO_PROXY` allows.
 *
 * Entries it cannot parse — bare `::`, IPv6 CIDR blocks, `*.` wildcards — make
 * it discard the *entire* list, silently sending every request through the
 * proxy. Filtering to what it understands is what keeps the surviving rules
 * working.
 */
const CHROMIUM_BYPASS_ENTRY =
  /^(?:\.?[a-z0-9-]+(?:\.[a-z0-9-]+)*|\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?)$/i;

function bypassFromEnvironment(): string[] {
  const value = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  const entries = value
    .split(',')
    .map((entry) => entry.trim().replace(/^\*\./, '.'))
    .filter((entry) => entry !== '' && CHROMIUM_BYPASS_ENTRY.test(entry));

  // Chromium drops its implicit loopback bypass as soon as an explicit list is
  // supplied, so capturing a local dev server would otherwise be proxied.
  return [...new Set(['localhost', '127.0.0.1', ...entries])];
}

/**
 * A proxy is never used for a loopback target.
 *
 * Bypass rules have proven too easy to get silently wrong across environments,
 * and a proxy is unambiguously not wanted when capturing your own dev server.
 */
function isLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function parseWaitUntil(value: string | undefined): CaptureCommandOptions['waitUntil'] {
  switch (value) {
    case 'load':
    case 'domcontentloaded':
    case 'networkidle':
    case 'commit':
      return value;
    case undefined:
      return 'networkidle';
    default:
      throw new Error(`Unknown --wait value "${value}".`);
  }
}

function clampScale(value: string | undefined): number {
  if (value === undefined) return 2;
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return 2;
  return Math.min(3, Math.max(1, n));
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeUrl(value: string): string {
  // A bare host is what people type; requiring the scheme is needless friction.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return `https://${value}`;
}
