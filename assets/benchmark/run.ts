#!/usr/bin/env bun

import { parseArgs } from "util"
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs"
import { join } from "path"

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    server: { type: "string", default: "http://localhost:4096" },
    data: { type: "string", default: join(import.meta.dir, "WebVoyager_data.json") },
    out: { type: "string", default: join(import.meta.dir, "results") },
    site: { type: "string" },
    start: { type: "string", default: "0" },
    count: { type: "string", default: "0" },
    timeout: { type: "string", default: "300000" },
    concurrency: { type: "string", default: "1" },
    model: { type: "string" },
    provider: { type: "string" },
    agent: { type: "string" },
    "run-id": { type: "string" },
    help: { type: "boolean", default: false },
  },
  strict: true,
})

if (flags.help) {
  console.log(`
WebVoyager Benchmark Runner for OpenCode Browser Tools

Usage:
  bun run assets/benchmark/run.ts [options]

Options:
  --server <url>       OpenCode server URL (default: http://localhost:4096)
  --data <path>        Path to WebVoyager_data.json
  --out <dir>          Output directory for results
  --site <domain>      Filter tasks by website domain (e.g. "allrecipes")
  --start <n>          Skip first n tasks (default: 0)
  --count <n>          Run only n tasks, 0 = all (default: 0)
  --timeout <ms>       Per-task timeout in ms (default: 300000)
  --concurrency <n>    Parallel tasks (default: 1)
  --model <id>         Model ID override
  --provider <id>      Provider ID override
  --agent <name>       Agent name override
  --run-id <id>        Custom run identifier
  --help               Show this help
`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Task {
  task_id: string
  confirmed_task: string
  website: string
}

interface ToolTraceEntry {
  tool: string
  input: unknown
  output_preview: string
  time_ms: number
}

interface TaskResult {
  task_id: string
  website: string
  task: string
  session_id: string
  status: "completed" | "error" | "timeout"
  duration_ms: number
  steps: number
  tokens: {
    cache_read: number
    cache_write: number
    input: number
    output: number
    reasoning: number
  }
  cost: number
  final_answer: string
  tool_trace: ToolTraceEntry[]
  error: string | null
  model: string | null
  provider: string | null
}

interface RunSummary {
  run_id: string
  model: string | null
  provider: string | null
  timestamp: string
  total_tasks: number
  completed: number
  errored: number
  timed_out: number
  avg_steps: number
  avg_duration_ms: number
  avg_tokens: {
    cache_read: number
    cache_write: number
    input: number
    output: number
    reasoning: number
  }
  total_cost: number
  per_site: Record<string, { total: number; completed: number; errored: number; timed_out: number }>
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVER = flags.server!
const DATA_PATH = flags.data!
const OUT_DIR = flags.out!
const SITE_FILTER = flags.site
const START = parseInt(flags.start!, 10)
const COUNT = parseInt(flags.count!, 10)
const TIMEOUT = parseInt(flags.timeout!, 10)
const CONCURRENCY = parseInt(flags.concurrency!, 10)
const MODEL = flags.model
const PROVIDER = flags.provider
const AGENT = flags.agent
const RUN_ID = flags["run-id"] ?? `run-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function api(path: string, options?: RequestInit & { timeout?: number }): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options?.timeout ?? 30000)
  try {
    const res = await fetch(`${SERVER}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`API ${path} returned ${res.status}: ${body}`)
    }
    return res
  } finally {
    clearTimeout(timer)
  }
}

