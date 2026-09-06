import puppeteer from "puppeteer-core"
import { PAGE_TOOLS_SCRIPT } from "./src/tool/browser/page-tools"

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

// seed = text a model would pass to __find (a known item on the page). expect = ground truth count.
const SITES: { url: string; kind: string; seed?: string; truth?: string }[] = [
  { url: "https://news.ycombinator.com/", kind: "table rows, half unclassed", truth: "tr.athing" },
  { url: "https://quotes.toscrape.com/", kind: "semantic cards + microdata", seed: "The world as we have created it", truth: ".quote" },
  { url: "https://books.toscrape.com/", kind: "product grid (li)", seed: "A Light in the Attic", truth: "article.product_pod" },
  { url: "https://www.scrapethissite.com/pages/simple/", kind: "country divs", seed: "Andorra", truth: ".country" },
  { url: "https://www.scrapethissite.com/pages/forms/", kind: "data table rows", seed: "Boston Bruins", truth: "table.table tr.team" },
  { url: "https://en.wikipedia.org/wiki/List_of_largest_cities", kind: "wiki sortable table", seed: "Tokyo" },
  { url: "https://developer.mozilla.org/en-US/docs/Web/API", kind: "docs index list", seed: "AbortController" },
  { url: "https://webscraper.io/test-sites/e-commerce/allinone", kind: "bootstrap cards (2)", seed: "Asus AsusPro", truth: ".thumbnail" },
  { url: "https://github.com/trending", kind: "repo list, deep nesting" },
  { url: "https://www.bbc.com/news", kind: "news cards, heavy nesting" },
  { url: "https://text.npr.org/", kind: "minimal semantic html" },
  { url: "https://www.allrecipes.com/recipe/23600/worlds-best-lasagna/", kind: "recipe detail, ld+json" },
  { url: "https://www.allrecipes.com/search?q=lasagna", kind: "recipe listing" },
  { url: "https://www.apple.com/shop/buy-mac/macbook-pro", kind: "apple config page" },
  { url: "https://stackoverflow.com/questions", kind: "question list" },
  { url: "https://pypi.org/search/?q=http", kind: "package search results" },
  { url: "https://www.ebay.com/sch/i.html?_nkw=keyboard", kind: "marketplace listing" },
  { url: "https://www.reddit.com/r/programming/", kind: "web components" },
]

const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
})

const rows: any[] = []

