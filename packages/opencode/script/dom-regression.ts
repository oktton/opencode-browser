#!/usr/bin/env bun
/**
 * DOM Extraction Regression Harness
 *
 * Proves that refactors to the DOM pipeline (builder → render-info → prune →
 * highlight-index → serializer) do not change the extracted DOM.
 *
 * The pipeline talks to the page only through CDPClient.sendCommand, so a
 * capture run records every CDP request/response into a "tape". Verification
 * then replays that tape with no browser at all: identical inputs, so any
 * output difference is a real behaviour change rather than page flakiness
 * (ads, A/B tests, animations, timing).
 *
 *   bun packages/opencode/script/dom-regression.ts capture [name...]
 *   bun packages/opencode/script/dom-regression.ts verify  [name...]
 *   bun packages/opencode/script/dom-regression.ts bless   [name...]
 *   bun packages/opencode/script/dom-regression.ts list
 *
 * capture  launches Chrome (visible), loads each page, records the tape and
 *          writes the golden output.
 * verify   replays each tape offline and diffs against the golden. This is the
 *          check to run before/after a refactor. It also reports per-stage CPU
 *          time — with CDP served from memory, those numbers are pure pipeline
 *          cost, which makes it a usable benchmark for the O(N^2) hot spots.
 * bless    re-renders from the existing tapes and overwrites the goldens.
 *          Use only when an output change is intended and reviewed.
 *
 * Fixtures live in assets/browser-regression/fixtures.json (override with
 * --fixtures <file>). Tapes and goldens are written next to it.
 */

import * as fs from "fs"
import * as path from "path"
import { pathToFileURL } from "url"
import { CDPClient } from "../src/tool/browser/cdp/client"
import { CDPCommands } from "../src/tool/browser/cdp/commands"
import { OOPIFManager } from "../src/tool/browser/cdp/oopif-manager"
import { CDPTape } from "../src/tool/browser/cdp/tape"
import { CDPStats } from "../src/tool/browser/cdp/stats"
import { findChromePath } from "../src/tool/browser/cdp/chrome-path"
import { DOMTreeBuilder } from "../src/tool/browser/dom/tree/builder"
import { computeRenderInfo } from "../src/tool/browser/dom/tree/render-info"
import { pruneTree } from "../src/tool/browser/dom/tree/pruner"
import { assignAndHighlight } from "../src/tool/browser/dom/tree/highlight"
import { renderToHtml } from "../src/tool/browser/dom/serializer/renderer"
import { copyDomTree, buildNodeKeyLookup } from "../src/tool/browser/dom/utils/index"
import { REQUIRED_COMPUTED_STYLES } from "../src/tool/browser/dom/types/snapshot"
import type { EnhancedDOMTreeNode } from "../src/tool/browser/dom/types/dom-node"

const ROOT = path.resolve(import.meta.dir, "../../..")
const DEFAULT_DIR = path.join(ROOT, "assets", "browser-regression")

/** Viewport expansion used by the real tool (getPageDom passes 0.8) */
const EXPAND = 0.8

interface Fixture {
  name: string
  /** Absolute URL, or use `file` for a page kept next to the fixtures */
  url?: string
  /** Path relative to the fixtures directory, loaded over file:// */
  file?: string
  /** Extra settle time in ms after load — heavy SPAs need more */
  wait?: number
  /** Scroll down this many viewports before extracting */
  scroll?: number
}

function fixtureUrl(fixture: Fixture, dir: string): string {
  if (fixture.file) return pathToFileURL(path.join(dir, fixture.file)).href
  if (!fixture.url) throw new Error(`fixture ${fixture.name} has neither url nor file`)
  return fixture.url
}

