#!/usr/bin/env bun
/**
 * Browser DOM Context Harness
 *
 * Proves that the layer between a browser tool and the model behaves: which DOM
 * snapshots survive into the conversation, and what each one looks like once
 * rendered.
 *
 *   bun packages/opencode/script/dom-context.ts
 *
 * Browser tools do not put the serialized tree in their result — it stays in the
 * tab's snapshot cache and only `DomMeta` is persisted, so the conversation text
 * is assembled on the way to the model. That makes this whole layer pure: given
 * a sequence of DomMeta, the keep set and the rendered output are fully
 * determined, with no browser, no CDP and no page to be flaky.
 *
 * Complements dom-regression.ts, which covers the extraction pipeline
 * (builder → render-info → prune → highlight → serializer) but stops at the
 * serialized string. This harness starts there and covers what happens to it
 * afterwards. Neither one exercises a live page; see the browser-regression
 * README for what still needs a manual run.
 *
 * Exits non-zero on the first failing expectation, so it is CI-shaped.
 */

import {
  computeDomKeep,
  domKey,
  renderDom,
  renderOmittedDom,
  type DomMeta,
} from "../src/tool/browser/dom-utils"

let passed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++
    return
  }
  failures.push(detail ? `${name}\n    ${detail}` : name)
}

function equal(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(name, a === e, `expected ${e}\n    actual   ${a}`)
}

function contains(name: string, haystack: string, needle: string) {
  check(name, haystack.includes(needle), `missing ${JSON.stringify(needle)}`)
}

function omits(name: string, haystack: string, needle: string) {
  check(name, !haystack.includes(needle), `unexpectedly present: ${JSON.stringify(needle)}`)
}

function meta(domId: string, mode: DomMeta["mode"], extra: Partial<DomMeta> = {}): DomMeta {
  return {
    domId,
    tabId: "tab0",
    mode,
    title: "",
    hasOverlay: false,
    ...extra,
  }
}

/** Keys of the kept snapshots, in the order they were given. */
function keptKeys(metas: DomMeta[]): string[] {
  const keep = computeDomKeep(metas)
  return metas.map(domKey).filter((key) => keep.has(key))
}

/** As above, but reported by domId — readable when every case is one tab. */
function keptIds(metas: DomMeta[]): string[] {
  const keep = computeDomKeep(metas)
  return metas.filter((m) => keep.has(domKey(m))).map((m) => m.domId)
}

// ---------------------------------------------------------------------------
// Keep-set policy
// ---------------------------------------------------------------------------

equal("empty history keeps nothing", keptIds([]), [])

equal("a lone snapshot is kept", keptIds([meta("dom0", "full")]), ["dom0"])

equal(
  "a full newest snapshot is a fresh base, so earlier ones drop",
  keptIds([meta("dom0", "full"), meta("dom0.1", "incremental"), meta("dom1", "full")]),
  ["dom1"],
)

equal(
  "an added newest snapshot is also a fresh base",
  keptIds([meta("dom0", "full"), meta("dom0.1", "incremental"), meta("dom1", "added")]),
  ["dom1"],
)

equal(
  "an incremental newest drags its whole chain back to the full base",
  keptIds([
    meta("dom0", "full"),
    meta("dom0.1", "incremental"),
    meta("dom0.2", "incremental"),
  ]),
  ["dom0", "dom0.1", "dom0.2"],
)

equal(
  "the chain stops at the nearest base and drops what precedes it",
  keptIds([
    meta("dom0", "full"),
    meta("dom0.1", "incremental"),
    meta("dom1", "added"),
    meta("dom1.1", "incremental"),
  ]),
  ["dom1", "dom1.1"],
)

// Regression: a nochange newest used to keep only itself, leaving the model with
// no element indices at all — every prior snapshot collapsed to a placeholder.
equal(
  "a nochange newest still pulls the base chain in",
  keptIds([
    meta("dom0", "full"),
    meta("dom0.1", "incremental"),
    meta("dom0.2", "nochange"),
  ]),
  ["dom0", "dom0.1", "dom0.2"],
)

