import { Effect, Schema } from "effect"
import * as Tool from "../../tool"
import { BrowserManager } from "../manager"
import { getPageDom, skippedDomOutput } from "../dom-utils"
import type { EnhancedDOMTreeNode } from "../dom/types/dom-node"
import { VALUE_SETTABLE_INPUT_TYPES } from "../dom/tree/clickable-detector"

function findSelectAncestor(node: EnhancedDOMTreeNode): EnhancedDOMTreeNode | undefined {
  let current = node.parentNode
  while (current) {
    if (current.nodeName.toLowerCase() === "select") return current
    current = current.parentNode
  }
  return undefined
}

function isValueSettableElement(node: EnhancedDOMTreeNode): boolean {
  const tagName = node.nodeName.toLowerCase()
  if (tagName === "input") {
    const inputType = (node.attributes?.type ?? "text").toLowerCase()
    return VALUE_SETTABLE_INPUT_TYPES.has(inputType)
  }
  return node.attributes?.role === "slider"
}

async function getElementDataByIndex(tab: import("../manager").TabState, elementIndex: number) {
  const selectorMap = tab.domService.getLatestSelectorMap()
  if (!selectorMap) return null
  const node = selectorMap.get(elementIndex)
  if (!node) return null

  const interactionNode = node.renderInfo?.isSelectOption ? (findSelectAncestor(node) ?? node) : node

  return tab.domService.withClient(async () => {
    let rect = await tab.domService.getElementRect(interactionNode)
    const scrollInfo = await tab.domService.getScrollInfoByIndex(0)
      .catch(() => ({ scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 900, totalWidth: 1280, totalHeight: 900 }))

    const inViewport =
      rect.y + rect.height > 0 &&
      rect.y < scrollInfo.viewportHeight &&
      rect.x + rect.width > 0 &&
      rect.x < scrollInfo.viewportWidth

    if (!inViewport) {
      await tab.domService.scrollToElement(interactionNode)
      await new Promise((resolve) => setTimeout(resolve, 150))
      rect = await tab.domService.getElementRect(interactionNode)
    }

    return {
      node,
      rect,
      isFill: node.renderInfo?.isFill ?? false,
      isSelectOption: node.renderInfo?.isSelectOption ?? false,
      renderedLine: node.renderInfo?.renderedLine,
    }
  })
}

export const BrowserClickTool = Tool.define(
  "browser_click",
  Effect.succeed({
    description: `Click on a specific element on the page.
Only use on elements marked with [N] or <N> in the DOM.
Do NOT interact with off-screen elements — scroll first with browser_reveal_offscreen.`,
    parameters: Schema.Struct({
      elementIndex: Schema.Number.annotate({ description: "The numeric ID of the element to click (e.g., 5 for [5]<button>)" }),
    }),
    execute: (params: { elementIndex: number }, ctx: Tool.Context) =>
      Effect.promise(() => {
        const manager = BrowserManager.getInstance()
        const tab = manager.getActiveTab()
        return manager.enqueue(async (isLast) => {
          const elementData = await getElementDataByIndex(tab, params.elementIndex)
          if (!elementData) {
            return {
              title: `Click [${params.elementIndex}]`,
              output: `Element [${params.elementIndex}] not found or not clickable in the current DOM.`,
              metadata: {},
            }
          }

          return tab.domService.withClient(async () => {
            if (elementData.isSelectOption) {
              await tab.domService.selectOption(elementData.node)
              tab.domService.recordInteraction(elementData.node.backendNodeId, "select", elementData.renderedLine)
              await new Promise((resolve) => setTimeout(resolve, 200))
              const dom = isLast() ? await getPageDom(manager) : skippedDomOutput()
              return {
                title: `Select ${elementData.renderedLine?.trim() ?? `[${params.elementIndex}]`}`,
                output: `Selected ${elementData.renderedLine?.trim() ?? `option [${params.elementIndex}]`}${dom.output}`,
                metadata: {},
              }
            }

            const { rect } = elementData
            const cssX = rect.x + rect.width / 2
            const cssY = rect.y + rect.height / 2

            const isHit = await tab.domService.hitTestAtPoint(elementData.node, rect)
            if (!isHit) {
              return {
                title: `Click [${params.elementIndex}]`,
                output: `Element [${params.elementIndex}] is occluded by another element. Try closing overlays or scrolling.`,
                metadata: {},
              }
            }

            await tab.domService.click(cssX, cssY)
            tab.domService.recordInteraction(elementData.node.backendNodeId, "click", elementData.renderedLine)
            await new Promise((resolve) => setTimeout(resolve, 500))

            const dom = isLast() ? await getPageDom(manager) : skippedDomOutput()
            return {
              title: `Click ${elementData.renderedLine?.trim() ?? `[${params.elementIndex}]`}`,
              output: `Clicked ${elementData.renderedLine?.trim() ?? `element [${params.elementIndex}]`}${dom.output}`,
              metadata: {},
            }
          })
        })
      }),
  }),
)

