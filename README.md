# html-to-figma

Capture any website and rebuild it in Figma as **editable layers** — real frames,
text, vectors and images, not a screenshot.

An open-source take on [html.to.design](https://www.figma.com/community/plugin/1159123024924461424).

```bash
# 1. Capture a page
npx h2f capture https://example.com -o example.h2d.json

# 2. Drop the file onto the Figma plugin
```

## How it works

```
   capture (runs inside the page)        .h2d.json           plugin (runs inside Figma)
┌──────────────────────────────────┐   ┌───────────┐   ┌────────────────────────────────┐
│ getComputedStyle + getBoundingCR │──▶│    IR     │──▶│ frames, text, vectors, images  │
│ per element, plus asset URLs     │   │  + bytes  │   │ + inferred auto-layout         │
└──────────────────────────────────┘   └───────────┘   └────────────────────────────────┘
        ▲ injected by the CLI today,          ▲ drag and drop
          by a browser extension later
```

| Package            | What it does                                                                    |
| ------------------ | ------------------------------------------------------------------------------- |
| `packages/schema`  | The intermediate representation both halves agree on, plus a validator          |
| `packages/capture` | Browser-only DOM walker. Bundled as a standalone IIFE with no Node dependencies |
| `packages/cli`     | Playwright driver: launches Chromium, prepares the page, resolves assets        |
| `packages/plugin`  | The Figma plugin: IR → Figma nodes                                              |

The capture engine never downloads image bytes. It records resolved URLs and
lets the host fetch them, which sidesteps CORS entirely — and is exactly the
shape a browser extension needs, where the service worker does the fetching.
That is why `packages/capture` has no Node dependencies: the same bundle is
meant to ship as a content script unchanged.

## Install

Requires Node 20+.

```bash
npm install
npm run build
```

Capturing needs a Chromium that matches the pinned Playwright version:

```bash
npx playwright install chromium
```

If your machine already has one you would rather use, skip that and point at it:

```bash
export H2F_CHROMIUM=/path/to/chrome
```

### Try it without leaving the repo

```bash
npm run demo
```

Serves `fixtures/site.html`, captures it, and writes `out/demo.h2d.json` next to
a `out/demo-reference.png` of the same page. Good for checking the toolchain
works before pointing it at anything real.

## Capturing

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

1. `npm run build:plugin`
2. Figma desktop → **Plugins → Development → Import plugin from manifest…**
3. Choose `packages/plugin/manifest.json`
4. Run it, then drag your `.h2d.json` onto the drop zone

The plugin declares `networkAccess: none` — capture files carry their own image
bytes, so it never reaches the network.

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
npm test            # 144 tests
npm run typecheck
npm run format
```

Tests run without Figma. The plugin's node builder is exercised through a mock
Figma API (`packages/plugin/test/mock-figma.ts`) that reproduces Figma's
auto-layout arithmetic, so the tree the plugin produces — sizes, positions,
layout modes, fills — is asserted directly. The capture side is covered
end-to-end by driving a real Chromium against `fixtures/`.

Final visual confirmation still needs a human in Figma:

```bash
h2f capture https://example.com --screenshot reference.png
# import the JSON, compare against reference.png
```

## Not built yet

The browser extension (for logged-in and private pages), a localhost relay for
one-click import, and Figma component detection. The package split above exists
so each can be added without reworking the capture engine or the format.

## Licence

MIT
