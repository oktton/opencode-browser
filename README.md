# OpenCode Browser Agent

An AI-powered browser agent built on top of [OpenCode](https://github.com/anomalyco/opencode). Give natural language instructions and the agent autonomously navigates websites, fills forms, extracts information, and completes complex multi-step tasks.

> **Based on [OpenCode](https://github.com/anomalyco/opencode)** — the open source AI coding agent. This fork adds browser automation capabilities with intelligent DOM extraction, incremental diffing, and MCP 2.0 tool integration.

## Quick Start

```bash
git clone https://github.com/oktton/opencode-browser.git
cd opencode-browser
bun install
bun run dev:desktop
```

Requires [Bun](https://bun.sh) and an LLM API key (set via the in-app settings). Then type a browser task in natural language — the agent handles the rest.

## Examples

### Example 1: Information Extraction

> **Prompt**: "找到 HuggingFace 热门大语言模型 Top 3，记录名称、机构、参数、下载量、是否支持中文。"

https://github.com/user-attachments/assets/3d2ef328-b42a-45f4-820a-3e29b5ac923b

The agent navigates to HuggingFace, extracts model information, and produces a structured report:

| Rank | Model | Organization | Parameters | Monthly Downloads |
|------|-------|-------------|-----------|-------------------|
| 1 | Qwen3.8-2.4T-A95B | Alibaba (Qwen) | 2.4T (MoE) | 1,012 |
| 2 | DeepSeek-V4-Flash-0731 | DeepSeek | 304B | 1,431,587 |
| 3 | LFM2.5-2.6B | Liquid AI | 3B | 116,640 |

<details>
<summary>📄 Full prompt</summary>

使用浏览器找到 Hugging Face 热门大语言模型页面，记录排名前三的模型，包括模型名称、发布机构、参数规模、下载量或热度、是否支持中文。将结果保存到 huggingface_top3_models.md 文件中。

</details>

<details>
<summary>📄 Full report</summary>

See [huggingface_top3_models.md](assets/examples/huggingface_top3_models.md)

</details>

---

### Example 2: Complex Form Filling

> **Prompt**: "访问 London Business School Contact Us 页面，填写 9 个表单字段，检查校验结果，不提交。"

https://github.com/user-attachments/assets/c35831c2-4433-41fd-a71c-d6b271fb6746

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
<summary>📄 Full prompt</summary>

使用浏览器访问 London Business School 官方 Contact Us 页面：https://www.london.edu/about/contact

找到在线咨询表单，并填写以下信息：

- What's your question about?：Masters programmes
- Topic：Unspecified
- Email：kai.chen@example.com
- Title：Mr
- First Name：Kai
- Last Name：Chen
- Comment or enquiry details：I would like to know more about the application requirements for your master's programmes.
- Password：KaiMaster2026
- Confirm password：KaiMaster2026

完成所有字段填写，检查页面是否出现必填项、密码格式或字符长度等校验提示，但不要最终提交表单。

最后将填写内容、页面校验结果以及是否可以正常进入提交前状态，保存到 lbs_form_report.md 文件中。

</details>

<details>
<summary>📄 Full report with DOM constraint analysis</summary>

See [lbs_form_report.md](assets/examples/lbs_form_report.md)

</details>

---

### Example 3: Deep Research

> **Prompt**: "调查论文 *Generative Agents* 的代码复现情况，判断复现难度并说明原因。"

https://github.com/user-attachments/assets/ab84a6b5-94c9-4fb0-a2f5-6997d6200762

The agent performs multi-step research: navigates to the GitHub repo, checks issues, analyzes dependencies, evaluates code completeness, and generates a comprehensive reproducibility report.

**Result**: 🟡 Medium difficulty — code is complete but core OpenAI models (`text-davinci-002/003`) have been deprecated, dependencies are outdated, and the project is unmaintained (3 years, 115 open issues).

<details>
<summary>📄 Full prompt</summary>

使用浏览器调查论文《Generative Agents: Interactive Simulacra of Human Behavior》的代码复现情况。

找到论文对应的 GitHub 仓库，检查是否提供完整代码、依赖环境、运行说明、数据或示例，以及是否需要额外 API。再查看仓库最近更新时间和 Issues 中常见的复现问题。

最后判断该项目的复现难度属于容易 / 中等 / 困难，并说明主要原因。将调查结果整理并记录到一个 reproduction_report.md 文件中。

</details>

<details>
<summary>📄 Full reproducibility report</summary>

See [reproduction_report.md](assets/examples/reproduction_report.md)

</details>

---

## Benchmark

Evaluated on **WebVoyager** (109 tasks across 3 sites) with MiniMax M3:

| Metric | Value |
|--------|-------|
| Success Rate | **73.4%** |
| Completion Rate | 83.5% |
| Success Rate (completed only) | 87.9% |
| Avg Steps | 9.2 |
| Avg Cost per Task | $0.025 |
| KV Cache Hit Rate | 78.9% |
| Avg Duration | 150s |

### Per-Site Breakdown

| Site | Tasks | Success Rate | Avg Steps | Avg Cost |
|------|-------|-------------|-----------|----------|
| allrecipes.com | 35 | **80.0%** | 8.3 | $0.021 |
| apple.com | 35 | **74.3%** | 11.7 | $0.025 |
| amazon.com | 39 | **66.7%** | 7.8 | $0.028 |

<details>
<summary>📄 Full benchmark data</summary>

- [analysis.json](assets/benchmark/results/merged/analysis.json) — Summary statistics
- [webvoyager_judgments.json](assets/benchmark/results/merged/webvoyager_judgments.json) — Per-task LLM-as-a-Judge results
- [results.ndjson](assets/benchmark/results/merged/results.ndjson) — Raw execution traces

</details>

### Reproduce

```bash
# 1. Start OpenCode desktop app
bun run dev:desktop

# 2. Run benchmark (all tasks)
bun run assets/benchmark/run.ts

# Filter by site or limit task count
bun run assets/benchmark/run.ts --site allrecipes --count 10

# 3. Judge results with LLM-as-a-Judge
bun run assets/benchmark/judge.ts --run <run-id>
```

See `--help` for full options (model override, concurrency, timeout, etc.).

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

<details>
<summary>Full DOM — before clicking settings (113 lines)</summary>

See [dom-html.txt](assets/dom-comparison/dom-html.txt)

</details>

<details>
<summary>Full DOM — after clicking settings (186 lines)</summary>

See [dom-html-after.txt](assets/dom-comparison/dom-html-after.txt)

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
| `browser_start` | Launch browser and connect via CDP |
| `browser_goto` | Navigate to a URL |
| `browser_click` | Click elements by index `[N]` |
| `browser_input` | Fill text into input fields `<N>` |
| `browser_execute_script` | Run JavaScript |
| `browser_scroll_next_screen` | Scroll to discover content |
| `browser_scroll_to_page` | Scroll to a specific page position |
| `browser_reveal_offscreen` | Scroll to specific off-screen elements |
| `browser_view_elements` | Inspect images, tables, SVGs |
| `browser_new_tab` / `browser_switch_tab` / `browser_close_tab` | Tab management |
| `browser_refresh` / `browser_restore_state` | Reload or restore browser state |
| `browser_wait` | Wait for page changes |

### Project Structure (Browser Agent Module)

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
