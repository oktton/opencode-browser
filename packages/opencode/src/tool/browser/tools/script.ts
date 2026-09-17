import { Effect, Schema } from "effect"
import * as Tool from "../../tool"
import * as Truncate from "../../truncate"
import { BrowserManager } from "../manager"
import { getPageDom, DOM_DEFERRED } from "../dom-utils"
import { wrapScript } from "../page-tools"

export const BrowserExecuteScriptTool = Tool.define(
  "browser_execute_script",
  Effect.gen(function* () {
    const truncate = yield* Truncate.Service
    return {
      description: `Run JavaScript in the page context. Full DOM/Web API access, plus the helpers below — for pulling out data the snapshot flattens, working a whole list at once, or reaching anything the other browser tools do not cover.

## Helpers

### __data(type?) → Object[]
The page's own embedded data — JSON-LD, microdata, og/meta — much of which never appears in the DOM snapshot. Its fields are named, so it separates values the rendered page runs together. Optional regex filter on type.
\`\`\`js
return __data("Recipe")[0].aggregateRating;  // { ratingValue, ratingCount, reviewCount }
return __data("Product");                    // priced items on the page
return __data();                             // everything the page embeds
\`\`\`
What a page embeds depends on what that page is: a listing usually carries only \`og:\` meta, while the item page behind it carries the full record. A thin result on one page says nothing about the next.

### __find(pattern, tag?, n?) → Element[] (max 20 results)
Regex search across text content and all attributes. Optional tag filter, optional [N] scope.
\`\`\`js
return __find("Search apartments");   // text match
return __find("price|monthly");       // regex OR
return __find("submit", "button");    // filter by tag
\`\`\`

### __records(anchor?) → Element[]
\`querySelectorAll\` for when you do not know the selector. Hand it one item you can already see — a title from the snapshot — and it works out which elements repeat with that same structure, returning one row/card/item each. The anchor is an element or an [N] index; without one it guesses the largest repeating group on the page.

It replaces the usual hunt for a stable class or \`[id^="..."]\` prefix, which on a modern site is often hashed, shared across unrelated blocks, or different for the first and last card. \`count\` says whether the group is right: one that missed produces a confident-looking wrong list.
\`\`\`js
var r = __records(__find("Artichoke Spinach Lasagna")[0]);
return { count: r.length, sample: __skeleton(r[0]) };
\`\`\`

### __skeleton(el, depth?) → string
What you would read \`el.outerHTML\` for, without the noise that makes it unreadable — tags, ids, classes, aria/itemprop, \`[N]\` indices and direct text, to depth 4 by default. Typically a third the size and it surfaces what raw markup buries: the value you are after often sits in a class name (\`p.star-rating.Three\`, where the five identical star icons beneath it say nothing) rather than in text.

Once the shape is known, an extractor over the whole group is exact:
\`\`\`js
return __records(__find("Artichoke Spinach Lasagna")[0]).map(function(el) {
  return {
    name: el.querySelector("a.title").textContent.trim(),
    reviews: el.querySelector(".review-count").textContent,
    index: el.getAttribute("data-hl-idx"),   // pass to browser_click
  };
});
\`\`\`

### __q(n) → Element
Element by its [N] or <N> index from the DOM output.

## Things that bite
- \`ratingCount\` (people who rated) and \`reviewCount\` (people who wrote a review) are different numbers, and pages often embed only one. The same goes for any constraint a task states — price, size, condition, "in stock". A similar-sounding field is a different measurement, and when the real one is absent from \`__data\` it may still be in the page text:
\`\`\`js
return __find("[0-9,]+\\\\s*(Reviews?|Ratings?)").map(function(e) {
  return e.textContent.replace(/\\\\s+/g, " ").trim();
});   // e.g. ["21002 Ratings", "15,328 Reviews"] — two different numbers
\`\`\`
- Returning whole elements, or many of them, is expensive; plain objects holding the fields you need serialize far smaller.

## Serialization
Returned HTMLElements become \`{index, tagName, textContent, attrs, childElementCount, ...}\`.
- \`index\` — the closest highlighted ancestor's [N], so an element you found here can be clicked even when the snapshot never showed it. Pass it to browser_click / browser_input
- \`attrs\` — identifying attributes only (id, class, aria-label, role, short data-*)
- any other attribute is readable explicitly: \`el.getAttribute("data-x")\`
`,
      parameters: Schema.Struct({
        script: Schema.String.annotate({
          description: "JavaScript function body.",
        }),
      }),
      execute: (params: { script: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const manager = BrowserManager.getInstance()
          const tab = manager.getActiveTab()

          const { resultText, dom } = yield* Effect.promise(() =>
            manager.enqueue(async (isLast) => {
              const result = await tab.domService.withClient(async () => {
                const returnValue = await tab.domService.evaluateWithReturn(wrapScript(params.script))
                return returnValue !== undefined
                  ? `Result: ${JSON.stringify(returnValue)}`
                  : "Script executed successfully"
              })
              const dom = isLast() ? await getPageDom(manager, truncate, { sessionID: ctx.sessionID }) : undefined
              return { resultText: result, dom }
            }),
          )

          const truncated = yield* truncate.output(resultText, { maxLines: 100, maxBytes: 8 * 1024 })
          // The generic truncation hint only offers the saved file. An oversized
          // return usually means the selector was too wide, and that fix lives in
          // the next script, so name it here too.
          const overflow = truncated.truncated
            ? `\n\n**Your script returned too much.** Narrowing it is usually faster: return only the fields you need, use \`__data("Type")\` to pull the page's own structured data, or \`__skeleton(el)\` to inspect one element's shape before mapping over all of them.`
            : ""
          return {
            title: "Execute script",
            output: `${truncated.content}${overflow}${dom ? "" : DOM_DEFERRED}`,
            metadata: {
              ...(truncated.truncated ? { scriptResultPath: truncated.outputPath } : {}),
              ...(dom ? { dom } : {}),
            },
          }
        }),
    }
  }),
)
