import type { TabState, BrowserManager } from "./manager"
import type { Truncate } from "../truncate"
import { Effect } from "effect"
import * as fs from "fs"
import * as path from "path"
import { Global } from "@opencode-ai/core/global"

const INCREMENTAL_DIFF_RATIO_THRESHOLD = 0.3

/** Appended to a tool's own output when a concurrent call deferred extraction. */
export const DOM_DEFERRED = "\n\n(DOM extraction deferred — included in the last concurrent browser tool's output.)"

/**
 * Everything about a DOM snapshot except the snapshot itself.
 *
 * This is what a browser tool puts in its result metadata, so it is small,
 * JSON-serializable and durable. The serialized tree stays in the tab's
 * DomService cache and is pulled back by domId when model messages are built —
 * keeping it out of the tool result means it never reaches tool-output
 * truncation, which would otherwise cut a multi-thousand-line page mid-tree.
 */
export interface DomMeta {
  domId: string
  tabId: string
  /** full = complete DOM (new base), incremental = small diff (preserves base), added = large diff (new base), nochange = nothing changed */
  mode: "full" | "incremental" | "added" | "nochange"
  /** Accessibility name of the document root — effectively the page title. */
  title: string
  /** Address this snapshot was taken at; only browser_goto-style tools echo it otherwise. */
  url?: string
  /** Rendered `[container:N] ...` exploration lines, one per scroll container. */
  scrollMap?: string
  /** Rendered tab list, present only while more than one tab is open. */
  tabs?: string
  /** Schema types the page embeds, readable in full via `__data(type)`. */
  data?: string[]
  hasOverlay: boolean
  /** Set when the tree was too large to show whole; the full text is at this path. */
  fullPath?: string
}

interface ExplorationData {
  explored: number[]
  current: number[]
  unexplored: number[]
}

function toRanges(pages: number[]): string {
  if (pages.length === 0) return ""
  const sorted = [...pages].sort((a, b) => a - b)
  const ranges: string[] = []
  let start = sorted[0]
  let end = start
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i]
    } else {
      ranges.push(start === end ? `P${start}` : `P${start}-${end}`)
      start = sorted[i]
      end = start
    }
  }
  ranges.push(start === end ? `P${start}` : `P${start}-${end}`)
  return ranges.join(",")
}

function buildScrollBar(data: ExplorationData): string {
  const total = data.explored.length + data.current.length + data.unexplored.length
  const parts: string[] = [`${total} pages`]
  if (data.current.length > 0) parts.push(`viewing ${toRanges(data.current)}`)
  if (data.unexplored.length > 0) {
    const currentSet = new Set(data.current)
    const adjacentToView = data.unexplored.some((p) => currentSet.has(p - 1) || currentSet.has(p + 1))
    const jumpHint = !adjacentToView ? ` (use browser_scroll_to_page to jump directly)` : ""
    parts.push(`unexplored ${toRanges(data.unexplored)}${jumpHint}`)
  } else {
    parts.push("fully explored — if target not found, try a different approach")
  }
  return parts.join(" | ")
}

function formatExplorationBars(
  explorationBars?: Map<number, ExplorationData> | null,
): string | undefined {
  if (!explorationBars) return undefined
  const parts: string[] = []
  for (const [index, data] of explorationBars) {
    parts.push(`[container:${index}] ${buildScrollBar(data)}`)
  }
  if (parts.length === 0) return undefined
  return parts.join("\n")
}

function formatTabList(
  tabs: { id: string; title: string; url: string; isActive: boolean }[],
): string | undefined {
  if (tabs.length <= 1) return undefined
  const lines = tabs.map(
    (t) => `- ${t.isActive ? "[active] " : ""}[tab:${t.id}] ${t.title} (${t.url.slice(0, 80)})`,
  )
  return lines.join("\n")
}

/**
 * Names the schema types the page embeds, without reading any of the values.
 *
 * Whether structured data is worth asking for is otherwise invisible: it lives
 * in script tags the snapshot prunes away, so the only way to find out is to
 * spend a browser_execute_script call and see. Listing the types up front turns
 * that guess into a fact — and a thin answer on one page stops reading as
 * evidence about the site, which is how a page carrying a full record gets
 * scraped by hand instead.
 */
