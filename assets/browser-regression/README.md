# DOM extraction regression harness

Proves that changes to the browser DOM pipeline (`builder` → `render-info` →
`prune` → `highlight` → `serializer`) do not change what the agent sees.

Run with `packages/opencode/script/dom-regression.ts`.

## Why replayed CDP rather than a live page

Comparing extraction against a live page is hopeless: ads, A/B tests,
animations, timestamps and lazy loading move the ground under every run. But
everything the pipeline learns about a page arrives through one seam —
`CDPClient.sendCommand`. A capture run records every request/response pair into
a gzipped *tape*; verification replays the tape with no browser at all.
Identical inputs, so any difference in output is a real behaviour change.

## Commands

```bash
bun packages/opencode/script/dom-regression.ts verify              # the check
bun packages/opencode/script/dom-regression.ts verify --repeat 10  # min-of-N timings
bun packages/opencode/script/dom-regression.ts verify hn-front     # one fixture
bun packages/opencode/script/dom-regression.ts capture             # re-record (opens Chrome)
bun packages/opencode/script/dom-regression.ts capture --headless
bun packages/opencode/script/dom-regression.ts bless               # accept an intended change
bun packages/opencode/script/dom-regression.ts ablate              # what does the pipeline need?
bun packages/opencode/script/dom-regression.ts list
```

`verify` is the one to run before and after a change. It needs no browser and
finishes in seconds. `bless` re-renders the goldens from the existing tapes —
only for a change whose output difference you have read and accepted.

`ablate` strips fields out of recorded payloads (each computed style,
DOM rects, paint order, the accessibility tree) and reports how the output
changes without them. Useful for deciding whether something is worth asking
the browser for; it says nothing about what that request costs.

## Reading the output

`verify` prints per-stage times. Replay serves CDP from memory, so those are
**pure CPU** — a usable benchmark for the tree-building and pruning work, and
the way the ~5x speedup in that layer was measured.

The flip side: **replay can never show a round-trip saving.** A change that
halves CDP traffic looks identical here. `capture` reports live timings and
per-method call counts for that; treat any comparison between two captures as
noisy unless both ran back to back on the same loaded page.

## Fixtures

| Fixture | Nodes | Candidates | Covers |
|---|---|---|---|
| `mdn-element` | 38523 | 168 | The largest tree; where superlinear costs show up |
| `wikipedia-js` | 10856 | 290 | Long document, heavy tables |
| `github-repo` | 5034 | 309 | Dense app UI, many listeners, table rows |
| `youtube-home` | 2639 | 60 | Shadow DOM everywhere, custom elements |
| `hn-front` | 1243 | 232 | Table layout; nearly every node visible, so the most hit tests |
| `bing-search` | 1095 | 138 | Search results, ads, mixed frames |
| `strategy-careers` | 971 | 22 | Scrolled to the bottom of a real page |
| `wikipedia-scrolled` | 10856 | 252 | Same page as above, four viewports down |
| `oopif-frames` | 644 | 37 | Cross-origin iframes (OpenStreetMap, Vimeo), local page |
| `oopif-scrolled` | 2885 | 13 | A cross-origin frame scrolled inside itself |
| `nested-iframe` | 202 | 47 | Iframe inside an iframe |
| `scrolled-frames` | 49 | 6 | Main scroll + iframe offset + the iframe's own scroll, at once |

Pages under `pages/` are local and deterministic; the rest are live sites and
their content drifts, which is exactly why the tapes are frozen.

Add a fixture by editing `fixtures.json`: `url`, or `file` for a page in
`pages/`; `wait` in ms; `scroll` in viewports; `frameScroll` in pixels, applied
to every cross-origin frame through its own session, since a parent page cannot
script a cross-origin child. Then capture it.

An unscrolled frame cannot distinguish document coordinates from viewport ones,
so `oopif-scrolled` is the only fixture that exercises hit testing inside a
child session for real — it lands on a table of contents so the links there have
to resolve.

## What this cannot catch

Worth knowing before trusting a green run:

- **Settle timing.** The harness skips the settle monitor entirely. Whether an
  extraction fires too early — before the page finished reacting — is invisible
  here, and it is a correctness question, not a speed one.
- **The diff path.** Goldens come from a single extraction. `getPageDom`'s
  incremental diff between two snapshots is never exercised, so anything that
  corrupts a cached snapshot passes.
- **Anything outside the serialised HTML.** The scroll map, viewport stats and
  the overlay flag are not in the goldens, so a change that breaks scroll
  container detection can still pass.
- **States no fixture is in.** Every fixture sat at scroll position zero until
  a hit-test bug that emptied every scrolled page of interactive elements got
  through. When a change depends on page state, add a fixture in that state.
  Still missing: any page with a modal or overlay, so the overlay detection in
  `render-info.ts` has never run here; and any page behind a login.

## Tapes

`tapes/` is 4.1MB, `golden/` 328KB. They are committed so the check is
reproducible on any machine; re-capturing rewrites every tape, which adds new
binary blobs to history. `golden/*.actual.txt` is written by a failing `verify`
for inspection and is ignored.

## CDP behaviour this pinned down

Facts that cost real debugging and are easy to re-learn the hard way:

- `DOM.getNodeForLocation` takes **document** coordinates, not viewport ones,
  **and** only resolves points inside the currently visible scroll band. At
  scrollY 5000 with a 900px viewport, y=4950 and y=5950 both answer "No node
  found at given location" while 5050 and 5850 resolve. The same holds inside a
  child frame's own session. `document.elementFromPoint` differs on both counts:
  it is spec'd to take viewport coordinates.
- Off-screen elements therefore never resolve a hit; they reach candidacy
  through `expandedViewportPosition` instead.
- `DOM.enable` alone produces **no** mutation events. The DOM agent only reports
  changes to nodes already sent to the client, so events start flowing after a
  full `DOM.getDocument` (`depth: 0` and `depth: 1` are not enough) and stop
  again after a navigation until it is re-issued.
- puppeteer's `CDPSession.send` takes no session id. Commands for an
  out-of-process iframe have to go through that frame's own session, looked up
  on the connection; sending them on the page session silently answers for the
  main frame.
- `Accessibility.getFullAXTree` cost scales with nodes returned (~15 nodes/ms)
  and `Accessibility.enable` changes nothing.
