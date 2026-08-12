import { Effect, Schema } from "effect"
import * as Tool from "../../tool"
import { BrowserManager } from "../manager"
import { getPageDom } from "../dom-utils"

function currentPage(scrollInfo: { scrollY: number; viewportHeight: number }): number {
  if (scrollInfo.viewportHeight <= 0) return 0
  return Math.round((scrollInfo.scrollY / scrollInfo.viewportHeight) * 10) / 10
}

export const BrowserRevealOffscreenTool = Tool.define(
  "browser_reveal_offscreen",
  Effect.succeed({
    description: `Scroll to reveal off-screen elements.

Use when:
- You need to view full content or interact with elements inside === OFF-SCREEN === blocks in the DOM
- If you know the exact element you want to reveal, use 'target' to scroll directly to it

Container: Use index N from [container:N] in OFF-SCREEN blocks.`,
    parameters: Schema.Struct({
      direction: Schema.Literals(["up", "down"]).annotate({ description: "Match the OFF-SCREEN direction: below→down, above→up" }),
      container: Schema.Number.annotate({ description: "Scroll container index N from [container:N] in DOM comments." }),
      target: Schema.optional(Schema.String).annotate({ description: "Copy the element or text you want to reveal in OFF-SCREEN blocks." }),
    }),
    execute: (params: { direction: "up" | "down"; container: number; target?: string }, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const manager = BrowserManager.getInstance()
        const tab = manager.getActiveTab()
        const { domService } = tab

        if (params.target) {
          const node = yield* Effect.promise(() =>
            domService.scrollToOffscreenElementByIndex(params.target!, params.container, params.direction),
          )
          if (node) {
            yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))
            const dom = yield* Effect.promise(() => getPageDom(manager))
            return {
              title: `Scroll to "${params.target}" in [container:${params.container}]`,
              output: `Scrolled to element in container [${params.container}]: ${params.target}${dom.output}`,
              metadata: {},
            }
          }
        }

        const info = yield* Effect.promise(() => domService.getScrollInfoByIndex(params.container))
        const beforePos = currentPage(info)

        const isHorizontal =
          params.container > 0 &&
          (domService.getScrollContainerNode(params.container)?.renderInfo?.isHorizontalScroll ?? false)

        let targetX = info.scrollX
        let targetY = info.scrollY

        if (params.direction === "down") {
          if (isHorizontal) targetX = info.scrollX + info.viewportWidth * 0.9
          else targetY = info.scrollY + info.viewportHeight * 0.9
        } else {
          if (isHorizontal) targetX = info.scrollX - info.viewportWidth * 0.9
          else targetY = info.scrollY - info.viewportHeight * 0.9
        }

        yield* Effect.promise(() => domService.scrollToPositionByIndex(params.container, targetX, targetY))
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))

        const newInfo = yield* Effect.promise(() => domService.getScrollInfoByIndex(params.container))
        const afterPos = currentPage(newInfo)
        const atStart = isHorizontal ? newInfo.scrollX <= 0 : newInfo.scrollY <= 0
        const atEnd = isHorizontal
          ? newInfo.scrollX + newInfo.viewportWidth >= newInfo.totalWidth - 1
          : newInfo.scrollY + newInfo.viewportHeight >= newInfo.totalHeight - 1

        let hint = ""
        if (params.direction === "up" && atStart) hint = " (Already at the TOP of the page)"
        else if (params.direction === "down" && atEnd) hint = " (Already at the BOTTOM of the page)"

        const targetHint = params.target
          ? ` Target "${params.target}" not found in off-screen elements. Tip: use \`browser_execute_script\` with \`__find()\` + \`scrollIntoView()\` to locate elements.`
          : ""

        const dom = yield* Effect.promise(() => getPageDom(manager))
        return {
          title: `Scroll ${params.direction} [container:${params.container}]`,
          output: `Scrolled ${params.direction} on container [${params.container}]: P${beforePos} → P${afterPos}${hint}${targetHint}${dom.output}`,
          metadata: {},
        }
      }),
  }),
)