equal(
  "a nochange newest reaches past a bare full base",
  keptIds([meta("dom0", "full"), meta("dom0.1", "nochange")]),
  ["dom0", "dom0.1"],
)

equal(
  "a nochange in the middle is stepped over without ending the chain",
  keptIds([
    meta("dom0", "full"),
    meta("dom0.1", "nochange"),
    meta("dom0.2", "incremental"),
  ]),
  ["dom0", "dom0.2"],
)

// domIds restart per tab, so two tabs can both hold a "dom0". Keeping one must
// not drag the other in with it.
equal(
  "an identical domId in another tab is not kept by association",
  keptKeys([
    meta("dom0", "full", { tabId: "tab0" }),
    meta("dom0", "full", { tabId: "tab1" }),
  ]),
  ["tab1/dom0"],
)

// A diff's base is always the previous snapshot of its own tab; another tab's
// snapshot sitting in between is not part of the chain.
equal(
  "the base chain walks past snapshots belonging to other tabs",
  keptKeys([
    meta("dom0", "full", { tabId: "tab0" }),
    meta("dom0", "full", { tabId: "tab1" }),
    meta("dom0.1", "incremental", { tabId: "tab0" }),
  ]),
  ["tab0/dom0", "tab0/dom0.1"],
)

// ---------------------------------------------------------------------------
// Rendering a kept snapshot
// ---------------------------------------------------------------------------

const fullRender = renderDom(meta("dom0", "full", { title: "Bun" }), "[1]<button> Go </button>")
contains(
  "a kept snapshot opens with its state block",
  fullRender,
  "<state>\nstateId: tab0-dom0\nmode: full\ntitle: Bun\n</state>",
)
contains(
  "a kept snapshot wraps the tree in a dom block",
  fullRender,
  "<dom>\n[1]<button> Go </button>\n</dom>",
)
contains("a kept snapshot warns it is transient", fullRender, "**Reminder**")
omits("a full snapshot carries no diff tip", fullRender, "**Tip**")

const incRender = renderDom(meta("dom0.1", "incremental"), "+|[2]<a> Next </a>")
contains("an incremental snapshot reports its mode", incRender, "mode: incremental")
contains("an incremental snapshot explains both diff markers", incRender, "`-|` are removed")

const addedRender = renderDom(meta("dom1", "added"), "+|[3]<li> Row </li>")
contains("an added snapshot reports its mode", addedRender, "mode: added")
contains("an added snapshot explains the added marker", addedRender, "newly appeared")
omits("an added snapshot does not mention removals", addedRender, "`-|` are removed")

// Notices and tips describe how to read the tree, so they have to precede it.
check(
  "the diff tip precedes the tree it explains",
  incRender.indexOf("**Tip**") < incRender.indexOf("<dom>"),
  "tip must come before <dom>",
)
check(
  "the retention reminder trails the tree",
  fullRender.indexOf("**Reminder**") > fullRender.indexOf("</dom>"),
  "reminder must come after </dom>",
)

equal(
  "a nochange snapshot is one line and needs no dom block",
  renderDom(meta("dom0.2", "nochange"), ""),
  "\n\n<state>\nstateId: tab0-dom0\nmode: nochange\n</state>\nNo DOM changes detected after the previous action.",
)

const decorated = renderDom(
  meta("dom0", "full", {
    hasOverlay: true,
    scrollMap: "[container:0] 3 pages | viewing P0 | unexplored P1-2",
    tabs: "- [active] [tab:tab0] Bun (https://bun.sh)",
  }),
  "<body/>",
)
contains("an overlay is called out", decorated, "**Notice**: An overlay")
contains("a single-line scroll map rides on its label", decorated, "scroll: [container:0] 3 pages")
contains("a single-line tab list rides on its label", decorated, "tabs: - [active] [tab:tab0] Bun")

