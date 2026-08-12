import { Effect, Schema } from "effect"
import * as Tool from "../../tool"
import { BrowserManager } from "../manager"

export const BrowserWaitTool = Tool.define(
  "browser_wait",
  Effect.succeed({
    description: "Wait for a specified amount of time before continuing.",
    parameters: Schema.Struct({
      seconds: Schema.Number.annotate({ description: "Number of seconds to wait" }),
    }),
    execute: (params: { seconds: number }, ctx: Tool.Context) =>
      Effect.gen(function* () {
        BrowserManager.getInstance().ensureStarted()
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, params.seconds * 1000)))
        return {
          title: `Wait ${params.seconds}s`,
          output: `Waited ${params.seconds} seconds`,
          metadata: {},
        }
      }),
  }),
)
