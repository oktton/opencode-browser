#!/usr/bin/env bun

/**
 * LLM-as-Judge evaluator for WebVoyager benchmark results.
 *
 * Reads results.ndjson from a benchmark run and uses a separate LLM call
 * to judge whether each task was successfully completed.
 *
 * Usage:
 *   bun run assets/benchmark/judge.ts --run <run-id> [options]
 */

import { parseArgs } from "util"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"

const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    run: { type: "string" },
    dir: { type: "string", default: join(import.meta.dir, "results") },
    server: { type: "string", default: "http://localhost:4096" },
    model: { type: "string" },
    provider: { type: "string" },
    help: { type: "boolean", default: false },
  },
  strict: true,
})

if (flags.help || !flags.run) {
  console.log(`
LLM-as-Judge Evaluator

Usage:
  bun run assets/benchmark/judge.ts --run <run-id> [options]

Options:
  --run <id>           Run ID to evaluate (required)
  --dir <path>         Results directory (default: assets/benchmark/results)
  --server <url>       OpenCode server for judge LLM calls (default: http://localhost:4096)
  --model <id>         Judge model ID
  --provider <id>      Judge provider ID
  --help               Show this help
`)
  process.exit(0)
}

interface TaskResult {
  task_id: string
  website: string
  task: string
  session_id: string
  status: string
  final_answer: string
  tool_trace: { tool: string; input: unknown; output_preview: string }[]
  error: string | null
  [key: string]: unknown
}

interface JudgeResult {
  task_id: string
  pass: boolean
  reason: string
  confidence: "high" | "medium" | "low"
}

async function judge(task: TaskResult): Promise<JudgeResult> {
  if (task.status !== "completed" || !task.final_answer) {
    return {
      task_id: task.task_id,
      pass: false,
      reason: task.status === "timeout" ? "Task timed out" : task.error ?? "No answer produced",
      confidence: "high",
    }
  }

  const toolSummary = task.tool_trace
    .map((t) => `- ${t.tool}(${JSON.stringify(t.input).slice(0, 100)})`)
    .join("\n")

  const prompt = `You are evaluating whether an AI agent successfully completed a web browsing task.

## Task
Website: ${task.website}
Instruction: ${task.task}

## Agent's Tool Usage (summary)
${toolSummary || "(no tools used)"}

## Agent's Final Answer
${task.final_answer.slice(0, 3000)}

## Evaluation Criteria
Judge whether the agent's final answer satisfactorily addresses the task requirements.
- The answer must contain the specific information requested.
- Minor formatting differences are acceptable.
- If the task asks for a recipe with certain criteria, the answer must reference a recipe that plausibly meets those criteria.
- If the task asks to "find" something, the agent must have found and reported it.

## Response Format
Respond with EXACTLY one JSON object (no markdown, no extra text):
{"pass": true/false, "reason": "brief explanation", "confidence": "high/medium/low"}`

  try {
    // Create a one-off session for judging
    const createBody: Record<string, unknown> = { title: `judge: ${task.task_id}` }
    if (flags.model && flags.provider) {
      createBody.model = { id: flags.model, providerID: flags.provider }
    }

    const sessionRes = await fetch(`${flags.server}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBody),
    })
    const session = await sessionRes.json()

    const promptBody: Record<string, unknown> = {
      parts: [{ type: "text", text: prompt }],
      noReply: false,
    }
    if (flags.model && flags.provider) {
      promptBody.model = { modelID: flags.model, providerID: flags.provider }
    }

    const msgRes = await fetch(`${flags.server}/session/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(promptBody),
      signal: AbortSignal.timeout(60000),
    })
    const message = await msgRes.json()

    const parts = message.parts ?? []
    const textParts = parts.filter((p: any) => p.type === "text")
    const rawText = textParts.map((p: any) => p.text ?? "").join("")

    // Extract JSON from response
    const jsonMatch = rawText.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        task_id: task.task_id,
        pass: !!parsed.pass,
        reason: parsed.reason ?? "",
        confidence: parsed.confidence ?? "medium",
      }
    }

    return { task_id: task.task_id, pass: false, reason: "Judge response not parseable", confidence: "low" }
  } catch (err: any) {
    return { task_id: task.task_id, pass: false, reason: `Judge error: ${err.message}`, confidence: "low" }
  }
}

async function main() {
  const runDir = join(flags.dir!, flags.run!)
  const ndjsonPath = join(runDir, "results.ndjson")

  if (!existsSync(ndjsonPath)) {
    console.error(`results.ndjson not found at ${ndjsonPath}`)
    process.exit(1)
  }

  const lines = readFileSync(ndjsonPath, "utf-8").trim().split("\n")
  const results: TaskResult[] = lines.map((l) => JSON.parse(l))

  console.log(`Judging ${results.length} results from run ${flags.run}...\n`)

  const judgeResults: JudgeResult[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    process.stdout.write(`[${i + 1}/${results.length}] ${r.task_id}... `)
    const jr = await judge(r)
    judgeResults.push(jr)
    console.log(jr.pass ? "PASS" : "FAIL", `(${jr.confidence}) — ${jr.reason}`)
  }

  // Merge judge results back
  const merged = results.map((r) => ({
    ...r,
    judge_result: judgeResults.find((j) => j.task_id === r.task_id) ?? null,
  }))

  writeFileSync(join(runDir, "judged.json"), JSON.stringify(merged, null, 2))

  // Update summary with success rate
  const summaryPath = join(runDir, "summary.json")
  if (existsSync(summaryPath)) {
    const summary = JSON.parse(readFileSync(summaryPath, "utf-8"))
    const passed = judgeResults.filter((j) => j.pass).length
    summary.success_rate = results.length > 0 ? passed / results.length : 0
    summary.passed = passed
    summary.failed = results.length - passed
    summary.judge_model = flags.model ?? summary.model
    summary.judge_provider = flags.provider ?? summary.provider

    // Per-site success rate
    for (const [domain, stats] of Object.entries(summary.per_site as Record<string, any>)) {
      const siteResults = merged.filter((r) => new URL(r.website).hostname === domain)
      const sitePassed = siteResults.filter((r) => r.judge_result?.pass).length
      stats.passed = sitePassed
      stats.success_rate = siteResults.length > 0 ? sitePassed / siteResults.length : 0
    }

    writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
  }

  // Print summary
  const passed = judgeResults.filter((j) => j.pass).length
  console.log(`\n=== Judge Summary ===`)
  console.log(`Passed:  ${passed}/${results.length} (${((passed / results.length) * 100).toFixed(1)}%)`)
  console.log(`High confidence: ${judgeResults.filter((j) => j.confidence === "high").length}`)
  console.log(`Medium:          ${judgeResults.filter((j) => j.confidence === "medium").length}`)
  console.log(`Low:             ${judgeResults.filter((j) => j.confidence === "low").length}`)
  console.log(`\nResults saved to ${join(runDir, "judged.json")}`)
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
