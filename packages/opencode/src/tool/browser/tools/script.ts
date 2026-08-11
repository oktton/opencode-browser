import z from "zod"
import { Tool } from "../../tool"
import { BrowserManager } from "../manager"
import { getPageDom } from "../dom-utils"
import { wrapScript } from "../page-tools"

export const BrowserExecuteScriptTool = Tool.define("browser_execute_script", {
  description: `Execute JavaScript in the page context. You have full DOM/Web API access.

## Rules
- Always use \`__find\` / \`__q\` / \`__get\` instead of querySelector, getElementById, etc.
- Always return elements directly — they auto-serialize so you can read data immediately.
- Always use \`__get(ref)\` to retrieve elements from previous calls, forming a ref chain across multiple script executions.

## Built-in tools:

### __q(n) → Element
Get element by its [N] or <N> index from the DOM output.
\`\`\`js
const btn = __q(15);   // get element [15]
btn.textContent;       // read its text
\`\`\`

### __find(pattern, tag?) → Element[] (max 20 results)
Regex search across text content and all attributes. Optional tag filter.
\`\`\`js
return __find("Search apartments");        // text match
return __find("price|monthly");            // regex OR
return __find("submit", "button");         // filter by tag
\`\`\`

### __get(ref) → Element
Retrieve element from a previous call using its \`ref\` id (persists across calls).
\`\`\`js
const el = __get(7);
el.scrollIntoView({ behavior: "smooth", block: "center" });
return __clickable(el);
\`\`\`

### __clickable(el) → Element[]
Find all clickable elements near the given element (ancestors + children).

## Auto-serialization
Returned HTMLElements auto-serialize to \`{ref, index, tagName, textContent, attrs, ...}\`.
- \`ref\`: string like "r0", "r5" — use with \`__get(ref)\` in next call
- \`index\`: nearest [N] highlight index — use with browser_click/browser_input`,
  parameters: z.object({
    script: z.string().describe("JavaScript function body."),
  }),
  async execute(params, ctx) {
    const manager = BrowserManager.getInstance()
    const tab = manager.getActiveTab()

    return tab.domService.withClient(async () => {
      const returnValue = await tab.domService.evaluateWithReturn(wrapScript(params.script))
      const resultText =
        returnValue !== undefined
          ? `Result: ${JSON.stringify(returnValue)}`
          : "Script executed successfully"

      const dom = await getPageDom(manager, tab)
      return {
        title: "Execute script",
        output: `${resultText}${dom.output}`,
        metadata: {},
      }
    })
  },
})