// Several containers cannot share the label line, so that case keeps the break.
contains(
  "a multi-line scroll map breaks after its label",
  renderDom(meta("dom0", "full", { scrollMap: "[container:0] 3 pages\n[container:2] 4 pages" }), "<body/>"),
  "scroll:\n[container:0] 3 pages\n[container:2] 4 pages",
)
check(
  "the overlay notice precedes the tree it occludes",
  decorated.indexOf("**Notice**") < decorated.indexOf("<dom>"),
  "notice must come before <dom>",
)

// Only the goto-style tools echo the address; after a click that navigated,
// the state block is the model's only way to know where it landed.
const located = renderDom(
  meta("dom0", "full", { url: "https://www.target.com/c/jobs?q=human+resources&loc=Miami%2C+FL" }),
  "<body/>",
)
contains(
  "the address is reported whole, so it can be handed back to browser_goto",
  located,
  "url: https://www.target.com/c/jobs?q=human+resources&loc=Miami%2C+FL",
)
omits("no url line when the snapshot carries none", renderDom(meta("dom0", "full"), "<body/>"), "url:")
contains(
  "a collapsed snapshot still says where it was",
  renderOmittedDom(meta("dom2", "full", { url: "https://example.com/a" })),
  "url: https://example.com/a",
)

// Whether a page embeds structured data is invisible in the tree — the script
// tags holding it are pruned — so the state block names the types it found.
const embedded = renderDom(meta("dom0", "full", { data: ["Recipe", "BreadcrumbList"] }), "<body/>")
contains("embedded schema types are named", embedded, "data: Recipe, BreadcrumbList")
contains("and point at the helper that reads them", embedded, '__data("Type")')

const bare = renderDom(meta("dom0", "full"), "<body/>")
omits("no data line when the page embeds nothing", bare, "data:")
omits("no overlay notice when nothing covers the page", bare, "**Notice**")
omits("no scroll line when there is nothing to explore", bare, "scroll:")
omits("no tabs line for a single tab", bare, "tabs:")

// ---------------------------------------------------------------------------
// Rendering a dropped snapshot
// ---------------------------------------------------------------------------

// Same state block as a kept snapshot; the absence of <dom> is what says the
// tree is gone, so the model reads one shape either way.
equal(
  "a dropped snapshot keeps its state block and drops only the tree",
  renderOmittedDom(meta("dom2", "full", { title: "GitHub", scrollMap: "[container:0] 3 pages" })),
  "\n\n<state>\nstateId: tab0-dom2\nmode: full\ntitle: GitHub\nscroll: [container:0] 3 pages\n</state>\n" +
    '[DOM omitted. Use `browser_restore_state` with stateId "tab0-dom2" to restore this page.]',
)
omits(
  "a dropped snapshot has no dom block at all",
  renderOmittedDom(meta("dom2", "full", { title: "GitHub" })),
  "<dom>",
)

// fullPath is carried for tooling (the benchmark trace reports it), but the
// model is not shown it: while a snapshot is kept, the truncation notice inside
// the tree already names the file, and once collapsed the way back is a restore.
omits(
  "the saved-text path is metadata, not something the model is told",
  renderOmittedDom(meta("dom2", "full", { fullPath: "/tmp/trunc/tool_abc" })),
  "/tmp/trunc/tool_abc",
)

const untitled = renderOmittedDom(meta("dom2", "full"))
omits("an untitled page renders no title line", untitled, "title:")
omits("no scroll line when there was none", untitled, "scroll:")
contains("a dropped snapshot is still restorable", untitled, 'browser_restore_state` with stateId "tab0-dom2"')

// A sub-snapshot restores to the navigation it belongs to, not to itself.
contains(
  "a sub-snapshot restores via its parent navigation",
  renderOmittedDom(meta("dom3.2", "incremental")),
  'stateId "tab0-dom3"',
)

// ---------------------------------------------------------------------------

if (failures.length === 0) {
  console.log(`dom-context: ${passed} checks passed`)
  process.exit(0)
}

console.error(`dom-context: ${failures.length} failed, ${passed} passed\n`)
for (const failure of failures) console.error(`  ✗ ${failure}`)
process.exit(1)
