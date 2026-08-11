import z from "zod"
import { Tool } from "../../tool"
import { BrowserManager } from "../manager"

export const BrowserWaitTool = Tool.define("browser_wait", {
  description: "Wait for a specified amount of time before continuing.",
  parameters: z.object({
    seconds: z.coerce.number().describe("Number of seconds to wait"),
  }),
  async execute(params, ctx) {
    BrowserManager.getInstance().ensureStarted()
    await new Promise((resolve) => setTimeout(resolve, params.seconds * 1000))
    return {
      title: `Wait ${params.seconds}s`,
      output: `Waited ${params.seconds} seconds`,
      metadata: {},
    }
  },
})
