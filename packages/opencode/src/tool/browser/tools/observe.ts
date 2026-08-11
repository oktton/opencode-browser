import z from "zod"
import { Tool } from "../../tool"
import { BrowserManager } from "../manager"

export const BrowserScreenshotTool = Tool.define("browser_screenshot", {
  description: "Take a screenshot of the current page and return it as an image attachment.",
  parameters: z.object({}),
  async execute(_params, ctx) {
    const manager = BrowserManager.getInstance()
    const tab = manager.getActiveTab()

    const buffer = await tab.page.screenshot()
    const base64 = buffer.toString("base64")

    return {
      title: "Screenshot",
      output: "Screenshot captured.",
      metadata: {},
      attachments: [
        {
          type: "file" as const,
          mime: "image/png",
          filename: "screenshot.png",
          url: `data:image/png;base64,${base64}`,
        },
      ],
    }
  },
})

export const BrowserViewElementsTool = Tool.define("browser_view_elements", {
  description: `Take a screenshot of visual elements (img/svg/table/etc.) and return the images for inspection.

Use when you need to see what a [view:ID] element looks like.
The IDs correspond to the [view:ID] markers in the DOM HTML output.`,
  parameters: z.object({
    viewIds: z.array(z.string()).describe('Array of view IDs (e.g., ["ife", "eehb"]) from [view:ID] markers.'),
  }),
  async execute(params, ctx) {
    const manager = BrowserManager.getInstance()
    const tab = manager.getActiveTab()
    const { domService } = tab

    if (params.viewIds.length === 0) {
      return {
        title: "View elements",
        output: "No viewIds provided.",
        metadata: {},
      }
    }

    const visualElementMap = domService.getLatestVisualElementMap()
    if (!visualElementMap || visualElementMap.size === 0) {
      return {
        title: "View elements",
        output: "No visual elements available. Please wait for the page to load.",
        metadata: {},
      }
    }

    return domService.withClient(async () => {
      const padding = 10
      const textParts: string[] = []
      const attachments: Array<{
        type: "file"
        mime: string
        filename: string
        url: string
      }> = []

      for (const id of params.viewIds) {
        const node = visualElementMap.get(id)
        if (!node) {
          textParts.push(`Visual element view:${id} not found in current DOM.`)
          continue
        }

        const tagName = node.nodeName.toLowerCase()
        const label = `view:${id} <${tagName}>`

        const rect = await domService.getElementRect(node)
        const clip = {
          x: Math.max(0, rect.x - padding),
          y: Math.max(0, rect.y - padding),
          width: rect.width + padding * 2,
          height: rect.height + padding * 2,
        }

        const base64 = await domService.captureClip(clip)
        textParts.push(`${label}: [see attachment]`)
        attachments.push({
          type: "file" as const,
          mime: "image/jpeg",
          filename: `view-${id}.jpg`,
          url: `data:image/jpeg;base64,${base64}`,
        })
      }

      return {
        title: `View ${params.viewIds.length} element(s)`,
        output: textParts.join("\n"),
        metadata: {},
        attachments,
      }
    })
  },
})