for (const site of SITES) {
  const page = await browser.newPage()
  await page.setUserAgent(UA)
  const ok = await page
    .goto(site.url, { waitUntil: "domcontentloaded", timeout: 30000 })
    .then(() => true)
    .catch(() => false)
  if (!ok) {
    rows.push({ ...site, status: "NAV_FAIL" })
    console.log(`✗ NAV_FAIL  ${site.url}`)
    await page.close()
    continue
  }
  await new Promise((r) => setTimeout(r, 3000))

  const res: any = await page
    .evaluate(PAGE_TOOLS_SCRIPT)
    .then(() =>
      page.evaluate((cfg: any) => {
        const seed = cfg.seed, truth = cfg.truth
        const w = window as any
        const out: any = {}
        out.title = document.title.slice(0, 50)
        out.bodyLen = (document.body.innerText || "").length

        if (truth) out.want = document.querySelectorAll(truth).length
        const all = w.__data()
        out.dataTypes = all.map((d: any) => String(d["@type"])).slice(0, 5)
        out.dataBytes = JSON.stringify(all).length
        out.dataOverCap = out.dataBytes > 8192

        // Anchor the way a model would: __find a known item. Otherwise fall back to the
        // repeated link position with the most *text* (content lists, not nav).
        let anchor: Element | null = null
        if (seed) anchor = w.__find(seed)
        if (!anchor || (Array.isArray(anchor) && !anchor.length)) {
          const links = Array.from(document.querySelectorAll("a")).filter((a) => {
            const t = (a.textContent || "").trim()
            return t.length > 8 && t.length < 140 && (a as HTMLElement).offsetParent !== null
          })
          const byPath: Record<string, Element[]> = {}
          for (const a of links.slice(0, 800)) {
            const p = w.__path(a)
            ;(byPath[p] = byPath[p] || []).push(a)
          }
          const scored = Object.values(byPath)
            .filter((g) => g.length >= 2)
            .map((g) => {
              const avg = g.reduce((s, e) => s + (e.textContent || "").trim().length, 0) / g.length
              return { g, avg, score: g.length * avg }
            })
            .filter((x) => x.avg > 14)
            .sort((a, b) => b.score - a.score)
          anchor = scored.length ? scored[0].g[0] : null
          out.autoAnchor = true
        }
        if (!anchor) return { ...out, status: "NO_ANCHOR" }
        out.anchor = ((Array.isArray(anchor) ? anchor[0] : anchor).textContent || "").replace(/\s+/g, " ").trim().slice(0, 42)

        const t1 = performance.now()
        const recs = w.__records(anchor)
        out.msRecords = Math.round(performance.now() - t1)
        out.count = recs.length
        if (!recs.length) return { ...out, status: "NO_RECORDS" }

        out.tag = recs[0].tagName + "." + (recs[0].getAttribute("class") || "-").split(/\s+/)[0].slice(0, 20)
        out.homogeneous = recs.every((r: any) => r.tagName === recs[0].tagName)
        out.disjoint = !recs.some((a: any, i: number) => recs.some((b: any, j: number) => i !== j && a.contains(b)))
        const texts = recs.map((r: any) => (r.textContent || "").replace(/\s+/g, " ").trim())
        out.distinctPct = Math.round((new Set(texts).size / texts.length) * 100)

        // stability: anchoring on a different member of the SAME group must agree
        const a0 = Array.isArray(anchor) ? anchor[0] : anchor
        const aPath = w.__path(a0)
        const mid = recs[Math.floor(recs.length / 2)]
        let alt: any = null
        const cand = mid.getElementsByTagName(a0.tagName)
        for (let i = 0; i < cand.length && !alt; i++) if (w.__path(cand[i]) === aPath) alt = cand[i]
        out.stable = alt ? w.__records(alt).length === w.__records(a0).length : null

        const t2 = performance.now()
        out.blind = w.__recordsBlind().length
        out.msBlind = Math.round(performance.now() - t2)
        out.skelBytes = w.__skeleton(recs[0], 3).length
        out.skelSample = w.__skeleton(recs[0], 3).split("\n").slice(0, 6).join("\n")
        return { ...out, status: "OK" }
      }, { seed: site.seed ?? null, truth: site.truth ?? null }),
    )
    .catch((e: any) => ({ status: "EVAL_FAIL", err: String(e).slice(0, 70) }))

  const row = { ...site, ...res }
  rows.push(row)
  const v =
    res.status !== "OK"
      ? `${res.status} (title="${res.title ?? "?"}" body=${res.bodyLen ?? "?"})`
      : `${String(res.count).padStart(3)} recs${res.want != null ? (res.count === res.want ? ` ✓${res.want}` : ` ✗want${res.want}`) : "    "} | ${res.disjoint ? "disj" : "NEST"} ${res.distinctPct}%u ${res.stable ? "stab" : "UNST"} blind=${res.blind} ${res.msRecords}ms`
  console.log(`${res.status === "OK" ? "✓" : "✗"} ${site.url.replace(/^https?:\/\//, "").slice(0, 46).padEnd(46)} ${v}`)
  await page.close()
}

await browser.close()

const okRows = rows.filter((r) => r.status === "OK")
const pass = (r: any) => r.disjoint && (r.stable !== false) && r.homogeneous && r.distinctPct >= 80 && (r.want == null || r.count === r.want)