export const BrowserInputTool = Tool.define(
  "browser_input",
  Effect.succeed({
    description: `Fill text into an input field.
Only use on elements marked with <N> in the DOM (not [N]).
TIP: For search boxes, use pressEnter: true to submit directly.
Supports range, color, date inputs and ARIA sliders.`,
    parameters: Schema.Struct({
      elementIndex: Schema.Number.annotate({ description: "The numeric ID of the input element (e.g., 3 for <3><input>)" }),
      text: Schema.String.annotate({ description: "The text content to input" }),
      clear: Schema.optional(Schema.Boolean).annotate({ description: "Whether to clear existing text before input (default: true)" }),
      pressEnter: Schema.optional(Schema.Boolean).annotate({ description: "Whether to press Enter after input (default: false)" }),
    }),
    execute: (params: { elementIndex: number; text: string; clear?: boolean; pressEnter?: boolean }, ctx: Tool.Context) =>
      Effect.promise(() => {
        const clear = params.clear ?? true
        const pressEnter = params.pressEnter ?? false
        const manager = BrowserManager.getInstance()
        const tab = manager.getActiveTab()
        return manager.enqueue(async (isLast) => {
          const elementData = await getElementDataByIndex(tab, params.elementIndex)
          if (!elementData) {
            return {
              title: `Input [${params.elementIndex}]`,
              output: `Element [${params.elementIndex}] not found in the current DOM.`,
              metadata: {},
            }
          }
          if (!elementData.isFill) {
            return {
              title: `Input [${params.elementIndex}]`,
              output: `Element [${params.elementIndex}] is not an input element. Use browser_click instead.`,
              metadata: {},
            }
          }

          return tab.domService.withClient(async () => {
            if (isValueSettableElement(elementData.node)) {
              await tab.domService.setInputValue(elementData.node, params.text)
            } else {
              const { rect } = elementData
              const cssX = rect.x + rect.width / 2
              const cssY = rect.y + rect.height / 2

              const isHit = await tab.domService.hitTestAtPoint(elementData.node, rect)
              if (!isHit) {
                return {
                  title: `Input [${params.elementIndex}]`,
                  output: `Element [${params.elementIndex}] is occluded. Try closing overlays or scrolling.`,
                  metadata: {},
                }
              }

              await tab.domService.click(cssX, cssY)
              await new Promise((resolve) => setTimeout(resolve, 100))

              if (clear) {
                await tab.page.keyboard.down("Control")
                await tab.page.keyboard.press("a")
                await tab.page.keyboard.up("Control")
                await new Promise((resolve) => setTimeout(resolve, 50))
              }

              await tab.page.keyboard.type(params.text)
            }

            tab.domService.recordInteraction(elementData.node.backendNodeId, "input", elementData.renderedLine)

            if (pressEnter) {
              await tab.domService.pressEnter()
            }

            await new Promise((resolve) => setTimeout(resolve, 300))
            const dom = isLast() ? await getPageDom(manager) : skippedDomOutput()
            return {
              title: `Input "${params.text}" into [${params.elementIndex}]`,
              output: `Input "${params.text}" into ${elementData.renderedLine?.trim() ?? `element <${params.elementIndex}>`}${pressEnter ? " and pressed Enter" : ""}${dom.output}`,
              metadata: {},
            }
          })
        })
      }),
  }),
)