const BUILTIN_FIXTURES: Fixture[] = [
  { name: "wikipedia-js", url: "https://en.wikipedia.org/wiki/JavaScript", wait: 1500 },
  { name: "mdn-element", url: "https://developer.mozilla.org/en-US/docs/Web/API/Element", wait: 2000 },
  { name: "github-repo", url: "https://github.com/oven-sh/bun", wait: 2500 },
  { name: "hn-front", url: "https://news.ycombinator.com", wait: 800 },
  { name: "youtube-home", url: "https://www.youtube.com", wait: 4000 },
  { name: "bing-search", url: "https://www.bing.com/search?q=puppeteer+cdp", wait: 2500 },
]

// --- pipeline ------------------------------------------------------------

interface Stages {
  trees: number
  build: number
  renderInfo: number
  copy: number
  prune: number
  assign: number
  serialize: number
  total: number
}

interface Extraction {
  html: string
  stats: { nodes: number; candidates: number; topElements: number }
  stages: Stages
}

function countTree(root: EnhancedDOMTreeNode) {
  let nodes = 0
  let candidates = 0
  let topElements = 0
  const visit = (n: EnhancedDOMTreeNode) => {
    nodes++
    if (n.renderInfo?.isCandidate) candidates++
    if (n.renderInfo?.isTopElement) topElements++
    for (const c of n.childrenNodes ?? []) visit(c)
    for (const s of n.shadowRoots ?? []) visit(s)
    if (n.contentDocument) visit(n.contentDocument)
  }
  visit(root)
  return { nodes, candidates, topElements }
}

/**
 * Run the extraction pipeline against a CDPClient.
 *
 * Mirrors DomService.extractCurrentDomTree + renderDomTree, minus the settle
 * monitor and puppeteer Page (neither is replayable, and neither affects the
 * shape of the extracted tree once the page is already loaded).
 *
 * highlight is always false: drawing overlays mutates the live page, which
 * would make a capture depend on whether a previous capture ran.
 */
async function extract(client: CDPClient): Promise<Extraction> {
  const t0 = Date.now()
  const commands = new CDPCommands(client)
  const oopif = new OOPIFManager()

  await oopif.discoverOOPIFs(client)
  await commands.injectSelectValues()
  await commands.injectInputValues()
  const trees = await commands.getAllTrees({ oopifManager: oopif })
  const tTrees = Date.now()

  const { root } = new DOMTreeBuilder(trees).build()
  const tBuild = Date.now()

  await computeRenderInfo(root, client, { expand: EXPAND }, oopif)
  const tRenderInfo = Date.now()

  const copy = copyDomTree(root)
  const lookup = buildNodeKeyLookup(root)
  const tCopy = Date.now()

  pruneTree(copy, lookup)
  const tPrune = Date.now()

  await assignAndHighlight(copy, client, oopif, lookup, { highlight: false })
  const tAssign = Date.now()

  const html = renderToHtml(copy, 0, lookup, new Map(), {})
  const tEnd = Date.now()

  return {
    html,
    stats: countTree(root),
    stages: {
      trees: tTrees - t0,
      build: tBuild - tTrees,
      renderInfo: tRenderInfo - tBuild,
      copy: tCopy - tRenderInfo,
      prune: tPrune - tCopy,
      assign: tAssign - tPrune,
      serialize: tEnd - tAssign,
      total: tEnd - t0,
    },
  }
}

// --- replay --------------------------------------------------------------

/** Minimal CDPSession stand-in — replay never sends anything. */
function stubSession() {
  return {
    on() {},
    off() {},
    once() {},
    removeListener() {},
    send() {
      throw new Error("[dom-regression] replay must not touch the CDP socket")
    },
  } as never
}

/**
 * Replay a tape `repeat` times. The HTML must be identical every run (it is
 * the same frozen input); timings are reported as the minimum across runs,
 * which is far more stable than a single run under GC noise.
 */
