# html-to-figma

Capture any website and rebuild it in Figma as **editable layers** — real frames,
text, vectors and images, not a screenshot.

An open-source take on [html.to.design](https://www.figma.com/community/plugin/1159123024924461424).

Two ways to capture — a browser extension for the page you are looking at, and a
CLI for everything scriptable.

```bash
# In the browser: click the extension, get a file
# Or from a terminal:
npx h2f capture https://example.com -o example.h2d.json

# Either way: drop the file onto the Figma plugin (or paste, from the extension)
```

## How it works

```
   capture (runs inside the page)        .h2d.json           plugin (runs inside Figma)
┌──────────────────────────────────┐   ┌───────────┐   ┌────────────────────────────────┐
│ getComputedStyle + getBoundingCR │──▶│    IR     │──▶│ frames, text, vectors, images  │
│ per element, plus asset URLs     │   │  + bytes  │   │ + inferred auto-layout         │
└──────────────────────────────────┘   └───────────┘   └────────────────────────────────┘
     ▲ injected by the extension               ▲ drag and drop
       or by the CLI — same bundle
```

| Package              | What it does                                                                    |
| -------------------- | ------------------------------------------------------------------------------- |
| `packages/schema`    | The intermediate representation both halves agree on, plus a validator          |
| `packages/capture`   | Browser-only DOM walker. Bundled as a standalone IIFE with no Node dependencies |
| `packages/host`      | Host logic neither host owns alone: asset resolution, image headers, cropping   |
| `packages/cli`       | Playwright driver: launches Chromium, prepares the page, resolves assets        |
| `packages/extension` | Chrome and Edge extension: captures the tab you are on, logged in and all       |
| `packages/plugin`    | The Figma plugin: IR → Figma nodes                                              |

The capture engine never downloads image bytes. It records resolved URLs and
lets the host fetch them, which sidesteps CORS entirely — the CLI fetches
through Playwright, the extension through its service worker. `packages/capture`
has no Node dependencies for the same reason: the extension ships the identical
bundle the CLI injects, byte for byte, so a page cannot capture differently
depending on which one you used.

## Install

Requires Node 20+.

```bash
npm install
npm run build
```

The CLI needs a Chromium matching the pinned Playwright version. Install it
through the workspace, so npm resolves the pinned Playwright rather than
downloading browsers for whatever version the registry serves today:

```bash
npm exec -w @h2f/cli -- playwright install chromium
```

If your machine already has one you would rather use, skip that and point at it:

```bash
export H2F_CHROMIUM=/path/to/chrome
```

The extension needs no Chromium of its own — it runs in the browser you already
have.

### Try it without leaving the repo

```bash
npm run demo
```

Serves `fixtures/site.html`, captures it, and writes `out/demo.h2d.json` next to
a `out/demo-reference.png` of the same page. Good for checking the toolchain
works before pointing it at anything real.

## The browser extension

Captures the tab you are looking at, which is the only way to capture anything
behind a login, a paywall, a feature flag or a session — the CLI's headless
Chromium is not your browser and never sees any of it.

```bash
npm run build:extension
```

Then load `packages/extension/dist`:

- **Chrome** — `chrome://extensions` → Developer mode → Load unpacked
- **Edge** — `edge://extensions` → Developer mode → Load unpacked

The same build works in both; only store submission differs. Open a page, click
the extension, press **Capture this page**, then either drop the downloaded
`.h2d.json` onto the Figma plugin or press **Copy for the Figma plugin** and
paste (Ctrl+V) straight into the plugin window — no file in between.

The copy lives in the extension's service worker, so it survives closing the
popup but not Chrome idling the worker out (about 30 seconds of inactivity).
If the button reports the capture expired, capture again; the file on disk
always works.

The popup can be closed while a capture runs — the service worker owns the work,
and reopening the popup reconnects to it.

### What it asks for, and why

| Permission               | Why                                                                |
| ------------------------ | ------------------------------------------------------------------ |
| `<all_urls>`             | Fetching images from CDNs. The page itself cannot: CORS forbids it |
| `activeTab`, `scripting` | Injecting the capture engine into the tab you asked to capture     |
| `downloads`              | Saving the `.h2d.json`                                             |
| `offscreen`              | Assembling that file as a blob, which a service worker cannot do   |
| `storage`                | Remembering your capture options                                   |
| `clipboardWrite`         | The "Copy for the Figma plugin" button                             |
| `debugger`               | Reflowing the page to other viewport widths (1920…390px)           |

Nothing is sent anywhere. Every byte goes from the page to the file on your
disk.

### Differences from the CLI

- **Extra viewports show a banner.** Widths beyond the window's own are
  emulated through `chrome.debugger`, so Chrome displays its "started
  debugging this browser" banner while those capture; it disappears when the
  capture finishes. Capturing only the browser's current width never attaches
  the debugger.
- **Keep the tab visible.** Elements Figma cannot draw (skew, `clip-path`,
  `<canvas>`) are photographed through the viewport, which means scrolling each
  one into view. Chrome allows about two screenshots a second, so a page with
  many of them takes a while; past 60 the rest are reported instead.
- **Elements taller than the window** cannot be photographed whole, and are
  reported as a warning rather than silently cropped.
- **Local files** need "Allow access to file URLs" on the extension's details
  page.

## Capturing from a terminal

```bash
node packages/cli/dist/h2f.mjs capture <url> [options]
```

| Option                   | Default            |                                                            |
| ------------------------ | ------------------ | ---------------------------------------------------------- |
| `-o, --out <file>`       | `capture.h2d.json` | Output path                                                |
| `--viewport <px>`        | `1920`             | Viewport width; repeat for several breakpoints in one file |
| `--viewport-height <px>` | `1080`             |                                                            |
| `--theme <light\|dark>`  | `light`            | Emulates `prefers-color-scheme`                            |
| `--lang <locale>`        | `en-US`            |                                                            |
| `--wait <state>`         | `networkidle`      | `load`, `domcontentloaded`, `networkidle`, `commit`        |
| `--delay <ms>`           | `500`              | Extra settle time after load                               |
| `--click <selector>`     | —                  | Click before capturing; repeatable. For cookie banners     |
| `--hide <selector>`      | —                  | Remove before capturing; repeatable                        |
| `--no-auto-layout`       | —                  | Emit everything absolutely positioned                      |
| `--scale <n>`            | `2`                | Device pixel ratio for images                              |
| `--max-image-dim <px>`   | `4096`             | Downscale above this. Figma rejects larger images          |
| `--compress`             | —                  | Write gzipped `.h2d.gz`                                    |
| `--screenshot <file>`    | —                  | Also save a reference PNG to compare against               |
| `--proxy <url>`          | `$HTTPS_PROXY`     | HTTP proxy. Chromium does not read the environment itself  |
| `--no-proxy`             | —                  | Ignore the proxy environment variables                     |
| `--insecure`             | —                  | Accept invalid TLS certificates                            |
| `-v, --verbose`          | —                  | Log progress                                               |

Loopback URLs never go through a proxy, so capturing your own dev server works
behind a corporate one.

```bash
# Several breakpoints in one file
h2f capture https://example.com --viewport 1920 --viewport 768 --viewport 390

# Dismiss a consent dialog and save a reference render
h2f capture https://example.com --click "#accept-all" --screenshot reference.png
```

## Installing the Figma plugin

The plugin is not optional, whichever way you capture. Figma has no public write
path for creating layers from outside the editor — the REST API cannot make a
frame — so something has to run _inside_ Figma. Equally, a plugin cannot read
your logged-in browser tab. That is the whole reason this repository has two
halves.

1. `npm run build:plugin`
2. Figma desktop → **Plugins → Development → Import plugin from manifest…**
3. Choose `packages/plugin/manifest.json`
4. Run it, then drag your `.h2d.json` onto the drop zone

The plugin declares `networkAccess: none` — capture files carry their own image
bytes, so it never reaches the network.

### Getting it to other people

Importing a manifest is per-machine and needs the Figma **desktop** app; Figma
in a browser cannot read a local manifest. Two ways past that, both starting
from the same development menu:

- **Publish privately to your organization.** Teammates run it like any other
  plugin and get updates automatically. Requires a Figma Organization or
  Enterprise plan.
- **Publish publicly to the Figma Community.** Goes through Figma's review.
  `networkAccess: none` and a plugin that only reads a file the user drops on it
  make that a short conversation.

Either one replaces `"id": "html-to-figma-local"` in
`packages/plugin/manifest.json` with a real plugin id — the current value is a
development placeholder.

## What gets converted

**Faithfully**

Layout (flex, grid, normal flow) · text with inline styled runs · fonts, weights
and slants · colours including alpha · linear, radial and conic gradients
(repeating gradients are unrolled) · multi-layer and inset box shadows · blur and
drop-shadow filters · per-side borders, dash patterns · border radius, including
CSS overlap clamping · images with `srcset` and `object-fit` · inline SVG, kept
as vectors · opacity, blend modes, `overflow` clipping · rotation and scale ·
shadow DOM, same-origin iframes · `::before` / `::after` on decorative boxes

**Flattened to an image**, because Figma has no equivalent:

skew and 3D transforms · `mask-image` · `clip-path` · filters like `saturate` and
`hue-rotate` · `<canvas>` · cross-origin iframes · rotated _containers_ (a
rotated leaf keeps its rotation)

**Approximated**, and reported in the plugin's warnings panel:

elliptical corner radii collapse to their smaller radius · borders whose sides
differ in colour keep the thickest side's colour · pseudo-element geometry is
derived rather than measured · `space-around` / `space-evenly` become
`space-between` · CSS background-position is not applied to image fills

Everything approximated produces a warning, grouped by kind, in both the CLI
output and the plugin UI.

### Auto-layout inference

Containers become Figma auto-layout frames where possible, so the result reflows
when you edit it. Two decisions make this reliable:

**Spacing is measured, not read.** Gaps and padding come from the rendered
rectangles, not from the `gap`, `margin` and `padding` properties. Collapsed
margins mean no CSS property holds the spacing a user actually sees; the
geometry always does.

**Every inference is verified.** After applying auto-layout, the plugin compares
where Figma actually put each child against where it was captured. If anything
moved by more than a pixel, that frame reverts to absolute positioning and says
so in the warnings. Auto-layout can therefore only ever improve the result — it
can never break fidelity.

## Development

```bash
npm run build       # all packages
npm test            # 182 tests
npm run typecheck
npm run format
```

Tests run without Figma. The plugin's node builder is exercised through a mock
Figma API (`packages/plugin/test/mock-figma.ts`) that reproduces Figma's
auto-layout arithmetic, so the tree the plugin produces — sizes, positions,
layout modes, fills — is asserted directly. The capture side is covered
end-to-end by driving a real Chromium against `fixtures/`.

The extension is tested the same way: `packages/extension/test` loads the built
extension into Chromium, drives its service worker, and reads the file it
actually downloads. One of those tests captures a fixture through the extension
and through the CLI and asserts the two trees match — the two hosts share a
capture engine, so that is the test that would notice them drifting apart.

Final visual confirmation still needs a human in Figma:

```bash
h2f capture https://example.com --screenshot reference.png
# import the JSON, compare against reference.png
```

## Not built yet

A localhost relay for one-click import (no file to drag), multiple breakpoints
from the extension, and Figma component detection. The package split above
exists so each can be added without reworking the capture engine or the format.

## Licence

MIT