const DATA_TYPES_PROBE = `(function () {
  var types = {};
  var note = function (t) {
    if (!t) return;
    if (Array.isArray(t)) return t.forEach(note);
    t = String(t).split('/').pop();
    if (t) types[t] = 1;
  };
  var walk = function (o, depth) {
    if (!o || typeof o !== 'object' || depth > 3) return;
    if (Array.isArray(o)) return o.forEach(function (x) { walk(x, depth + 1); });
    if (o['@graph']) return walk(o['@graph'], depth + 1);
    note(o['@type']);
  };
  var ld = document.querySelectorAll('script[type="application/ld+json"]');
  for (var i = 0; i < ld.length && i < 20; i++) {
    try { walk(JSON.parse(ld[i].textContent), 0); } catch (e) {}
  }
  var scopes = document.querySelectorAll('[itemscope][itemtype]');
  for (var s = 0; s < scopes.length && s < 50; s++) note(scopes[s].getAttribute('itemtype'));
  return Object.keys(types).slice(0, 12);
})()`

/**
 * Extract DOM from the active tab, compute a diff against the previous
 * snapshot when possible, park the serialized tree in the tab's snapshot cache,
 * and return only the metadata describing it.
 */
export async function getPageDom(
  manager: BrowserManager,
  truncate: Truncate.Interface,
  opts?: { tab?: TabState; forceFull?: boolean; sessionID?: string },
): Promise<DomMeta> {
  await manager.syncActiveTab()
  const activeTab = opts?.tab ?? manager.getActiveTab()
  const { domService } = activeTab
  const tabId = activeTab.id

  return domService.withClient(async () => {
    const domId = domService.generateDomId()
    const previousDomId = activeTab.lastDomId

    // Extract and render DOM tree (settle wait happens inside buildTree)
    const domTree = await domService.extractCurrentDomTree({ expand: 0.8 })
    const renderResult = await domService.renderDomTree(domTree)
    const url = activeTab.page.url()
    const viewportStats = await domService.computeViewportStats(renderResult.scrollContainerMap)
    const historyEntryId = await domService.captureHistoryEntryId()
    const explorationBars = domService.getExplorationBars(domId)
    const tabList = manager.listTabs()

    // Cache the snapshot
    domService.setCachedDomTree(
      domId,
      domTree,
      renderResult.selectorMap,
      renderResult.scrollContainerMap,
      renderResult.visualElementMap,
      url,
      viewportStats,
      0.8,
      renderResult.hasOverlay,
      renderResult.topElementCount,
      historyEntryId,
    )

    const dataTypes: string[] = await domService.evaluateWithReturn(DATA_TYPES_PROBE).catch(() => [])

    const baseMeta = {
      domId,
      tabId,
      title: domTree.axNode?.name?.trim() || "",
      url,
      scrollMap: formatExplorationBars(explorationBars),
      tabs: formatTabList(tabList),
      ...(dataTypes.length > 0 ? { data: dataTypes } : {}),
      hasOverlay: renderResult.hasOverlay,
    }

    // Try diff when we have a previous snapshot on the same tab
    let diffMode: "full" | "incremental" | "added" | "nochange" = "full"
    let domHtml = renderResult.html

    if (previousDomId && !opts?.forceFull) {
      // Build the diff tree once and reuse it for both stats and rendering
      const bothTree = domService.getDiffTree(previousDomId, domId, "both")
      const diffStats = domService.getDiffStats(previousDomId, domId, bothTree)

      if (diffStats !== null) {
        if (diffStats.added === 0 && diffStats.removed === 0) {
          activeTab.lastDomId = domId
          return { ...baseMeta, mode: "nochange" as const }
        }

        const isIncremental =
          Math.max(diffStats.addedRatio, diffStats.removedRatio) < INCREMENTAL_DIFF_RATIO_THRESHOLD

        // highlight: false — overlays were already drawn for the full tree above.
        // Re-running the highlight pass here would wipe them and redraw only the
        // diff subset (visible flash + wrong element set), at double the CDP cost.
        if (isIncremental) {
          if (bothTree) {
            const diffResult = await domService.renderDomTree(bothTree, {
              incrementalDiff: true,
              highlight: false,
            })
            domHtml = diffResult.html
            diffMode = "incremental"
          }
        } else {
          const addedTree = domService.getDiffTree(previousDomId, domId, "added")
          if (addedTree) {
            const diffResult = await domService.renderDomTree(addedTree, { highlight: false })
            domHtml = diffResult.html
            diffMode = "added"
          }
        }
      }
    }

    activeTab.lastDomId = domId

    // Same budget every other tool output answers to, applied to the tree alone:
    // an oversized page is written out in full and only its head is kept, while
    // the sections that frame it — scroll map, notices, reminder — always survive.
    const trimmed = await Effect.runPromise(truncate.output(domHtml))

    // Park the serialized tree next to the snapshot it belongs to; the session
    // layer renders it back into the conversation when it builds model messages.
    domService.setRenderedHtml(domId, trimmed.content)

    const meta: DomMeta = {
      ...baseMeta,
      mode: diffMode,
      ...(trimmed.truncated ? { fullPath: trimmed.outputPath } : {}),
    }
    dumpSnapshot(meta, trimmed.content, opts?.sessionID)
    return meta
  })
}

