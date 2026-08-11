import z from "zod"
import { Tool } from "../../tool"
import { BrowserManager } from "../manager"
import { getPageDom } from "../dom-utils"

export const BrowserNewTabTool = Tool.define("browser_new_tab", {
  description: "Open a new tab and optionally navigate to a URL",
  parameters: z.object({
    url: z.string().optional().describe("The URL to open in the new tab"),
  }),
  async execute(params, ctx) {
    const manager = BrowserManager.getInstance()
    const tab = await manager.newTab(params.url)
    if (params.url) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    const dom = await getPageDom(manager, tab)
    return {
      title: `New tab${params.url ? ` → ${params.url}` : ""}`,
      output: `Opened new tab${params.url ? ` and navigated to ${params.url}` : ""}${dom.output}`,
      metadata: { tabId: tab.id, domId: dom.domId },
    }
  },
})

export const BrowserSwitchTabTool = Tool.define("browser_switch_tab", {
  description: "Switch to a different tab by its ID",
  parameters: z.object({
    tabId: z.string().describe("The tab ID to switch to"),
  }),
  async execute(params, ctx) {
    const manager = BrowserManager.getInstance()
    const tab = await manager.switchTab(params.tabId)
    const dom = await getPageDom(manager, tab)
    return {
      title: `Switch to ${params.tabId}`,
      output: `Switched to tab ${params.tabId}: ${tab.page.url()}${dom.output}`,
      metadata: { tabId: params.tabId, domId: dom.domId },
    }
  },
})

export const BrowserCloseTabTool = Tool.define("browser_close_tab", {
  description: "Close one or more tabs by their IDs. If no tabIds provided, closes the current active tab.",
  parameters: z.object({
    tabIds: z.array(z.string()).optional().describe("Tab IDs to close. Defaults to the active tab."),
  }),
  async execute(params, ctx) {
    const manager = BrowserManager.getInstance()
    const targets = params.tabIds?.length ? params.tabIds : [manager.getActiveTab().id]
    for (const id of targets) {
      await manager.closeTab(id)
    }

    let domOutput = ""
    if (manager.hasActiveTab()) {
      const tab = manager.getActiveTab()
      const dom = await getPageDom(manager, tab)
      domOutput = dom.output
    }

    return {
      title: `Close tab${targets.length > 1 ? "s" : ""}: ${targets.join(", ")}`,
      output: `Closed tab${targets.length > 1 ? "s" : ""}: ${targets.join(", ")}${domOutput}`,
      metadata: {},
    }
  },
})
