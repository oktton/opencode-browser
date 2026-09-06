import puppeteer from "puppeteer-core"
import { PAGE_TOOLS_SCRIPT, wrapScript } from "./src/tool/browser/page-tools"

const b = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: ["--no-sandbox"],
})
const p = await b.newPage()
await p.goto("https://books.toscrape.com/", { waitUntil: "domcontentloaded" })
await p.evaluate(PAGE_TOOLS_SCRIPT)

const run = async (label: string, script: string) => {
  const out = await p.evaluate(wrapScript(script))
  const json = JSON.stringify(out, null, 2)
  const flat = JSON.stringify(out)
  console.log("\n" + "█".repeat(78))
  console.log(`█ ${label}`)
  console.log(`█ script: ${script.replace(/\s+/g, " ").trim().slice(0, 100)}`)
  console.log(`█ ${flat.length} bytes  ≈${Math.round(flat.length / 3.6)} tokens`)
  console.log("█".repeat(78))
  console.log(json.length > 2600 ? json.slice(0, 2600) + "\n… [truncated for display]" : json)
}

// 1. what the model gets if it just returns the records
await run("A. return __records(...)  — raw records", `return __records(__find("A Light in the Attic"));`)

// 2. the confirm-first step the guide mandates
await run(
  "B. return { count, sample: __skeleton(r[0]) }  — the guide's step 1",
  `var r = __records(__find("A Light in the Attic")); return { count: r.length, sample: __skeleton(r[0]) };`,
)

// 3. the extractor the model writes after seeing the skeleton
await run(
  "C. model-written extractor  — plain objects",
  `return __records(__find("A Light in the Attic")).map(function(el) {
     return {
       title: el.querySelector("h3 a").getAttribute("title"),
       price: el.querySelector(".price_color").textContent,
       stock: el.querySelector(".availability").textContent.replace(/\\s+/g, " ").trim(),
       index: el.querySelector("[data-hl-idx]") ? el.querySelector("[data-hl-idx]").getAttribute("data-hl-idx") : null,
     };
   });`,
)

await b.close()
