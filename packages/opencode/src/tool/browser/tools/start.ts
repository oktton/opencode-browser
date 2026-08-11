import z from "zod"
import { Tool } from "../../tool"
import { BrowserManager } from "../manager"
import { getPageDom } from "../dom-utils"

const BROWSER_SYSTEM_PROMPT = `# Browser Mode

You now have access to browser automation tools. You can navigate, click, fill forms, scroll, and execute JavaScript on web pages.

## DOM Snapshot

Each DOM snapshot has:
- **Header**: \`(stateId: tab0-dom5 | scrollPosition: [container:0] at P1.8)\`
- **Element markers**:
  - \`[N]\` = Clickable element (use N in browser_click)
  - \`<N>\` = Input element (use N in browser_input)
  - \`[view:ID]\` = Visual element (image/table/svg/icon) — use \`browser_view_elements\` to inspect
- \`=== OFF-SCREEN {direction} [container:N] ===\` ... \`=== END OFF-SCREEN ===\` = Off-screen elements. Use \`browser_reveal_offscreen\` to scroll to elements inside these blocks.
- \`\\t\` indentation = Nesting depth. Same level = siblings, deeper level = children
- **scrollMap**: \`[container:0] 13 pages | viewing P2-3 | unexplored P4-6,P11-12\` — shows total pages, current viewport, and exploration status.

**Incremental DOM updates** show only changes since the last snapshot (\`+|\` added, \`-|\` removed). All elements from previous snapshots remain available unless explicitly removed.

## Decision Process

1. Review the user's task and current goal
2. Analyze the current page DOM to see what elements are available
3. **Record important information in your text output before taking actions that change the page** — the current DOM snapshot will be replaced after your next action. Any unrecorded data is lost. Write down answers, clues, navigation waypoints, or any useful observations before proceeding.
4. Prefer targeted actions (filters, sorting, dropdowns) over browsing items one by one
5. Execute the next action based on your reasoning

## Element Selection

1. Use \`<N>\` for input fields and \`[N]\` for clickable elements
2. Match by text content — look for buttons/links with relevant text
3. Indentation indicates parent-child relationships
4. Only use indices visible in the current DOM — don't guess

## Common Patterns

### Navigation
- Use \`browser_goto\` for direct URLs
- Use \`browser_click\` on links [N] for in-page navigation
- Use \`browser_restore_state\` to go back to a previous page — never use the back button

### Searching
- Find the search input field <N>
- Use \`browser_input\` with pressEnter: true to submit

### Form Filling
- Identify all required input fields <N>
- Fill each field using browser_input (clear: true by default)
- On the last field, use pressEnter: true, or click the submit button [N]

### Scrolling
- Elements inside \`=== OFF-SCREEN ===\` blocks are NOT visible — scroll first before interacting
- \`browser_reveal_offscreen\`: Scroll to elements in OFF-SCREEN blocks. Use \`target\` to scroll directly to a specific element.
- \`browser_scroll_next_screen\`: Scan through unseen content progressively.
- \`browser_scroll_to_page\`: Jump directly to a specific page.
- Use \`container: N\` where N is the index from \`[container:N]\` in the DOM.

### Information Extraction
- Scroll progressively to discover lazy-loaded content
- Use \`browser_execute_script\` with \`__find()\` + \`scrollIntoView()\` to locate specific elements quickly

### State Recovery
- Different stateId → \`browser_restore_state(stateId)\` — reverts to that exact page state
- Same stateId, different scroll → \`browser_scroll_to_page\` — jump back to content you noted earlier

### JavaScript Execution
- Use built-in tools (\`__q\`, \`__find\`, \`__get\`, \`__clickable\`) instead of querySelector
- Return elements directly — they auto-serialize to \`{ref, index, tagName, textContent, attrs, ...}\`

## Available Tools

### Navigation
- **browser_goto**(url) — Navigate to a URL
- **browser_refresh**() — Refresh the current page
- **browser_restore_state**(stateId) — Navigate back to a previous state by stateId (e.g. "tab0-dom3")

### Tabs
- **browser_new_tab**(url?) — Open a new tab, optionally navigate to a URL
- **browser_switch_tab**(tabId) — Switch to a different tab
- **browser_close_tab**(tabIds?) — Close tab(s), defaults to active tab

### Interaction
- **browser_click**(elementIndex) — Click on element [N] or <N>
- **browser_input**(elementIndex, text, {clear?, pressEnter?}) — Fill text into input <N>. clear=true by default. pressEnter=false by default.
- **browser_execute_script**(script) — Execute JavaScript with built-in helpers (__q, __find, __get, __clickable)

### Scrolling
- **browser_reveal_offscreen**(direction, container, target?) — Scroll to off-screen elements
- **browser_scroll_next_screen**(direction, container) — Scroll past viewport to next unseen screen
- **browser_scroll_to_page**(page, container) — Jump to a specific page

### Observation
- **browser_view_elements**(viewIds) — Inspect visual elements [view:ID]

### Utility
- **browser_wait**(seconds) — Wait for a specified time`

export const BrowserStartTool = Tool.define("browser_start", {
  description: `Enter browser mode. Call this BEFORE using any other browser_* tools.
Opens a real browser, navigates to the URL, and returns the browser usage guide with DOM snapshot.
Use when websearch or webfetch alone are not enough — e.g. interacting with web apps, filling forms, navigating multi-step flows, or extracting content from dynamic/JS-rendered pages that require real-time browser interaction.`,
  parameters: z.object({
    url: z.string().describe("The URL to navigate to"),
  }),
  async execute(params, ctx) {
    const manager = BrowserManager.getInstance()
    const tab = manager.hasActiveTab() ? manager.getActiveTab() : await manager.newTab()

    await tab.page.goto(params.url, { waitUntil: "domcontentloaded" }).catch(() => {})

    const hasGuide = ctx.messages.some((msg) =>
      msg.parts.some(
        (part) =>
          part.type === "tool" &&
          part.tool === "browser_start" &&
          part.state.status === "completed" &&
          !part.state.metadata?.truncated,
      ),
    )

    const dom = await getPageDom(manager, tab)
    const guide = hasGuide ? "" : `${BROWSER_SYSTEM_PROMPT}\n\n---\n\n`
    return {
      title: `Browser started → ${params.url}`,
      output: `${guide}Navigated to ${params.url}${dom.output}`,
      metadata: { url: params.url, domId: dom.domId },
    }
  },
})