async function abortSession(sessionId: string): Promise<void> {
  try {
    await fetch(`${SERVER}/session/${sessionId}/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
    })
    // Wait for the agent to actually stop before proceeding
    await new Promise((r) => setTimeout(r, 2000))
  } catch {
    // Best effort
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + "..."
}

function extractFinalAnswer(parts: any[]): string {
  const textParts = parts.filter((p: any) => p.type === "text")
  if (textParts.length === 0) return ""
  return textParts[textParts.length - 1].text ?? ""
}

function extractToolTrace(parts: any[]): ToolTraceEntry[] {
  return parts
    .filter((p: any) => p.type === "tool")
    .map((p: any) => ({
      tool: p.tool ?? p.state?.tool ?? "unknown",
      input: p.state?.input ?? null,
      output_preview: truncate(
        typeof p.state?.output === "string" ? p.state.output : JSON.stringify(p.state?.output ?? ""),
        300,
      ),
      time_ms: p.state?.time ? (p.state.time.completed ?? 0) - (p.state.time.created ?? 0) : 0,
    }))
}

// ---------------------------------------------------------------------------
// Core: run a single task
// ---------------------------------------------------------------------------

async function runTask(task: Task): Promise<TaskResult> {
  const start = Date.now()
  const result: TaskResult = {
    task_id: task.task_id,
    website: task.website,
    task: task.confirmed_task,
    session_id: "",
    status: "error",
    duration_ms: 0,
    steps: 0,
    tokens: { cache_read: 0, cache_write: 0, input: 0, output: 0, reasoning: 0 },
    cost: 0,
    final_answer: "",
    tool_trace: [],
    error: null,
    model: MODEL ?? null,
    provider: PROVIDER ?? null,
  }

  try {
    // 1. Create session
    const createBody: Record<string, unknown> = {
      title: `bench: ${task.task_id}`,
      metadata: { benchmark: "webvoyager", task_id: task.task_id },
      permission: [{ permission: "browser_*", pattern: "*", action: "allow" }],
    }
    if (MODEL && PROVIDER) {
      createBody.model = { id: MODEL, providerID: PROVIDER }
    }
    if (AGENT) {
      createBody.agent = AGENT
    }

    const sessionRes = await api("/session", {
      method: "POST",
      body: JSON.stringify(createBody),
    })
    const session = await sessionRes.json()
    result.session_id = session.id

    // 2. Send prompt (sync — blocks until agent finishes)
    const prompt = buildPrompt(task)
    const promptBody: Record<string, unknown> = {
      parts: [{ type: "text", text: prompt }],
    }
    if (MODEL && PROVIDER) {
      promptBody.model = { modelID: MODEL, providerID: PROVIDER }
    }

    const msgRes = await api(`/session/${session.id}/message`, {
      method: "POST",
      body: JSON.stringify(promptBody),
      timeout: TIMEOUT,
    })
    const message = await msgRes.json()

    // 3. Extract metrics from the response
    const info = message.info ?? message
    const parts = message.parts ?? []

    result.status = "completed"
    result.final_answer = extractFinalAnswer(parts)
    result.tool_trace = extractToolTrace(parts)
    result.steps = result.tool_trace.length

    if (info.tokens) {
      result.tokens = {
        cache_read: info.tokens.cache?.read ?? 0,
        cache_write: info.tokens.cache?.write ?? 0,
        input: info.tokens.input ?? 0,
        output: info.tokens.output ?? 0,
        reasoning: info.tokens.reasoning ?? 0,
      }
    }
    result.cost = info.cost ?? 0
    result.model = info.modelID ?? MODEL ?? null
    result.provider = info.providerID ?? PROVIDER ?? null

    if (info.error) {
      result.status = "error"
      result.error = typeof info.error === "string" ? info.error : JSON.stringify(info.error)
    }
  } catch (err: any) {
    if (err.name === "AbortError" || err.message?.includes("abort")) {
      result.status = "timeout"
      result.error = `Timed out after ${TIMEOUT}ms`
    } else {
      result.status = "error"
      result.error = err.message ?? String(err)
    }

    // Abort the server-side agent so it stops operating the browser
    if (result.session_id) {
      await abortSession(result.session_id)
    }
  }

  result.duration_ms = Date.now() - start

  // 4. Fetch all messages for full token accounting (session may have multiple rounds)
  if (result.session_id) {
    try {
      const allMsgRes = await api(`/session/${result.session_id}/message?limit=0`)
      const allMessages = await allMsgRes.json()
      const assistantMsgs = (Array.isArray(allMessages) ? allMessages : []).filter(
        (m: any) => m.info?.role === "assistant",
      )

      let totalTokens = { cache_read: 0, cache_write: 0, input: 0, output: 0, reasoning: 0 }
      let totalCost = 0
      let totalSteps = 0
      const fullTrace: ToolTraceEntry[] = []

      for (const msg of assistantMsgs) {
        const t = msg.info?.tokens
        if (t) {
          totalTokens.cache_read += t.cache?.read ?? 0
          totalTokens.cache_write += t.cache?.write ?? 0
          totalTokens.input += t.input ?? 0
          totalTokens.output += t.output ?? 0
          totalTokens.reasoning += t.reasoning ?? 0
        }
        totalCost += msg.info?.cost ?? 0
        const trace = extractToolTrace(msg.parts ?? [])
        totalSteps += trace.length
        fullTrace.push(...trace)
      }

      result.tokens = totalTokens
      result.cost = totalCost
      result.steps = totalSteps
      result.tool_trace = fullTrace

      // Update final answer from last assistant message
      if (assistantMsgs.length > 0) {
        const lastMsg = assistantMsgs[assistantMsgs.length - 1]
        const answer = extractFinalAnswer(lastMsg.parts ?? [])
        if (answer) result.final_answer = answer
      }
    } catch {
      // Non-critical — we already have per-message data
    }
  }

  return result
}

function buildPrompt(task: Task): string {
  return `You are being evaluated on a web browsing benchmark. Complete the following task using the browser tools.

Website: ${task.website}
Task: ${task.confirmed_task}

Instructions:
1. Navigate to the website and complete the task.
2. When you have found the answer, provide it clearly in your final response.
3. If you cannot complete the task, explain what went wrong.

Begin now.`
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  // Load tasks
  const raw = readFileSync(DATA_PATH, "utf-8")
  let tasks: Task[] = JSON.parse(raw)

  // Filter by site
  if (SITE_FILTER) {
    tasks = tasks.filter((t) => t.website.toLowerCase().includes(SITE_FILTER.toLowerCase()))
  }

  // Slice
  tasks = tasks.slice(START, COUNT > 0 ? START + COUNT : undefined)

  if (tasks.length === 0) {
    console.log("No tasks to run.")
    return
  }

  // Prepare output directory
  const runDir = join(OUT_DIR, RUN_ID)
  if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true })

  console.log(`\n=== WebVoyager Benchmark ===`)
  console.log(`Run ID:      ${RUN_ID}`)
  console.log(`Server:      ${SERVER}`)
  console.log(`Tasks:       ${tasks.length}`)
  console.log(`Concurrency: ${CONCURRENCY}`)
  console.log(`Timeout:     ${TIMEOUT}ms`)
  console.log(`Output:      ${runDir}`)
  console.log(``)

  // Check server health
  try {
    await api("/global/health", { timeout: 5000 })
  } catch {
    console.error("ERROR: Cannot reach OpenCode server at", SERVER)
    console.error("Start it with: bun dev serve")
    process.exit(1)
  }

  const results: TaskResult[] = []
  const ndjsonPath = join(runDir, "results.ndjson")
  let completed = 0

  // Run tasks with concurrency control
  const queue = [...tasks]
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const task = queue.shift()!
      const idx = tasks.indexOf(task)
      console.log(`[${completed + 1}/${tasks.length}] ${task.task_id} — ${truncate(task.confirmed_task, 60)}`)

      const result = await runTask(task)
      results.push(result)
      completed++

      // Append to NDJSON immediately (crash-safe)
      appendFileSync(ndjsonPath, JSON.stringify(result) + "\n")

      const icon = result.status === "completed" ? "OK" : result.status === "timeout" ? "TIMEOUT" : "ERR"
      console.log(
        `  [${icon}] ${result.steps} steps, ${result.duration_ms}ms, ` +
          `$${result.cost.toFixed(4)}, ` +
          `tokens: ${result.tokens.input}+${result.tokens.cache_read}cr+${result.tokens.cache_write}cw in / ${result.tokens.output} out`,
      )
      if (result.error) {
        console.log(`  Error: ${truncate(result.error, 100)}`)
      }
    }
  })

  await Promise.all(workers)

  // Write summary
  const summary = buildSummary(results)
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2))
  writeFileSync(join(runDir, "results.json"), JSON.stringify(results, null, 2))

  printSummary(summary)
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function buildSummary(results: TaskResult[]): RunSummary {
  const completed = results.filter((r) => r.status === "completed")
  const errored = results.filter((r) => r.status === "error")
  const timedOut = results.filter((r) => r.status === "timeout")

  const avg = (arr: number[]) => (arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length)

  const perSite: RunSummary["per_site"] = {}
  for (const r of results) {
    const domain = new URL(r.website).hostname
    if (!perSite[domain]) perSite[domain] = { total: 0, completed: 0, errored: 0, timed_out: 0 }
    perSite[domain].total++
    if (r.status === "completed") perSite[domain].completed++
    if (r.status === "error") perSite[domain].errored++
    if (r.status === "timeout") perSite[domain].timed_out++
  }

  return {
    run_id: RUN_ID,
    model: results[0]?.model ?? null,
    provider: results[0]?.provider ?? null,
    timestamp: new Date().toISOString(),
    total_tasks: results.length,
    completed: completed.length,
    errored: errored.length,
    timed_out: timedOut.length,
    avg_steps: Math.round(avg(results.map((r) => r.steps)) * 10) / 10,
    avg_duration_ms: Math.round(avg(results.map((r) => r.duration_ms))),
    avg_tokens: {
      cache_read: Math.round(avg(results.map((r) => r.tokens.cache_read))),
      cache_write: Math.round(avg(results.map((r) => r.tokens.cache_write))),
      input: Math.round(avg(results.map((r) => r.tokens.input))),
      output: Math.round(avg(results.map((r) => r.tokens.output))),
      reasoning: Math.round(avg(results.map((r) => r.tokens.reasoning))),
    },
    total_cost: results.reduce((sum, r) => sum + r.cost, 0),
    per_site: perSite,
  }
}

function printSummary(s: RunSummary) {
  console.log(`\n=== Summary ===`)
  console.log(`Run:        ${s.run_id}`)
  console.log(`Model:      ${s.provider}/${s.model}`)
  console.log(`Tasks:      ${s.total_tasks} (completed: ${s.completed}, error: ${s.errored}, timeout: ${s.timed_out})`)
  console.log(`Avg steps:  ${s.avg_steps}`)
  console.log(`Avg time:   ${(s.avg_duration_ms / 1000).toFixed(1)}s`)
  console.log(
    `Avg tokens: ${s.avg_tokens.input} input + ${s.avg_tokens.cache_read} cache_read + ${s.avg_tokens.cache_write} cache_write / ${s.avg_tokens.output} output / ${s.avg_tokens.reasoning} reasoning`,
  )
  console.log(`Total cost: $${s.total_cost.toFixed(4)}`)
  console.log(`\nPer site:`)
  for (const [domain, stats] of Object.entries(s.per_site).sort((a, b) => a[0].localeCompare(b[0]))) {
    const rate = stats.total > 0 ? ((stats.completed / stats.total) * 100).toFixed(0) : "0"
    console.log(`  ${domain.padEnd(30)} ${stats.completed}/${stats.total} (${rate}%)`)
  }
}

// ---------------------------------------------------------------------------

run().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
