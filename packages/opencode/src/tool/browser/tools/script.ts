import { Effect, Schema } from "effect"
import * as Tool from "../../tool"
import * as Truncate from "../../truncate"
import { BrowserManager } from "../manager"
import { getPageDom, skippedDomOutput } from "../dom-utils"
import { wrapScript } from "../page-tools"

const EXTRACTION_GUIDE = `# Extraction guide

## Strategy — try in this order

### 1. \`__data(type?)\` first
Many pages embed the answer as machine-readable data (JSON-LD, microdata, og/meta) that never appears in the DOM snapshot. Its fields are NAMED, so it separates values the rendered page conflates.
\`\`\`js
return __data("Recipe")[0].aggregateRating;  // { ratingValue, ratingCount, reviewCount }
return __data("Product");                    // priced items on the page
return __data();                             // everything the page embeds
\`\`\`
**Never substitute a near-miss field.** \`ratingCount\` (people who rated) and \`reviewCount\` (people who wrote a review) are different numbers, and pages often embed only one of them. If the field the task asks for is missing from \`__data\`, do NOT report the similar-sounding one — go find the real value in the page:
\`\`\`js
return __find("[0-9,]+\\\\s*(Reviews?|Ratings?)").map(function(e) {
  return e.textContent.replace(/\\\\s+/g, " ").trim();
});   // e.g. ["21002 Ratings", "15,328 Reviews"] — two different numbers
\`\`\`
The same applies to any constraint the task states (price, size, condition, "in stock"): confirm it against a field that actually means that, or say you could not confirm it.

### 2. Anchor → records → skeleton — for a list of repeating items
Seed from one item you already know exists, and let \`__records\` find the rest:
\`\`\`js
var r = __records(__find("Artichoke Spinach Lasagna")[0]);
return { count: r.length, sample: __skeleton(r[0]) };
\`\`\`
**Always do this confirm-first step.** \`count\` should look like the number of items on the page — a wrong group produces confident garbage. \`__skeleton\` shows you the real structure inside one record, including class names and \`[N]\` indices that the DOM snapshot hides.

Then write an exact extractor against the structure you just saw:
\`\`\`js
return __records(__find("Artichoke Spinach Lasagna")[0]).map(function(el) {
  return {
    name: el.querySelector("a.title").textContent.trim(),
    reviews: el.querySelector(".review-count").textContent,
    index: el.getAttribute("data-hl-idx"),   // pass to browser_click
  };
});
\`\`\`
Extract only the fields the task needs — returning whole elements is expensive.

### 3. Hand-written selectors last
\`querySelector\` is fine for reading.

**Principles**: structured data > scraping · anchor > blind selectors · named fields > the most visible number.

## Helpers

### __data(type?) → Object[]
Embedded structured data. Optional regex filter on type.

### __q(n) → Element
Element by its [N] or <N> index from the DOM output.

### __find(pattern, tag?, n?) → Element[] (max 20 results)
Regex search across text content and all attributes. Optional tag filter, optional [N] scope.
\`\`\`js
return __find("Search apartments");   // text match
return __find("price|monthly");       // regex OR
return __find("submit", "button");    // filter by tag
\`\`\`

### __records(anchor?) → Element[]
All elements that repeat with the same structure as the anchor (one row/card/item each). Anchor is an element or an [N] index; without one it guesses the largest repeating group on the page.

### __skeleton(el, depth?) → string
Compressed structure of one element — tags, ids, classes, aria/itemprop, \`[N]\` indices and direct text. Use it to see inside a record before writing selectors. Default depth 4.

## Serialization
Returned HTMLElements become \`{index, tagName, textContent, attrs, childElementCount, ...}\`.
- \`index\` — nearest [N] highlight index; pass it to browser_click / browser_input
- \`attrs\` — identifying attributes only (id, class, aria-label, role, short data-*)
- Need another attribute? Read it explicitly: \`el.getAttribute("data-x")\`
- Returning many elements is expensive — return plain objects holding just the fields you need.`

export const BrowserExecuteScriptTool = Tool.define(
  "browser_execute_script",
  Effect.gen(function* () {
    const truncate = yield* Truncate.Service
    return {
      description: `Execute JavaScript in the page context to READ data. You have full DOM/Web API access.

Helpers in scope: \`__data\`, \`__q\`, \`__find\`, \`__records\`, \`__skeleton\`.

**Extracting structured data, or working with a set of repeating/similar elements?** Pass \`guide: true\` to load the extraction guide first — pages often embed the answer as named machine-readable data the DOM snapshot never shows, and there is a reliable way to work a repeating list. You can pass \`script\` in the same call.

## Rules
- **Read, don't act.** Use browser_click / browser_input / browser_scroll_* for actions — they keep your DOM snapshot in sync. A JS \`.click()\` or \`.value =\` changes the page behind your snapshot's back, so what you see next no longer matches the page.
- **Return plain objects/arrays** for extracted data — they serialize compactly. Returning many elements is expensive.
- Returned elements serialize with an \`index\` field — pass it to browser_click / browser_input.
- Record what you found in your text output before acting — the snapshot is replaced by your next action.`,
      parameters: Schema.Struct({
        script: Schema.optional(Schema.String).annotate({
          description: "JavaScript function body. Omit when only loading the guide.",
        }),
        guide: Schema.optional(Schema.Boolean).annotate({
          description: "Load the extraction guide (structured data + repeating elements). Combinable with `script`.",
        }),
      }),
      execute: (params: { script?: string; guide?: boolean }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const guide = params.guide ? `${EXTRACTION_GUIDE}\n\n---\n\n` : ""

          if (!params.script)
            return {
              title: params.guide ? "Extraction guide" : "Execute script",
              output: params.guide
                ? EXTRACTION_GUIDE
                : "Provide `script` to execute, or `guide: true` to load the extraction guide.",
              metadata: {},
            }

          const manager = BrowserManager.getInstance()
          const tab = manager.getActiveTab()

          const { resultText, dom } = yield* Effect.promise(() =>
            manager.enqueue(async (isLast) => {
              const result = await tab.domService.withClient(async () => {
                const returnValue = await tab.domService.evaluateWithReturn(wrapScript(params.script!))
                return returnValue !== undefined
                  ? `Result: ${JSON.stringify(returnValue)}`
                  : "Script executed successfully"
              })
              const dom = isLast() ? await getPageDom(manager) : skippedDomOutput()
              return { resultText: result, dom }
            }),
          )

          const truncated = yield* truncate.output(resultText, { maxLines: 100, maxBytes: 8 * 1024 })
          return {
            title: "Execute script",
            output: `${guide}${truncated.content}${dom.output}`,
            metadata: {
              ...(truncated.truncated ? { scriptResultPath: truncated.outputPath } : {}),
            },
          }
        }),
    }
  }),
)