/** How long a session's snapshots stay on disk before the next sweep removes them. */
const DUMP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DUMP_ROOT = path.join(Global.Path.data, "dom-snapshots")
let sweptDumps = false

/**
 * Where snapshots are written, or undefined when dumping is switched off.
 *
 * On by default, the way tool-output truncation already keeps full outputs on
 * disk: the rendered tree exists only in memory and never reaches the tool
 * result, so once a run is over there is otherwise no way to see what the model
 * was looking at when it made a call. Set OPENCODE_BROWSER_DOM_DUMP to a path
 * to redirect it, or to 0/false to turn it off.
 */
function dumpRoot(): string | undefined {
  const override = process.env.OPENCODE_BROWSER_DOM_DUMP
  if (override === "0" || override === "false") return undefined
  return override || DUMP_ROOT
}

/** Drop session folders past the retention window. Once per process is enough. */
async function sweepDumps(root: string): Promise<void> {
  if (sweptDumps) return
  sweptDumps = true
  const cutoff = Date.now() - DUMP_RETENTION_MS
  const entries = await fs.promises.readdir(root).catch(() => [] as string[])
  for (const entry of entries) {
    const target = path.join(root, entry)
    const info = await fs.promises.stat(target).catch(() => undefined)
    if (!info || info.mtimeMs >= cutoff) continue
    await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Write one snapshot as the model will see it, named by the tab and domId that
 * identify it everywhere else.
 */
function dumpSnapshot(meta: DomMeta, html: string, sessionID?: string): void {
  const root = dumpRoot()
  if (!root) return
  // Sessions share one browser and its tabs keep counting across them, so the
  // session has to be in the path or a run's snapshots arrive as a flat pile
  // with nothing to say which task each belongs to.
  const target = sessionID ? path.join(root, sessionID) : root
  const file = path.join(target, `${meta.tabId}-${meta.domId}.txt`)
  const body = renderDom(meta, html)
  // Fire and forget: a debug artifact must not hold up the extraction, nor take
  // it down when the disk refuses.
  void (async () => {
    await sweepDumps(root)
    await fs.promises.mkdir(target, { recursive: true }).catch(() => {})
    await fs.promises.writeFile(file, body, "utf-8").catch(() => {})
  })()
}

/**
 * Decide which snapshots the model still needs in full, newest last.
 *
 * The newest one always survives. A diff only means something on top of the
 * snapshot it was computed against, so an incremental newest drags its base
 * chain along: every incremental below it, down to and including the nearest
 * full or added snapshot. "nochange" asserts the previous snapshot still
 * stands, so it pulls the chain in the same way while never being a base
 * itself. Everything outside that collapses to a placeholder.
 */
export function computeDomKeep(metas: DomMeta[]): Set<string> {
  const keep = new Set<string>()
  if (metas.length === 0) return keep

  const last = metas[metas.length - 1]
  keep.add(domKey(last))
  if (last.mode !== "incremental" && last.mode !== "nochange") return keep

  for (let i = metas.length - 2; i >= 0; i--) {
    const prev = metas[i]
    // A diff is always computed against the previous snapshot of its own tab,
    // so another tab's snapshot can never be the base of this chain.
    if (prev.tabId !== last.tabId) continue
    if (prev.mode === "nochange") continue
    keep.add(domKey(prev))
    if (prev.mode === "full" || prev.mode === "added") break
  }
  return keep
}

/**
 * Identity of a snapshot across the whole conversation. domIds restart per tab,
 * so the tab has to be part of the key or two tabs' `dom0` collide.
 */
export function domKey(meta: DomMeta): string {
  return `${meta.tabId}/${meta.domId}`
}

function stateIdOf(meta: DomMeta): string {
  return `${meta.tabId}-${meta.domId.split(".")[0]}`
}

/**
 * The `<state>` block: everything needed to place this snapshot before reading
 * the tree — which page, which mode, where the viewport sits, what is unseen.
 *
 * Kept and collapsed snapshots share it, so the two read the same way and the
 * presence of a `<dom>` block after it is what says whether the tree survived.
 */
function stateSection(meta: DomMeta): string {
  const lines = [`stateId: ${stateIdOf(meta)}`, `mode: ${meta.mode}`]
  if (meta.title) lines.push(`title: ${meta.title}`)
  // Kept whole rather than shortened: a clipped query string is no longer an
  // address that browser_goto can be handed back.
  if (meta.url) lines.push(`url: ${meta.url}`)
  // A one-line value rides on the label; only a genuinely multi-line one — several
  // tabs, several scroll containers — is worth the break.
  const field = (label: string, value: string) =>
    value.includes("\n") ? lines.push(`${label}:`, value) : lines.push(`${label}: ${value}`)
  if (meta.tabs) field("tabs", meta.tabs)
  if (meta.scrollMap) field("scroll", meta.scrollMap)
  if (meta.data?.length) lines.push(`data: ${meta.data.join(", ")} — readable via __data("Type")`)
  return `<state>\n${lines.join("\n")}\n</state>`
}

/**
 * Render a DOM snapshot for the model. `html` is the serialized tree pulled
 * back from the tab's snapshot cache; when it is gone (cache evicted, browser
 * restarted) the caller falls back to `renderOmittedDom`.
 *
 * Notices and tips sit between `<state>` and `<dom>` on purpose: each one tells
 * the model how to read the tree it is about to meet — that an overlay may be
 * occluding it, or what the `+|` prefixes on its rows mean. The retention
 * reminder is the exception and trails the tree, being the last word before the
 * model acts.
 */
export function renderDom(meta: DomMeta, html: string): string {
  if (meta.mode === "nochange") {
    return `\n\n${stateSection(meta)}\nNo DOM changes detected after the previous action.`
  }

  const overlay = meta.hasOverlay
    ? "\n**Notice**: An overlay (modal/dialog) is covering the page. Handle or dismiss it first."
    : ""
  const diffTip =
    meta.mode === "incremental"
      ? "\n**Tip**: Elements prefixed with `+|` are newly added and `-|` are removed since the previous action. Removed elements are no longer interactive."
      : meta.mode === "added"
        ? "\n**Tip**: Elements prefixed with `+|` are newly appeared since the previous action."
        : ""
  const retention =
    "\n**Reminder**: This DOM snapshot will be replaced after your next browser action. Record any important data (answers, values, navigation cues) in your text output now — unrecorded information will be lost."

  return `\n\n${stateSection(meta)}${overlay}${diffTip}\n<dom>\n${html}\n</dom>${retention}`
}

/** Render a snapshot the model no longer needs in full. */
export function renderOmittedDom(meta: DomMeta): string {
  const stateId = stateIdOf(meta)
  return `\n\n${stateSection(meta)}\n[DOM omitted. Use \`browser_restore_state\` with stateId "${stateId}" to restore this page.]`
}
