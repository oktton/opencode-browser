import { Effect, Schema } from "effect"
import * as Tool from "../../tool"
import { BrowserManager } from "../manager"
import { getPageDom } from "../dom-utils"

export const BrowserNewTabTool = Tool.define(
  "browser_new_tab",
  Effect.succeed({
    description: "Open a new tab and optionally navigate to a URL",
    parameters: Schema.Struct({
      url: Schema.optional(Schema.String).annotate({ description: "The URL to open in the new tab" }),
    }),
    execute: (params: { url?: string }, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const manager = BrowserManager.getInstance()
        manager.ensureStarted()
        const tab = yield* Effect.promise(() => manager.newTab(params.url))
        if (params.url) {
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 2000)))
        }
        const dom = yield* Effect.promise(() => getPageDom(manager))
        return {
          title: `New tab${params.url ? ` → ${params.url}` : ""}`,
          output: `Opened new tab${params.url ? ` and navigated to ${params.url}` : ""}${dom.output}`,
          metadata: { tabId: tab.id, domId: dom.domId },
        }
      }),
  }),
)

export const BrowserSwitchTabTool = Tool.define(
  "browser_switch_tab",
  Effect.succeed({
    description: "Switch to a different tab by its ID",
    parameters: Schema.Struct({
      tabId: Schema.String.annotate({ description: "The tab ID to switch to" }),
    }),
    execute: (params: { tabId: string }, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const manager = BrowserManager.getInstance()
        manager.ensureStarted()
        const tab = yield* Effect.promise(() => manager.switchTab(params.tabId))
        const dom = yield* Effect.promise(() => getPageDom(manager))
        return {
          title: `Switch to ${params.tabId}`,
          output: `Switched to tab ${params.tabId}: ${tab.page.url()}${dom.output}`,
          metadata: { tabId: params.tabId, domId: dom.domId },
        }
      }),
  }),
)

export const BrowserCloseTabTool = Tool.define(
  "browser_close_tab",
  Effect.succeed({
    description: "Close one or more tabs by their IDs. If no tabIds provided, closes the current active tab.",
    parameters: Schema.Struct({
      tabIds: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Tab IDs to close. Defaults to the active tab." }),
    }),
    execute: (params: { tabIds?: readonly string[] }, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const manager = BrowserManager.getInstance()
        manager.ensureStarted()
        const targets = params.tabIds?.length ? [...params.tabIds] : [manager.getActiveTab().id]
        for (const id of targets) {
          yield* Effect.promise(() => manager.closeTab(id))
        }

        let domOutput = ""
        if (manager.hasActiveTab()) {
          const tab = manager.getActiveTab()
          const dom = yield* Effect.promise(() => getPageDom(manager))
          domOutput = dom.output
        }

        return {
          title: `Close tab${targets.length > 1 ? "s" : ""}: ${targets.join(", ")}`,
          output: `Closed tab${targets.length > 1 ? "s" : ""}: ${targets.join(", ")}${domOutput}`,
          metadata: {},
        }
      }),
  }),
)
