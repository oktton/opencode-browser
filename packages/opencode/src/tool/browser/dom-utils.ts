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
  /** full = complete DOM (new base), incremental = small diff (preserves base), added = large diff (new base), nochange = nothing changed */
  mode: "full" | "incremental" | "added" | "nochange"
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
  tab?: TabState,
): Promise<DomResult> {
  await manager.syncActiveTab()
  const activeTab = tab ?? manager.getActiveTab()
  const { domService } = activeTab
  const tabId = activeTab.id

  return domService.withClient(async () => {
    const domId = domService.generateDomId()
    const stateId = `${tabId}-${domId.split(".")[0]}`
    const previousDomId = activeTab.lastDomId

    // Extract and render DOM tree (settle wait happens inside buildTree)
    const domTree = await domService.extractCurrentDomTree({ expand: 0.8 })
    const renderResult = await domService.renderDomTree(domTree)
    const url = activeTab.page.url()
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
    let diffMode: "full" | "incremental" | "added" | "nochange" = "full"
    let domHtml = renderResult.html

    if (previousDomId) {
      const diffStats = domService.getDiffStats(previousDomId, domId)

      if (diffStats !== null) {
        if (diffStats.added === 0 && diffStats.removed === 0) {
          activeTab.lastDomId = domId
          return {
            output: `\n\n${DOM_START} ${domId} tab:${tabId} mode:nochange -->\nNo DOM changes detected after the previous action.\n${DOM_END}`,
            domId,
            tabId,
            mode: "nochange" as const,
          }
        }

        const isIncremental =
          Math.max(diffStats.addedRatio, diffStats.removedRatio) < INCREMENTAL_DIFF_RATIO_THRESHOLD

        if (isIncremental) {
          const diffTree = domService.getDiffTree(previousDomId, domId, "both")
          if (diffTree) {
            const diffResult = await domService.renderDomTree(diffTree, { incrementalDiff: true })
            domHtml = diffResult.html
            diffMode = "incremental"
          }
        } else {
          const diffTree = domService.getDiffTree(previousDomId, domId, "added")
          if (diffTree) {
            const diffResult = await domService.renderDomTree(diffTree)
            domHtml = diffResult.html
            diffMode = "added"
          }
        }
      }
    }

    activeTab.lastDomId = domId

    // Build output with delimiter markers
    const overlayNotice = renderResult.hasOverlay
      ? "\n**Notice**: An overlay (modal/dialog) is covering the page. Handle or dismiss it first."
      : ""
    const bars = formatExplorationBars(explorationBars)
    const tabs = formatTabList(tabList)
    const diffTip =
      diffMode === "incremental"
        ? "\n**Tip**: Elements prefixed with `+|` are newly added and `-|` are removed since the previous action. Removed elements are no longer interactive."
        : diffMode === "added"
          ? "\n**Tip**: Elements prefixed with `+|` are newly appeared since the previous action."
          : ""

    const header = diffMode === "incremental" || diffMode === "added" ? "## Incremental DOM updates" : "## Current Page DOM Structure"

    const retentionTip = "\n**Reminder**: This DOM snapshot will be replaced after your next browser action. Record any important data (answers, values, navigation cues) in your text output now — unrecorded information will be lost."

    const content = `(stateId: ${stateId})\n${header}\n${tabs}\n\n${domHtml}${bars}${overlayNotice}${diffTip}${retentionTip}`

    return {
      output: `\n\n${DOM_START} ${domId} tab:${tabId} mode:${diffMode} -->\n${content}\n${DOM_END}`,
      domId,
      tabId,
      mode: diffMode,
    }
  })
}

const DOM_SKIPPED_MSG = "\n\n(DOM extraction deferred — will be included in the last concurrent browser tool's output.)"

export function skippedDomOutput(): DomResult {
  return {
    output: DOM_SKIPPED_MSG,
    domId: "",
    tabId: "",
    mode: "nochange",
  }
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

/**
 * Omit stale DOM blocks from browser tool outputs before sending to LLM.
 *
 * Strategy (matches abrowser):
 * - Scan all tool outputs from newest to oldest
 * - The newest DOM block is always kept (it's the current state)
 * - For older blocks, keep the "base chain": a full/added DOM and all
 *   incremental diffs that follow it, until the next full/added DOM appears
 * - Everything outside the base chain gets replaced with an omitted placeholder
 * - view_elements image attachments older than the newest are stripped
 *
 * Base chain example:
 *   [full dom3] → [incremental dom4] → [incremental dom5] → [full dom6]
 *   dom6 = current (kept), dom3-5 = all omitted (dom6 is a new base)
 *
 *   [full dom3] → [incremental dom4] → [incremental dom5]
 *   dom5 = current (kept), dom4 = kept (incremental), dom3 = kept (base for dom4-5)
 */
export function omitStaleDomBlocks(
  toolOutputs: { toolName: string; output: string; index: number }[],
): Map<number, string> {
  const replacements = new Map<number, string>()

  // Collect all DOM blocks with their position info
  const allBlocks: {
    index: number
    mode: string
    domId: string
    tabId: string
  }[] = []

  for (const entry of toolOutputs) {
    const re = new RegExp(DOM_BLOCK_RE.source, "g")
    let match
    while ((match = re.exec(entry.output)) !== null) {
      const meta = parseDomBlockMeta(match[1])
      allBlocks.push({ index: entry.index, ...meta })
    }
  }

  if (allBlocks.length <= 1) return replacements

  // The last block is always the current state — never omit
  // Walk backwards from second-to-last to find what to keep
  const keepSet = new Set<string>() // domIds to keep
  keepSet.add(allBlocks[allBlocks.length - 1].domId)

  const lastBlock = allBlocks[allBlocks.length - 1]

  // If the current (newest) block is incremental, walk backwards to find its base chain
  if (lastBlock.mode === "incremental") {
    for (let i = allBlocks.length - 2; i >= 0; i--) {
      const block = allBlocks[i]
      if (block.mode === "omitted" || block.mode === "nochange") continue
      keepSet.add(block.domId)
      // Stop at full or added — that's the base
      if (block.mode === "full" || block.mode === "added") break
    }
  }

  // Replace non-kept DOM blocks with omitted placeholders
  for (const entry of toolOutputs) {
    const re = new RegExp(DOM_BLOCK_RE.source, "g")
    let modified = false
    const newOutput = entry.output.replace(re, (fullMatch, header) => {
      const meta = parseDomBlockMeta(header)
      if (keepSet.has(meta.domId)) return fullMatch
      modified = true
      return buildOmittedDomPlaceholder(meta.domId, meta.tabId)
    })
    if (modified) {
      replacements.set(entry.index, newOutput)
    }
  }

  return replacements
}
