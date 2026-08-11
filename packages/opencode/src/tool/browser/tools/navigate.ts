import z from "zod"
import { Tool } from "../../tool"
import { BrowserManager } from "../manager"
import { getPageDom } from "../dom-utils"

export const BrowserGotoTool = Tool.define("browser_goto", {
  description: `Navigate to a website URL. Opens a browser window if not already open.
Use this when you need to go to a specific URL or website.
TIP: You can revisit a URL from previous DOM snapshots to restore a prior page state.`,
  parameters: z.object({
    url: z.string().describe("The URL to navigate to"),
  }),
  async execute(params, ctx) {
    const manager = BrowserManager.getInstance()
    manager.ensureStarted()
    const tab = manager.getActiveTab()

    await tab.page.goto(params.url, { waitUntil: "domcontentloaded" }).catch(() => {})

    const dom = await getPageDom(manager, tab)
    return {
      title: `Navigate to ${params.url}`,
      output: `Navigated to ${params.url}${dom.output}`,
      metadata: { url: params.url, domId: dom.domId },
    }
  },
})

export const BrowserRefreshTool = Tool.define("browser_refresh", {
  description: "Refresh the current page",
  parameters: z.object({}),
  async execute(_params, ctx) {
    const manager = BrowserManager.getInstance()
    const tab = manager.getActiveTab()

    await tab.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {})

    const dom = await getPageDom(manager, tab)
    return {
      title: "Refresh page",
      output: `Page refreshed${dom.output}`,
      metadata: { domId: dom.domId },
    }
  },
})

export const BrowserRestoreStateTool = Tool.define("browser_restore_state", {
  description: `Navigate back to a previous state by stateId (e.g. "tab0-dom3").
Use this when you made a wrong decision, navigated to an unintended page, or want to revisit a previous state.
The stateId is shown in every DOM snapshot header.`,
  parameters: z.object({
    stateId: z.string().describe('State ID from DOM snapshot header (e.g. "tab0-dom3")'),
  }),
  async execute(params, ctx) {
    const match = params.stateId.match(/^(tab\d+)-(dom\d+)$/)
    if (!match) {
      return {
        title: "Restore state",
        output: `Invalid stateId format: "${params.stateId}". Expected "tabN-domN".`,
        metadata: {} as Record<string, string>,
      }
    }
    const [, tabId, domId] = match
    const manager = BrowserManager.getInstance()
    const tab = manager.getTab(tabId)
    if (!tab) {
      return {
        title: "Restore state",
        output: `Tab "${tabId}" not found. It may have been closed.`,
        metadata: {} as Record<string, string>,
      }
    }

    await manager.switchTab(tabId)
    const snapshotUrl = tab.domService.getCachedUrl(domId)
    if (snapshotUrl) {
      await tab.page.goto(snapshotUrl, { waitUntil: "domcontentloaded" }).catch(() => {})
    }

    const dom = await getPageDom(manager, tab)
    return {
      title: `Restore ${params.stateId}`,
      output: `Restored to ${params.stateId}${dom.output}`,
      metadata: { domId: dom.domId },
    }
  },
})
