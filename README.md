# OpenCode Browser Agent

An AI-powered browser agent built on top of [OpenCode](https://github.com/anomalyco/opencode). Give natural language instructions and the agent autonomously navigates websites, fills forms, extracts information, and completes complex multi-step tasks.

> **Based on [OpenCode](https://github.com/anomalyco/opencode)** — the open source AI coding agent. This fork adds browser automation capabilities with intelligent DOM extraction, incremental diffing, and MCP 2.0 tool integration.

## Examples

### Example 1: Information Extraction

> **Prompt**: "使用浏览器找到 Hugging Face 热门大语言模型页面，记录排名前三的模型，包括模型名称、发布机构、参数规模、下载量或热度、是否支持中文。将结果保存到 huggingface_top3_models.md 文件中。"

https://github.com/user-attachments/assets/huggingface_top3_models.mp4

The agent navigates to HuggingFace, extracts model information, and produces a structured report:

| Rank | Model | Organization | Parameters | Monthly Downloads |
|------|-------|-------------|-----------|-------------------|
| 1 | Qwen3.8-2.4T-A95B | Alibaba (Qwen) | 2.4T (MoE) | 1,012 |
| 2 | DeepSeek-V4-Flash-0731 | DeepSeek | 304B | 1,431,587 |
| 3 | LFM2.5-2.6B | Liquid AI | 3B | 116,640 |

<details>
<summary>📄 Full report</summary>

See [huggingface_top3_models.md](assets/examples/huggingface_top3_models.md)

</details>

---

### Example 2: Complex Form Filling

> **Prompt**: "使用浏览器访问 London Business School 官方 Contact Us 页面，找到在线咨询表单，填写所有字段（Masters programmes, kai.chen@example.com, Mr, Kai Chen...），检查页面校验结果，但不要最终提交表单。将填写内容和校验结果保存到 lbs_form_report.md。"

https://github.com/user-attachments/assets/lbs_form_report.mp4

9 fields filled correctly, including conditional fields, dropdown menus, and password confirmation.

| Field | Value | Status |
|-------|-------|--------|
| Question | Masters programmes | ✅ |
| Topic | Unspecified | ✅ (conditionally displayed) |
| Email | kai.chen@example.com | ✅ |
| Title | Mr | ✅ |
| First Name | Kai | ✅ |
| Last Name | Chen | ✅ |
| Comment | Application requirements inquiry (90 chars) | ✅ |
| Password | KaiMaster2026 | ✅ |
| Confirm Password | KaiMaster2026 | ✅ |

<details>
<summary>📄 Full report with DOM constraint analysis</summary>

See [lbs_form_report.md](assets/examples/lbs_form_report.md)

</details>

---

### Example 3: Deep Research

> **Prompt**: "使用浏览器调查论文《Generative Agents: Interactive Simulacra of Human Behavior》的代码复现情况。找到GitHub仓库，检查代码完整性、依赖环境、运行说明、Issues中常见复现问题。判断复现难度并说明原因，整理到 reproduction_report.md。"

https://github.com/user-attachments/assets/reproduction_report.mp4

The agent performs multi-step research: navigates to the GitHub repo, checks issues, analyzes dependencies, evaluates code completeness, and generates a comprehensive reproducibility report.

**Result**: 🟡 Medium difficulty — code is complete but core OpenAI models (`text-davinci-002/003`) have been deprecated, dependencies are outdated, and the project is unmaintained (3 years, 115 open issues).

<details>
<summary>📄 Full reproducibility report</summary>

See [reproduction_report.md](assets/examples/reproduction_report.md)

</details>

### Cost

All examples run on **MiniMax M3** ($0.30/M input, $1.20/M output):

| Task | Steps | Final Context | Cost |
|------|-------|--------------|------|
| Information Extraction (HuggingFace) | 6 | 20,363 tokens | $0.022 |
| Complex Form Filling (9 fields) | 15 | 21,527 tokens | $0.030 |
| Deep Research (Paper Reproducibility) | 14 | 26,597 tokens | $0.040 |

Multi-step agent tasks at **~$0.03 each** — enabled by incremental DOM diffing that keeps context compact.

---

## Incremental DOM Diff

Most browser agents re-send the **entire page DOM** to the LLM after every action. This is wasteful — the LLM re-reads thousands of unchanged elements just to find what changed.

We take a different approach: **diff the DOM tree and send only what changed.**

### How It Works

The agent is on a Bing search page. It clicks the settings button:

| Before | After |
|--------|-------|
| ![before](assets/dom-comparison/bing-search-before.png) | ![after](assets/dom-comparison/bing-search-after.png) |

A settings menu appeared on the right. One trending topic scrolled out of view. **Everything else is identical.**

Other agents would re-send the entire ~186-line DOM. We send this instead:

```diff
  <header></header>                                        ← unchanged, stays as-is
      <form></form>
          [831]<a> 返回到必应搜索 </a>                       ← unchanged
      ...
+|    <span></span>                                        ← NEW: settings menu appeared
+|        [2147]<a> 使用个人帐户登录 </a>
+|        [2151]<a role='menuitem' aria-label='收藏'></a>
+|            [2155]<div> 收藏 </div>
+|        [2158]<div role='menuitem'> 设置 </div>
+|        [2189]<a role='menuitem'> 安全搜索 </a>
+|        [2195]<a role='menuitem'> 搜索历史记录 </a>
+|        [2201]<a role='menuitem'> 隐私 </a>
+|        [2207]<a role='menuitem'> 反馈 </a>
+|        ...
      [543]<a> 潇湘晨报 on MSN · 5 小时 ... </a>            ← unchanged news results
      ...
-|    [717]<div> 禁止在居民楼开油烟餐饮 </div>                ← GONE: scrolled out of view
-|        [1154]<a aria-label='禁止在居民楼开油烟餐饮'></a>
```

`+|` = appeared after the action. `-|` = disappeared. No prefix = unchanged.

<details>
<summary>Full diff output (76 lines)</summary>

See [dom-diff.txt](assets/dom-comparison/dom-diff.txt)

</details>

### Why This Matters

**1. KV Cache reuse** — Unchanged DOM stays as a stable prefix across rounds. LLM APIs skip re-computing attention for cached prefixes. Re-sending the full DOM each round **invalidates the entire cache**, wasting latency and cost.

**2. Focused attention** — The `+|`/`-|` markers tell the LLM exactly what its last action changed. No more scanning 2000 lines of static content to find what happened.

**3. Longer task horizons** — A 10-step task that re-sends full DOM each round quickly exhausts the context window. With incremental diff, each round only adds the delta:

```
Round    Full re-send         Incremental Diff
  1       ~2,000 tokens        ~2,000 tokens
  2       ~2,000 tokens          ~400 tokens
  3       ~2,000 tokens          ~300 tokens
  ...          ...                   ...
 10       ~2,000 tokens          ~200 tokens
───────────────────────────────────────────────
Total    ~20,000 tokens        ~4,500 tokens  ↓77%
```

---

## Architecture

```
User Instruction → Agentic Loop:
  1. Extract DOM via CDP (snapshot → prune → highlight → render)
  2. Build prompt with DOM + action history
  3. LLM decides which tool to call (ReAct)
  4. Execute tool via MCP 2.0
  5. Compute DOM Diff (incremental update)
  6. Analyze page changes
  7. Repeat until task complete
→ Stream results in real-time
```

### DOM Processing Pipeline

```
CDP Snapshot → Tree Build → Render Info (5 stages) → Prune → Highlight → Render
                                                                           ↓
                                                               [N] clickable elements
                                                               <N> fillable inputs
                                                               [view:ID] visual elements
                                                               +| / -| diff markers
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `browser_goto` | Navigate to a URL |
| `browser_click` | Click elements by index `[N]` |
| `browser_input` | Fill text into input fields `<N>` |
| `browser_execute_script` | Run JavaScript |
| `browser_scroll_explore` | Scroll to discover content |
| `browser_reveal_offscreen` | Scroll to specific off-screen elements |
| `browser_screenshot` | Capture page screenshot |
| `browser_extract` | Extract structured info from the page |
| `browser_view_elements` | Inspect images, tables, SVGs |
| `browser_new_tab` / `browser_close_tab` | Tab management |
| `browser_back` / `browser_forward` / `browser_refresh` | Navigation |
| `browser_wait` | Wait for page changes |

### What I Built (vs. Original OpenCode)

```
packages/opencode/src/tool/browser/
├── cdp/                  # Chrome DevTools Protocol communication
├── dom/
│   ├── snapshot/          # CDP Accessibility Snapshot
│   ├── tree/              # DOM tree construction & traversal
│   ├── serializer/        # Render info extraction (5 stages)
│   ├── markdown/          # DOM → structured text rendering
│   ├── types/             # DOM node type definitions
│   └── utils/             # Pruning, merging, visibility detection
├── tools/                 # 14 MCP Browser Tools
│   ├── navigate.ts        #   goto / back / forward / refresh
│   ├── interact.ts        #   click / input
│   ├── scroll.ts          #   scroll_explore / reveal_offscreen
│   ├── observe.ts         #   screenshot / extract / view_elements
│   ├── script.ts          #   execute_script
│   ├── tab.ts             #   new_tab / close_tab
│   ├── wait.ts            #   wait for page changes
│   └── start.ts           #   browser launch & connect
├── diff.ts                # ★ Incremental DOM Diff algorithm
├── manager.ts             # Browser lifecycle management
├── service.ts             # Agentic Loop (ReAct) orchestration
├── highlight.ts           # [N] clickable / <N> fillable annotation
├── clickable-detector.ts  # Clickable element detection
├── render-info.ts         # Viewport awareness & OFF-SCREEN markers
├── pruner.ts              # DOM pruning (noise reduction)
└── ...

---

## Built On

This project extends [OpenCode](https://github.com/anomalyco/opencode) with browser agent capabilities.