const md = [
  `# page-tools validation — real pages`,
  ``,
  `Run ${new Date().toISOString().slice(0, 16).replace("T", " ")} · headless Chrome · ${SITES.length} sites`,
  `Helpers: \`__data\`, \`__records\`, \`__skeleton\`, \`__recordsBlind\`.`,
  ``,
  `## Method`,
  ``,
  `Each site is anchored the way the agent would anchor it — \`__find("<a known item>")\` where a stable`,
  `seed string exists, otherwise the repeated link position carrying the most text (content lists, not nav).`,
  `Ground-truth counts exist for only ${SITES.filter((s) => s.truth).length} sites, so correctness is judged mostly by invariants that must`,
  `hold for *any* correct record set:`,
  ``,
  `| invariant | catches |`,
  `|---|---|`,
  `| **disj** — no record nests inside another | picking a container level instead of the record level |`,
  `| **uniq** — records carry distinct text | spacer/duplicate rows swept in |`,
  `| **stab** — anchoring on a different member of the same group returns the same size | anchor-dependent (i.e. unreliable) grouping |`,
  `| **homog** — all records share a tag | mixed row types (the HN 60-vs-30 bug) |`,
  `| **blind** — \`__recordsBlind()\` with no anchor | independent second opinion |`,
  ``,
  `## Results`,
  ``,
  `| Site | Structure | recs | want | disj | uniq | stab | homog | blind | anchor | __data | ms |`,
  `|---|---|---|---|---|---|---|---|---|---|---|---|`,
  ...rows.map((r) =>
    r.status !== "OK"
      ? `| ${r.url.replace(/^https?:\/\//, "").slice(0, 44)} | ${r.kind} | \`${r.status}\` | ${r.want ?? "—"} | | | | | | | ${r.dataBytes ?? "—"} | |`
      : `| ${r.url.replace(/^https?:\/\//, "").slice(0, 44)} | ${r.kind} | **${r.count}** | ${r.want ?? "—"} | ${r.disjoint ? "✓" : "✗"} | ${r.distinctPct}% | ${r.stable ? "✓" : "✗"} | ${r.homogeneous ? "✓" : "✗"} | ${r.blind} | ${r.autoAnchor ? "auto" : "seed"} | ${r.dataBytes}B${r.dataOverCap ? "⚠" : ""} | ${r.msRecords} |`,
  ),
  ``,
  `## Summary`,
  ``,
  `- reached: **${okRows.length}/${SITES.length}** · blocked/failed: ${rows.length - okRows.length}`,
  `- all invariants passed: **${okRows.filter(pass).length}/${okRows.length}**`,
  `- disjoint ${okRows.filter((r) => r.disjoint).length}/${okRows.length} · stable ${okRows.filter((r) => r.stable).length}/${okRows.length} · homogeneous ${okRows.filter((r) => r.homogeneous).length}/${okRows.length} · uniq≥80% ${okRows.filter((r) => r.distinctPct >= 80).length}/${okRows.length}`,
  `- ground truth hit: ${okRows.filter((r) => r.want != null && r.count === r.want).length}/${okRows.filter((r) => r.want != null).length}`,
  `- \`__data\` over 8KB output cap: ${okRows.filter((r) => r.dataOverCap).length}/${okRows.length}`,
  `- \`__records\` median ${okRows.length ? okRows.map((r) => r.msRecords).sort((a, b) => a - b)[Math.floor(okRows.length / 2)] : "—"} ms · \`__skeleton\` median ${okRows.length ? okRows.map((r) => r.skelBytes).sort((a, b) => a - b)[Math.floor(okRows.length / 2)] : "—"} B`,
  ``,
  `## Sites failing an invariant`,
  ``,
  ...(okRows.filter((r) => !pass(r)).length === 0
    ? ["(none)"]
    : okRows
        .filter((r) => !pass(r))
        .flatMap((r) => [
          `### ${r.url}`,
          ``,
          `${r.count} × \`${r.tag}\` · blind ${r.blind} · disj ${r.disjoint} · uniq ${r.distinctPct}% · stab ${r.stable} · homog ${r.homogeneous}${r.want != null ? ` · expected ${r.want}` : ""}`,
          `anchor: "${r.anchor}"`,
          ``,
          "```",
          r.skelSample || "",
          "```",
          ``,
        ])),
  `## Unreachable sites`,
  ``,
  ...(rows.filter((r) => r.status !== "OK").length === 0
    ? ["(none)"]
    : rows.filter((r) => r.status !== "OK").map((r) => `- \`${r.url}\` → **${r.status}**${r.title ? ` · title="${r.title}" bodyLen=${r.bodyLen}` : ""}${r.err ? ` · ${r.err}` : ""}`)),
  ``,
  `## \`__data\` per site`,
  ``,
  ...okRows.map((r) => `- \`${r.url.replace(/^https?:\/\//, "").slice(0, 44)}\` → ${r.dataTypes?.length ? r.dataTypes.join(", ") : "(none)"} · ${r.dataBytes}B`),
  ``,
].join("\n")

await Bun.write("../../assets/benchmark/results/page-tools-validation.md", md)
console.log(`\ninvariants passed: ${okRows.filter(pass).length}/${okRows.length}`)
console.log("report → assets/benchmark/results/page-tools-validation.md")