async function replay(
  tapePath: string,
  repeat: number,
): Promise<{ result: Extraction; misses: string[]; unstable: boolean }> {
  const tape = CDPTape.load(tapePath)
  const client = new CDPClient(stubSession())
  client.setTape(tape, "replay")

  let best: Extraction | undefined
  let unstable = false
  for (let i = 0; i < repeat; i++) {
    tape.reset()
    const run = await extract(client)
    if (!best) best = run
    else {
      if (run.html !== best.html) unstable = true
      for (const k of Object.keys(run.stages) as (keyof Stages)[]) {
        best.stages[k] = Math.min(best.stages[k], run.stages[k])
      }
    }
  }
  return { result: best!, misses: tape.misses(), unstable }
}

// --- capture -------------------------------------------------------------

function medianStages(runs: Stages[]): Stages {
  const pick = (k: keyof Stages) => {
    const sorted = runs.map((r) => r[k]).sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]!
  }
  return {
    trees: pick("trees"),
    build: pick("build"),
    renderInfo: pick("renderInfo"),
    copy: pick("copy"),
    prune: pick("prune"),
    assign: pick("assign"),
    serialize: pick("serialize"),
    total: pick("total"),
  }
}

async function capture(
  fixtures: Fixture[],
  dir: string,
  headless: boolean,
  repeat: number,
  cdpDetail: boolean,
) {
  const puppeteer = await import("puppeteer-core")
  const browser = await puppeteer.default.launch({
    executablePath: findChromePath(),
    // The real tool runs headful; capture headful too unless asked otherwise,
    // so layout and hit-testing match what the agent actually sees.
    headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
    defaultViewport: { width: 1280, height: 900 },
  })

  fs.mkdirSync(path.join(dir, "tapes"), { recursive: true })
  fs.mkdirSync(path.join(dir, "golden"), { recursive: true })

  try {
    for (const fixture of fixtures) {
      process.stdout.write(`capture ${fixture.name} … `)
      const page = await browser.newPage()
      try {
        await page.goto(fixtureUrl(fixture, dir), { waitUntil: "networkidle2", timeout: 60000 })
        await new Promise((r) => setTimeout(r, fixture.wait ?? 1500))
        if (fixture.scroll) {
          await page.evaluate((n) => window.scrollBy(0, window.innerHeight * n), fixture.scroll)
          await new Promise((r) => setTimeout(r, 1200))
        }

        const session = await page.createCDPSession()
        const client = new CDPClient(session)

        // Repeats run against the same loaded page, which is what the agent
        // actually does (many actions, one navigation). Both hit-test paths are
        // timed here, interleaved on identical page state — the only fair way
        // to compare them, since replay serves CDP from memory and hides the
        // entire cost being measured.
        const runs: Stages[] = []
        const stats = new CDPStats()
        for (let i = 0; i < repeat; i++) {
          stats.reset()
          client.setStats(stats)
          runs.push((await extract(client)).stages)
          client.setStats(null)
        }

        const tape = new CDPTape()
        tape.url = page.url()
        tape.capturedAt = new Date().toISOString()
        client.setTape(tape, "record")

        // Tape every strategy against the same page state so the swap can be
        // diffed offline. The golden comes from the first one listed.
        const result = await extract(client)

        tape.save(path.join(dir, "tapes", `${fixture.name}.json.gz`))
        fs.writeFileSync(path.join(dir, "golden", `${fixture.name}.txt`), result.html, "utf8")
        fs.writeFileSync(
          path.join(dir, "golden", `${fixture.name}.meta.json`),
          JSON.stringify({ url: tape.url, capturedAt: tape.capturedAt, ...result.stats }, null, 2),
          "utf8",
        )

        const size = fs.statSync(path.join(dir, "tapes", `${fixture.name}.json.gz`)).size
        console.log(
          `${result.stats.nodes} nodes, ${result.stats.candidates} candidates, ` +
            `${result.html.split("\n").length} lines, tape ${(size / 1024 / 1024).toFixed(1)}MB`,
        )
        // Live timings: unlike verify, these include real CDP round trips
        const s = medianStages(runs)
        console.log(
          `    live (median of ${runs.length}): trees ${s.trees}ms  build ${s.build}ms  ` +
            `renderInfo ${s.renderInfo}ms  copy ${s.copy}ms  prune ${s.prune}ms  = ${s.total}ms` +
            `   (${stats.totalCalls} CDP calls)`,
        )
        if (cdpDetail) {
          for (const row of stats.rows()) {
            console.log(
              `      ${row.method.padEnd(32)} ${String(row.count).padStart(5)} calls  ${row.ms.toFixed(0).padStart(7)}ms summed`,
            )
          }
        }
      } catch (error) {
        console.log(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        await page.close().catch(() => {})
      }
    }
  } finally {
    await browser.close()
  }
}

// --- verify --------------------------------------------------------------

function firstDiff(a: string, b: string): string {
  const left = a.split("\n")
  const right = b.split("\n")
  let i = 0
  while (i < left.length && i < right.length && left[i] === right[i]) i++
  const from = Math.max(0, i - 3)
  const out: string[] = []
  for (let n = from; n < i; n++) out.push(`  ${n + 1}| ${left[n]}`)
  out.push(`- ${i + 1}| ${left[i] ?? "<eof>"}`)
  out.push(`+ ${i + 1}| ${right[i] ?? "<eof>"}`)
  let shown = 0
  for (let n = i + 1; n < Math.max(left.length, right.length) && shown < 3; n++, shown++) {
    if (left[n] !== right[n]) {
      out.push(`- ${n + 1}| ${left[n] ?? "<eof>"}`)
      out.push(`+ ${n + 1}| ${right[n] ?? "<eof>"}`)
    }
  }
  const total = Math.abs(left.length - right.length)
  if (total) out.push(`  (line count ${left.length} → ${right.length})`)
  return out.join("\n")
}

async function verify(fixtures: Fixture[], dir: string, bless: boolean, repeat: number) {
  let failed = 0
  let ran = 0

  for (const fixture of fixtures) {
    const tapePath = path.join(dir, "tapes", `${fixture.name}.json.gz`)
    const goldenPath = path.join(dir, "golden", `${fixture.name}.txt`)
    if (!fs.existsSync(tapePath)) {
      console.log(`SKIP  ${fixture.name} — no tape (run capture first)`)
      continue
    }
    ran++

    const { result, misses, unstable } = await replay(tapePath, repeat)
    if (unstable) {
      console.log(`ERROR ${fixture.name} — replaying the same tape gave different output;`)
      console.log(`        the pipeline is not deterministic for a fixed input`)
      failed++
      continue
    }
    const s = result.stages
    const timing =
      `build ${s.build}ms  renderInfo ${s.renderInfo}ms  copy ${s.copy}ms  ` +
      `prune ${s.prune}ms  assign ${s.assign}ms  serialize ${s.serialize}ms`

    if (misses.length > 0) {
      console.log(`ERROR ${fixture.name} — ${misses.length} un-recorded CDP calls, e.g.:`)
      for (const m of misses.slice(0, 3)) console.log(`        ${m.slice(0, 160)}`)
      console.log(`        the pipeline now issues CDP commands the tape does not cover; re-capture`)
      failed++
      continue
    }

    if (bless) {
      fs.writeFileSync(goldenPath, result.html, "utf8")
      console.log(`BLESS ${fixture.name}  ${result.html.split("\n").length} lines  (${timing})`)
      continue
    }

    if (!fs.existsSync(goldenPath)) {
      console.log(`SKIP  ${fixture.name} — no golden`)
      continue
    }

    const golden = fs.readFileSync(goldenPath, "utf8")
    if (golden === result.html) {
      console.log(`PASS  ${fixture.name}  ${result.stats.nodes} nodes  (${timing})`)
    } else {
      failed++
      console.log(`FAIL  ${fixture.name}  (${timing})`)
      console.log(firstDiff(golden, result.html))
      const actualPath = path.join(dir, "golden", `${fixture.name}.actual.txt`)
      fs.writeFileSync(actualPath, result.html, "utf8")
      console.log(`      full output written to ${path.relative(ROOT, actualPath)}`)
    }
  }

  console.log(`\n${ran - failed}/${ran} passed`)
  if (failed > 0) process.exit(1)
}

// --- ablation ------------------------------------------------------------

/**
 * What does the pipeline actually need out of the CDP payload?
 *
 * Each variant strips one thing out of the recorded response before the
 * pipeline sees it — the same result as never having asked the browser for it.
 * A variant whose output is unchanged is data we are paying to generate and
 * transfer for nothing.
 *
 * Note this measures OUTPUT impact only. The time saved by not requesting the
 * data cannot be seen in replay (CDP is served from memory); that needs a live
 * capture.
 */
const SNAPSHOT = "DOMSnapshot.captureSnapshot"
const AX_TREE = "Accessibility.getFullAXTree"

type Doc = { layout?: Record<string, unknown> }

function eachDoc(value: unknown, fn: (layout: Record<string, unknown>) => void): unknown {
  const docs = (value as { documents?: Doc[] })?.documents
  for (const doc of docs ?? []) if (doc.layout) fn(doc.layout)
  return value
}

/** Blank one computed style, keeping the positional mapping intact. */
function blankStyle(tape: CDPTape, index: number) {
  tape.mapResults(SNAPSHOT, (v) =>
    eachDoc(v, (layout) => {
      const styles = layout.styles as number[][] | undefined
      for (const row of styles ?? []) if (index < row.length) row[index] = -1
    }),
  )
}

function dropLayoutField(tape: CDPTape, ...fields: string[]) {
  tape.mapResults(SNAPSHOT, (v) =>
    eachDoc(v, (layout) => {
      for (const f of fields) delete layout[f]
    }),
  )
}

const ABLATIONS: { name: string; apply: (t: CDPTape) => void }[] = [
  ...REQUIRED_COMPUTED_STYLES.map((style, i) => ({
    name: `style:${style}`,
    apply: (t: CDPTape) => blankStyle(t, i),
  })),
  {
    name: "all-styles",
    apply: (t) => REQUIRED_COMPUTED_STYLES.forEach((_, i) => blankStyle(t, i)),
  },
  { name: "no-clientRects", apply: (t) => dropLayoutField(t, "clientRects") },
  { name: "no-scrollRects", apply: (t) => dropLayoutField(t, "scrollRects") },
  { name: "no-paintOrders", apply: (t) => dropLayoutField(t, "paintOrders") },
  { name: "no-stackingContexts", apply: (t) => dropLayoutField(t, "stackingContexts") },
  { name: "no-bounds", apply: (t) => dropLayoutField(t, "bounds") },
  { name: "no-ax-tree", apply: (t) => t.mapResults(AX_TREE, () => ({ nodes: [] })) },
]

/** Share of the trees payload each field accounts for, as recorded. */
function payloadShare(tape: CDPTape): string[] {
  let snapshotBytes = 0
  const field = new Map<string, number>()
  let axBytes = 0

  tape.mapResults(SNAPSHOT, (v) => {
    snapshotBytes += JSON.stringify(v).length
    eachDoc(v, (layout) => {
      for (const f of ["styles", "bounds", "clientRects", "scrollRects", "paintOrders", "stackingContexts"]) {
        if (layout[f] === undefined) continue
        field.set(f, (field.get(f) ?? 0) + JSON.stringify(layout[f]).length)
      }
    })
    return v
  })
  tape.mapResults(AX_TREE, (v) => {
    axBytes += JSON.stringify(v).length
    return v
  })

  const total = snapshotBytes + axBytes
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`
  const rows = [...field].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${pct(n)}`)
  rows.push(`ax-tree ${pct(axBytes)}`)
  return [`payload ${(total / 1024 / 1024).toFixed(1)}MB raw JSON: ${rows.join("  ")}`]
}

