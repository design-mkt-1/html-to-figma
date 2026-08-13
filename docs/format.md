# The `.h2d` capture format

A capture file is JSON (optionally gzipped, `.h2d.gz`) describing one web page as
a resolution-independent scene tree. It is the contract between the capture
engine and the Figma plugin, and the reason the same engine drives both the CLI
and the browser extension without either side knowing which produced a file.

The authoritative definition is [`packages/schema/src/types.ts`](../packages/schema/src/types.ts).

## Design rules

1. **Plain JSON only.** The document round-trips through `JSON.stringify` and
   through Figma's `postMessage` structured clone.
2. **No Figma vocabulary.** The capture side never needs to know what a
   `SolidPaint` or a `gradientTransform` is. All Figma-specific mapping lives in
   `packages/plugin/src/convert/`.
3. **No CSS vocabulary either.** Values arrive resolved, absolute and unit-less
   — pixels, degrees, 0..1 ratios — so the plugin never parses a string. There
   is exactly one CSS parser in this codebase and it runs in the browser.

Rule 3 is what keeps the plugin small and testable. If you find yourself wanting
to send `"16px"` or `"rgba(0,0,0,.5)"` across the boundary, resolve it first.

## Shape

```jsonc
{
  "version": 1,
  "meta": { "url", "title", "capturedAt", "colorScheme", "locale", "generator" },
  "roots": [ /* one RootNode per captured viewport */ ],
  "assets": { "img:0": { /* ... */ } },
  "fonts":  [ { "family": "Inter", "weight": 400, "italic": false } ],
  "warnings": [ { "code": "pseudo.approximate", "message": "…", "nodeName": "…" } ]
}
```

`version` is checked strictly. A mismatch stops validation immediately rather
than reporting a hundred consequential errors.

## Nodes

Five kinds: `ROOT`, `ELEMENT`, `TEXT`, `IMAGE`, `SVG`.

Every node carries `id`, `name`, `rect`, `opacity`, `blendMode`, `rotation` and
`sizing`.

`rect` is **relative to the parent's border box**, in CSS pixels. Roots use
`0, 0`. This matters for `ELEMENT`: Figma's padding is measured from the frame
edge while CSS measures content from inside the border, so a container's
`layout.padding` includes its border widths.

`rotation` is degrees **clockwise**, matching CSS. Figma's rotation is
counter-clockwise, so the plugin negates it.

### ELEMENT

A box: fills, stroke, corners, effects, `clipsContent`, `layout`, `children`.

`rasterize` is set when the element used CSS the format cannot express. The
plugin then renders it as a single image and ignores `children`.

### TEXT

`characters` is the rendered string, with CSS whitespace collapsing already
applied. `base` is the node's style; `segments` carry only the properties that
_differ_, over half-open `[start, end)` ranges, which is what lets
`<p>plain <a>link</a></p>` become one editable Figma layer.

A separating space takes the style of the text node that contained it, not of
whatever follows — otherwise an underlined link starts with an underlined space.

### IMAGE / SVG

Both reference `assets` by key. SVG carries markup and stays vector all the way
into Figma.

## Assets

Deduplicated by content. Two kinds survive into a finished file:

- `BITMAP` — base64 `bytes`, `mimeType`, intrinsic `width`/`height`
- `SVG` — `markup`, ready for `figma.createNodeFromSvg`

A third, `PENDING`, exists only _inside_ the capture engine. It records a
resolved URL for the host to fetch. **A finished capture file must contain no
`PENDING` assets**: the host either resolves them or prunes the referencing
nodes, because an image layer with no image imports as an invisible empty frame.

This split is the extension seam. The browser engine cannot fetch cross-origin
images — CORS forbids it, and most sites serve images from a CDN with no
permissive header. So it names them and the host fetches them: Playwright's
request context in the CLI, the service worker in the extension. Both go through
the same code in `packages/host`, which is what keeps the two files identical.

## Layout

```jsonc
{ "mode": "ABSOLUTE" }
{ "mode": "HORIZONTAL" | "VERTICAL",
  "gap", "counterGap", "padding": { "top", "right", "bottom", "left" },
  "wrap", "primaryAlign", "counterAlign" }
```

Auto-layout values are derived from **measured geometry**, not from the CSS box
properties — collapsed margins mean no property holds the spacing a user
actually sees. Inference bails out to `ABSOLUTE` whenever children are
out-of-flow, overlap, overflow their parent, disagree on counter-axis alignment,
or sit at non-uniform gaps.

`ABSOLUTE` is always safe: `rect` alone fully determines the result.

Note that `layout` is advisory. The plugin applies it, measures where Figma
actually placed each child, and falls back to `rect` if anything moved. A
producer that emits an over-optimistic layout degrades gracefully.

## Adding a field

- Optional and ignorable by an old plugin → add it, leave `SCHEMA_VERSION`.
- Changes the meaning of an existing field, or a new node kind an old plugin
  would skip → bump `SCHEMA_VERSION`.

The plugin refuses any version it does not recognise, so an unbumped breaking
change surfaces as a wrong import rather than a clear error.