export const BrowserScrollNextScreenTool = Tool.define(
  "browser_scroll_next_screen",
  Effect.succeed({
    description: `Scroll to scan through unseen content. Each call advances past the current expand zone into content not yet in the DOM.

Best for discovering unknown content. If you already know what to find, consider browser_execute_script with __find() + scrollIntoView() — it's faster.

Container: index N from [container:N] comments.`,
    parameters: Schema.Struct({
      direction: Schema.Literals(["down", "up"]).annotate({ description: "Direction to explore" }),
      container: Schema.Number.annotate({ description: "Scroll container index N from [container:N] in DOM comments." }),
    }),
    execute: (params: { direction: "down" | "up"; container: number }, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const manager = BrowserManager.getInstance()
        const tab = manager.getActiveTab()
        const { domService } = tab

        const info = yield* Effect.promise(() => domService.getScrollInfoByIndex(params.container))
        const expand = domService.getLatestExpand() ?? 1
        const beforePos = currentPage(info)

        const isHorizontal =
          params.container > 0 &&
          (domService.getScrollContainerNode(params.container)?.renderInfo?.isHorizontalScroll ?? false)

        let targetX = info.scrollX
        let targetY = info.scrollY

        if (isHorizontal) {
          const delta = (0.9 + expand) * info.viewportWidth
          if (params.direction === "down") targetX = info.scrollX + delta
          else targetX = info.scrollX - delta
        } else {
          const delta = (0.9 + expand) * info.viewportHeight
          if (params.direction === "down") targetY = info.scrollY + delta
          else targetY = info.scrollY - delta
        }

        yield* Effect.promise(() => domService.scrollToPositionByIndex(params.container, targetX, targetY))
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))

        const newInfo = yield* Effect.promise(() => domService.getScrollInfoByIndex(params.container))
        const afterPos = currentPage(newInfo)
        const atStart = isHorizontal ? newInfo.scrollX <= 0 : newInfo.scrollY <= 0
        const atEnd = isHorizontal
          ? newInfo.scrollX + newInfo.viewportWidth >= newInfo.totalWidth - 1
          : newInfo.scrollY + newInfo.viewportHeight >= newInfo.totalHeight - 1

        let hint = ""
        if (params.direction === "down" && atEnd) hint = " (Reached the BOTTOM of the page)"
        else if (params.direction === "up" && atStart) hint = " (Reached the TOP of the page)"

        const dom = yield* Effect.promise(() => getPageDom(manager))
        return {
          title: `Scroll ${params.direction} next screen [container:${params.container}]`,
          output: `Scrolled ${params.direction} to next screen on container [${params.container}]: P${beforePos} → P${afterPos}${hint}${dom.output}`,
          metadata: {},
        }
      }),
  }),
)

export const BrowserScrollToPageTool = Tool.define(
  "browser_scroll_to_page",
  Effect.succeed({
    description: `Jump to a specific page in a scroll container.
Use unexplored pages in scroll_map to explore new content, or restore a previous scroll position.`,
    parameters: Schema.Struct({
      page: Schema.Number.annotate({ description: "Target page index from Page Info (P value)." }),
      container: Schema.Number.annotate({ description: "Scroll container index N from [container:N] in DOM comments." }),
    }),
    execute: (params: { page: number; container: number }, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const manager = BrowserManager.getInstance()
        const tab = manager.getActiveTab()
        const { domService } = tab

        const info = yield* Effect.promise(() => domService.getScrollInfoByIndex(params.container))
        const beforePos = currentPage(info)

        const isHorizontal =
          params.container > 0 &&
          (domService.getScrollContainerNode(params.container)?.renderInfo?.isHorizontalScroll ?? false)

        let targetX = info.scrollX
        let targetY = info.scrollY
        if (isHorizontal) {
          targetX = params.page * info.viewportWidth
        } else {
          targetY = params.page * info.viewportHeight
        }

        yield* Effect.promise(() => domService.scrollToPositionByIndex(params.container, targetX, targetY))
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))

        const newInfo = yield* Effect.promise(() => domService.getScrollInfoByIndex(params.container))
        const afterPos = currentPage(newInfo)
        const atStart = isHorizontal ? newInfo.scrollX <= 0 : newInfo.scrollY <= 0
        const atEnd = isHorizontal
          ? newInfo.scrollX + newInfo.viewportWidth >= newInfo.totalWidth - 1
          : newInfo.scrollY + newInfo.viewportHeight >= newInfo.totalHeight - 1

        let hint = ""
        if (atStart && atEnd) hint = " (Content fits in one page)"
        else if (atStart) hint = " (At the TOP of the page)"
        else if (atEnd) hint = " (At the BOTTOM of the page)"

        const dom = yield* Effect.promise(() => getPageDom(manager))
        return {
          title: `Scroll to P${params.page} [container:${params.container}]`,
          output: `Scrolled to target page on container [${params.container}]: P${beforePos} → P${afterPos}${hint}${dom.output}`,
          metadata: {},
        }
      }),
  }),
)