function marks(html: string): number {
  return (html.match(/[[<]\d+[\]>]/g) ?? []).length
}

function diffLines(a: string, b: string): number {
  const left = a.split("\n")
  const right = b.split("\n")
  let n = Math.abs(left.length - right.length)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) n++
  }
  return n
}

async function ablate(fixtures: Fixture[], dir: string) {
  for (const fixture of fixtures) {
    const tapePath = path.join(dir, "tapes", `${fixture.name}.json.gz`)
    const goldenPath = path.join(dir, "golden", `${fixture.name}.txt`)
    if (!fs.existsSync(tapePath) || !fs.existsSync(goldenPath)) {
      console.log(`SKIP ${fixture.name}`)
      continue
    }
    const golden = fs.readFileSync(goldenPath, "utf8")
    const goldenMarks = marks(golden)

    console.log(`\n${fixture.name}  (${golden.split("\n").length} lines, ${goldenMarks} element markers)`)
    for (const line of payloadShare(CDPTape.load(tapePath))) console.log(`  ${line}`)
    console.log(`  ${"variant".padEnd(24)} ${"lines".padStart(6)} ${"markers".padStart(8)}  changed`)

    for (const variant of ABLATIONS) {
      const tape = CDPTape.load(tapePath)
      variant.apply(tape)
      const client = new CDPClient(stubSession())
      client.setTape(tape, "replay")
      let out: string
      try {
        out = (await extract(client)).html
      } catch (error) {
        console.log(`  ${variant.name.padEnd(24)} ${"—".padStart(6)} ${"—".padStart(8)}  THREW: ${error instanceof Error ? error.message.slice(0, 60) : error}`)
        continue
      }
      const changed = diffLines(golden, out)
      const flag = changed === 0 ? "identical" : `${changed} lines`
      console.log(
        `  ${variant.name.padEnd(24)} ${String(out.split("\n").length).padStart(6)} ${String(marks(out)).padStart(8)}  ${flag}`,
      )
    }
  }
}

