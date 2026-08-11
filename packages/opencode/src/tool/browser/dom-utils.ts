import type { TabState, BrowserManager } from "./manager"

const INCREMENTAL_DIFF_RATIO_THRESHOLD = 0.3

// DOM delimiter markers for downstream omit processing
const DOM_START = "<!-- DOM_START"
const DOM_END = "<!-- DOM_END -->"

export interface DomResult {
  /** Formatted string to append to tool output */
  output: string
  /** The domId of this snapshot */
  domId: string
  /** The tabId */
  tabId: string
  /** Whether this was a diff or full DOM */
  mode: "full" | "diff" | "nochange"
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
): string {
  if (!explorationBars) return ""
  const parts: string[] = []
  for (const [index, data] of explorationBars) {
    parts.push(`[container:${index}] ${buildScrollBar(data)}`)
  }
  if (parts.length === 0) return ""
  return `\nscrollMap:\n${parts.join("\n")}`
}

function formatTabList(
  tabs: { id: string; title: string; url: string; isActive: boolean }[],
): string {
  if (tabs.length <= 1) return ""
  const lines = tabs.map(
    (t) => `- ${t.isActive ? "[active] " : ""}[tab:${t.id}] ${t.title} (${t.url.slice(0, 80)})`,
  )
  return `\n**Tabs**:\n${lines.join("\n")}`
}

/**
 * Extract DOM from the active tab, compute diff if possible,
 * and return formatted output with DOM delimiters for omit processing.
 */
export async function getPageDom(
  manager: BrowserManager,
  tab: TabState,
): Promise<DomResult> {
  const { domService } = tab
  const tabId = tab.id

  return domService.withClient(async () => {
    const domId = domService.generateDomId()
    const stateId = `${tabId}-${domId.split(".")[0]}`
    const previousDomId = tab.lastDomId

    // Extract and render DOM tree (settle wait happens inside buildTree)
    const domTree = await domService.extractCurrentDomTree({ expand: 0.8 })
    const renderResult = await domService.renderDomTree(domTree)
    const url = tab.page.url()
    const viewportStats = await domService.computeViewportStats(renderResult.scrollContainerMap)
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
    )

    // Try diff when we have a previous snapshot on the same tab
    let diffMode: "full" | "diff" | "nochange" = "full"
    let domHtml = renderResult.html

    if (previousDomId) {
      const diffStats = domService.getDiffStats(previousDomId, domId)

      if (diffStats !== null) {
        if (diffStats.added === 0 && diffStats.removed === 0) {
          tab.lastDomId = domId
          return {
            output: `\n\n${DOM_START} ${domId} tab:${tabId} mode:nochange -->\nNo DOM changes detected after the previous action.\n${DOM_END}`,
            domId,
            tabId,
            mode: "nochange" as const,
          }
        }

        const incremental =
          Math.max(diffStats.addedRatio, diffStats.removedRatio) < INCREMENTAL_DIFF_RATIO_THRESHOLD

        if (incremental) {
          const diffTree = domService.getDiffTree(previousDomId, domId, "both")
          if (diffTree) {
            const diffResult = await domService.renderDomTree(diffTree, { incrementalDiff: true })
            domHtml = diffResult.html
            diffMode = "diff"
          }
        } else {
          const diffTree = domService.getDiffTree(previousDomId, domId, "added")
          if (diffTree) {
            const diffResult = await domService.renderDomTree(diffTree)
            domHtml = diffResult.html
            diffMode = "diff"
          }
        }
      }
    }

    tab.lastDomId = domId

    // Build output with delimiter markers
    const overlayNotice = renderResult.hasOverlay
      ? "\n**Notice**: An overlay (modal/dialog) is covering the page. Handle or dismiss it first."
      : ""
    const bars = formatExplorationBars(explorationBars)
    const tabs = formatTabList(tabList)
    const diffTip =
      diffMode === "diff"
        ? "\n**Tip**: Elements prefixed with `+|` are newly added and `-|` are removed since the previous action."
        : ""

    const header = diffMode === "diff" ? "## Incremental DOM updates" : "## Current Page DOM Structure"

    const content = `(stateId: ${stateId})\n${header}\n${tabs}\n\n${domHtml}${bars}${overlayNotice}${diffTip}`

    return {
      output: `\n\n${DOM_START} ${domId} tab:${tabId} mode:${diffMode} -->\n${content}\n${DOM_END}`,
      domId,
      tabId,
      mode: diffMode as "full" | "diff",
    }
  })
}

/**
 * Build the omitted placeholder for a previously seen DOM snapshot.
 */
export function buildOmittedDomPlaceholder(
  domId: string,
  tabId: string,
  title?: string,
): string {
  const stateId = `${tabId}-${domId.split(".")[0]}`
  const titleLine = title ? `\n**${title}**` : ""
  return `${DOM_START} ${domId} tab:${tabId} mode:omitted -->\n(stateId: ${stateId})\n## Previous Page DOM Snapshot${titleLine}\n[DOM content omitted. Use \`browser_restore_state\` with (stateId: "${stateId}") to restore this page.]\n${DOM_END}`
}

/** Regex to match DOM delimiter blocks in tool output */
export const DOM_BLOCK_RE = /<!-- DOM_START (.+?) -->\n([\s\S]*?)\n<!-- DOM_END -->/g

/** Parse DOM block metadata from the delimiter comment */
export function parseDomBlockMeta(header: string): {
  domId: string
  tabId: string
  mode: string
} {
  const parts = header.trim().split(/\s+/)
  const domId = parts[0] ?? ""
  let tabId = ""
  let mode = ""
  for (const p of parts.slice(1)) {
    if (p.startsWith("tab:")) tabId = p.slice(4)
    else if (p.startsWith("mode:")) mode = p.slice(5)
  }
  return { domId, tabId, mode }
}