// --- cli -----------------------------------------------------------------

function loadFixtures(dir: string, override?: string): Fixture[] {
  const file = override ?? path.join(dir, "fixtures.json")
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"))
  return BUILTIN_FIXTURES
}

const argv = process.argv.slice(2)
const command = argv[0] ?? "verify"
const fixturesFlag = argv.indexOf("--fixtures")
const dirFlag = argv.indexOf("--dir")
const dir = dirFlag !== -1 ? path.resolve(argv[dirFlag + 1]!) : DEFAULT_DIR

const repeatFlag = argv.indexOf("--repeat")
const repeat = repeatFlag !== -1 ? Math.max(1, Number(argv[repeatFlag + 1])) : 1
const flagsWithValue = new Set(["--fixtures", "--dir", "--repeat"])
const names = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !flagsWithValue.has(all[i - 1] ?? ""))

const all = loadFixtures(dir, fixturesFlag !== -1 ? argv[fixturesFlag + 1] : undefined)
const selected = names.length > 0 ? all.filter((f) => names.includes(f.name)) : all

if (selected.length === 0 && command !== "list") {
  console.error(`no fixtures matched: ${names.join(", ")}`)
  process.exit(1)
}

if (command === "list") {
  for (const f of all) {
    const has = fs.existsSync(path.join(dir, "tapes", `${f.name}.json.gz`))
    console.log(`${has ? "[taped]" : "[     ]"} ${f.name.padEnd(20)} ${fixtureUrl(f, dir)}`)
  }
} else if (command === "capture") {
  await capture(selected, dir, argv.includes("--headless"), repeat, argv.includes("--cdp-detail"))
} else if (command === "verify") {
  await verify(selected, dir, false, repeat)
} else if (command === "bless") {
  await verify(selected, dir, true, 1)
} else if (command === "ablate") {
  await ablate(selected, dir)
} else {
  console.error(`unknown command: ${command}`)
  console.error(`usage: dom-regression.ts <capture|verify|bless|list> [name...] [--fixtures f.json] [--dir d]`)
  process.exit(1)
}
