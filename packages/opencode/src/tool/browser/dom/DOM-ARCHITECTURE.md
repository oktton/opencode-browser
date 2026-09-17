# DOM 提取与序列化架构文档

本文档详细描述 `src/main/dom/` 模块的核心逻辑，包括 HTML 和 Markdown 两条转化管线、关键数据结构（RenderInfo）、过滤裁剪机制以及最终渲染流程。

---

## 目录

1. [目录结构](#目录结构)
2. [整体数据流](#整体数据流)
3. [核心数据结构](#核心数据结构)
4. [HTML 序列化管线](#html-序列化管线)
5. [Markdown 渲染管线](#markdown-渲染管线)
6. [过滤与裁剪机制](#过滤与裁剪机制)
7. [最终渲染](#最终渲染)

---

## 目录结构

```
src/main/dom/
├── service.ts                 # 主入口，编排两条管线
├── cdp/                       # Chrome DevTools Protocol 通信层
│   ├── client.ts             # 封装 WebContents.debugger API
│   ├── commands.ts           # 批量 CDP 命令执行（getAllTrees）
│   └── oopif-manager.ts      # 跨域 iframe (OOPIF) 会话管理
├── types/                     # 核心类型定义
│   ├── dom-node.ts           # EnhancedDOMTreeNode, RenderInfo, NodeType
│   ├── snapshot.ts           # EnhancedSnapshotNode, SnapshotLookup
│   ├── ax.ts                 # 无障碍树类型 (AX Tree)
│   └── cdp.ts                # CDP 协议原始类型
├── tree/                      # DOM 树构建与处理
│   ├── builder.ts            # DOMTreeBuilder — 构建增强 DOM 树
│   ├── render-info.ts        # 计算 RenderInfo，top-element 检测
│   ├── pruner.ts             # HTML 管线专用裁剪器
│   ├── inline-merger.ts      # 合并连续 inline 元素
│   ├── clickable-detector.ts # 交互元素检测
│   ├── highlight.ts          # 分配索引 [N]，注入页面高亮
│   ├── visibility.ts         # 多帧可见性检查
│   ├── attributes.ts         # 属性白名单过滤
│   └── xpath.ts              # XPath 生成（含 [IFRAME]/[SHADOW] 边界标记）
├── serializer/               # HTML 序列化
│   └── renderer.ts           # 渲染为 [N]/<N> 格式
├── markdown/                 # Markdown 文本渲染
│   ├── renderer.ts           # 树 → 缩进文本
│   ├── pruner.ts             # Markdown 专用裁剪规则
│   └── ai-text.ts            # 30+ 元素处理器，节点 → AI 文本
├── snapshot/                 # 快照解析
│   └── lookup.ts             # CDP DOMSnapshot → EnhancedSnapshotNode 映射
└── utils/                    # 工具函数
    └── index.ts              # 调试保存、UUID、克隆、扁平化
```

---

## 整体数据流

系统提供两条独立管线，共享树构建阶段，但裁剪和渲染逻辑完全不同：

```
               ┌─────────────────────────────────────────────┐
               │            service.ts (入口)                 │
               │                                             │
               │  getSerializedDomTree()  │  getMarkdown()   │
               └────────┬────────────────────┬───────────────┘
                        │                    │
                   ┌────▼────────────────────▼────┐
                   │     共享阶段：树构建           │
                   │                              │
                   │  1. waitForPageReady()        │
                   │  2. commands.getAllTrees()     │
                   │  3. DOMTreeBuilder.build()    │
                   └────┬────────────────────┬────┘
                        │                    │
          ┌─────────────▼──────┐    ┌───────▼──────────────┐
          │   HTML 管线        │    │   Markdown 管线       │
          │                    │    │                      │
          │  4. computeRenderInfo  │    │  4. pruneForMarkdown  │
          │  5. pruneTree      │    │  5. renderToMarkdown  │
          │  6. assignAndHighlight │    │                      │
          │  7. renderToHtml   │    └──────────────────────┘
          └────────────────────┘
```

### 关键区别

| 维度            | HTML 管线                            | Markdown 管线      |
| --------------- | ------------------------------------ | ------------------ |
| RenderInfo 计算 | 完整计算（交互性、topElement、候选） | 不计算             |
| 裁剪策略        | 基于候选元素（isCandidate）          | 基于内容和 AX 角色 |
| 元素索引        | 分配 `[N]`/`<N>` 高亮索引            | 无索引             |
| 页面高亮        | 注入 overlay 脚本                    | 无副作用           |
| 输出格式        | `[N]<tag attrs> text </tag>`         | 缩进的 AI 文本描述 |
| 用途            | Agent 交互操作（点击、输入）         | 信息提取、页面理解 |

---

## 核心数据结构

### EnhancedDOMTreeNode（`types/dom-node.ts:48`）

DOM 树的核心节点类型，融合了 CDP DOM 树、无障碍树 (AX)、DOMSnapshot 三种数据源：

```typescript
interface EnhancedDOMTreeNode {
  // --- 身份标识 ---
  nodeId: number; // CDP 节点 ID
  backendNodeId: number; // CDP 后端节点 ID（全局唯一）
  nodeType: NodeType; // DOM 节点类型枚举
  nodeName: string; // 标签名（如 "DIV", "INPUT"）
  nodeValue: string; // 文本内容（TEXT_NODE 时有值）
  attributes: Record<string, string>; // 原始 HTML 属性
  // (uuid removed — it was written per node but never read)

  // --- 可见性 ---
  isVisible: boolean; // 综合 CSS + 多帧视口判断

  // --- 定位 ---
  absolutePosition?: DOMRect; // 绝对位置（含 iframe 偏移累加）

  // --- 帧上下文 ---
  frameId?: string; // CDP 帧标识
  oopifSessionId?: string; // 跨域 iframe 的 CDP 会话 ID

  // --- 子文档 / Shadow DOM ---
  contentDocument?: EnhancedDOMTreeNode; // iframe 内容文档
  shadowRootType?: ShadowRootType;
  shadowRoots?: EnhancedDOMTreeNode[];

  // --- 数据源 ---
  axNode?: EnhancedAXNode; // 无障碍树节点
  snapshotNode?: EnhancedSnapshotNode; // DOMSnapshot 布局/样式数据
  whitelistedAttributes?: Record<string, string>; // 过滤后的属性子集

  // --- 渲染信息 ---
  renderInfo: RenderInfo; // 核心：决定节点如何被序列化

  // --- 导航 ---
  xpath?: string; // 完整 XPath（含 [SHADOW]/[IFRAME] 前缀）
  parentNode?: EnhancedDOMTreeNode;
  childrenNodes?: EnhancedDOMTreeNode[];
}
```

### RenderInfo（`types/dom-node.ts:113`）

**渲染决策的核心属性**，决定节点是否出现在最终输出中以及如何标记：

```typescript
interface RenderInfo {
  // --- 交互检测 ---
  isInteractive: boolean; // 是否可交互（按钮/输入/链接等）
  interactiveReason?: string; // 判定原因（调试用）

  // --- 可见性检测 ---
  isTopElement: boolean; // elementFromPoint 命中检测，未被遮挡

  // --- 结构标记 ---
  isShadowHost: boolean; // 是否拥有 Shadow Root
  isIframeHost: boolean; // 是否拥有 contentDocument

  // --- 候选决策 ---
  isCandidate?: boolean; // = isInteractive && isTopElement
  isFill?: boolean; // 可填充（textarea, input[text] 等）

  // --- 事件监听器去重 ---
  isDuplicateListener?: boolean; // 点击监听器是祖先的子集
  clickListenerSignatures?: string[]; // 监听器签名列表

  // --- 高亮索引 ---
  highlightIndex?: number; // 最终分配的 [0], [1], [2]...

  // --- 调试 ---
  pruneReason?: string; // 裁剪原因（仅在调试副本上）
}
```

**RenderInfo 的计算流程**（`tree/render-info.ts`）：

```
Step 1: initRenderInfo()
  ├─ 遍历所有节点
  ├─ 调用 ClickableElementDetector.isInteractive() → isInteractive
  ├─ 调用 ClickableElementDetector.isFillable() → isFill
  └─ 标记 isShadowHost, isIframeHost

Step 2: checkTopElements()
  ├─ 收集所有 isVisible 且有 bounds 的节点
  ├─ 对每个节点的中心点调用 document.elementFromPoint(x, y)
  ├─ 通过 CDP 获取命中元素的 backendNodeId
  └─ 判断命中节点是 self / ancestor / descendant → isTopElement

Step 3: markInteractiveCandidates()
  └─ isCandidate = isInteractive && isTopElement
```

### EnhancedSnapshotNode（`types/snapshot.ts:12`）

从 CDP DOMSnapshot 提取的布局和样式信息：

```typescript
interface EnhancedSnapshotNode {
  isClickable: boolean; // CDP 报告的可点击标志
  cursorStyle?: string; // CSS cursor 值（'pointer', 'text' 等）
  bounds?: DOMRect; // 边界框（已转换为 CSS 像素）
  clientRects?: DOMRect; // 视口尺寸
  scrollRects?: DOMRect; // 滚动偏移
  computedStyles?: Record<string, string>; // display, visibility, opacity 等
  paintOrder?: number; // 绘制顺序
  inputValue?: string; // input/textarea 的当前值
}
```

**坐标转换**：CDP 返回的是设备像素，`snapshot/lookup.ts:54` 中通过 `devicePixelRatio` 转换为 CSS 像素：

```typescript
// parseBounds() — snapshot/lookup.ts:54
return {
  x: bounds[0] / devicePixelRatio,
  y: bounds[1] / devicePixelRatio,
  width: bounds[2] / devicePixelRatio,
  height: bounds[3] / devicePixelRatio,
};
```

---

## HTML 序列化管线

### 阶段 1：页面就绪等待（`service.ts:159`）

```
waitForPageReady(quietWindow=500ms, maxWaitTime=4000ms)
  ├─ 等待 webContents 停止加载（did-stop-loading 事件）
  └─ 注入 MutationObserver：500ms 无 DOM 变更即视为稳定
```

### 阶段 2：CDP 数据采集（`cdp/commands.ts`）

```
getAllTrees()
  ├─ DOMSnapshot.captureSnapshot   → 布局、样式、边界框
  ├─ DOM.getDocument(depth:-1)     → 完整 DOM 树结构
  ├─ Accessibility.getFullAXTree   → 无障碍树
  ├─ Runtime.evaluate(devicePixelRatio) → 像素比
  └─ OOPIFManager.discoverOOPIFs   → 跨域 iframe 子树
```

### 阶段 3：树构建（`tree/builder.ts:89`）

`DOMTreeBuilder.constructEnhancedNode()` 递归构建增强节点：

1. 查找并关联 AX 节点和 Snapshot 数据
2. 解析 HTML 属性、计算白名单属性
3. 计算绝对位置（累加 iframe 偏移）
4. 执行多帧可见性检查（`visibility.ts`）
5. 生成 XPath（含 `[IFRAME]` / `[SHADOW]` 边界标记）
6. 递归处理 children、shadowRoots、contentDocument
7. 处理 OOPIF 子树（创建子 DOMTreeBuilder）

### 阶段 4：RenderInfo 计算（`tree/render-info.ts`）

详见上文 RenderInfo 计算流程。

### 阶段 5：树裁剪（`tree/pruner.ts`）

详见[过滤与裁剪机制 - HTML 裁剪](#html-管线裁剪treeprunerts)。

### 阶段 6：索引分配与高亮（`tree/highlight.ts`）

```
assignAndHighlight()
  ├─ deduplicateByEventListeners()   // 事件监听器去重
  │   ├─ 并行获取所有候选节点的点击监听器签名
  │   │   ├─ CDP DOMDebugger.getEventListeners → native:scriptId:line:col
  │   │   └─ Runtime.callFunctionOn → React/Vue/jQuery handler toString
  │   └─ DFS：若后代的监听器集合是祖先的子集 → isDuplicateListener=true
  │
  ├─ assignHighlightIndices()        // 分配序号
  │   └─ DFS 遍历：isCandidate && !isDuplicateListener → highlightIndex=0,1,2...
  │
  └─ highlightElements()            // 页面注入高亮
      ├─ 为每个候选节点设置 data-hl-idx 属性
      └─ 注入 JS overlay 脚本（固定定位 + scroll/resize 监听）
```

### 阶段 7：HTML 渲染（`serializer/renderer.ts`）

递归遍历树，输出格式：

```
[N]<tag attrs> text </tag>     ← 候选，仅可点击（highlightIndex 存在，isFill=false）
<N><tag attrs> text </tag>     ← 候选，可填充（highlightIndex 存在，isFill=true）
<tag> text </tag>              ← 非候选但 isTopElement（作为上下文展示）
```

**关键渲染规则**（`renderer.ts`）：

1. **非 isTopElement 的节点**：跳过自身，直接递归子节点（`renderer.ts:103`）
2. **文本收集**：`getAllTextTillNextCandidate()` — 收集到下一个候选节点前的所有文本（`renderer.ts:23`）
3. **属性去重**：`buildAttributesString()` — 若属性值包含文本则隐藏文本，若文本包含属性值则删除属性（`renderer.ts:54`）
4. **祖先文本消费**：`hasHighlightedAncestor()` — 若祖先已有 highlightIndex 则跳过文本节点（`renderer.ts:39`）
5. **role 去重**：若 `role === tagName` 则删除 role 属性（`renderer.ts:64`）

---

## Markdown 渲染管线

### 裁剪：`markdown/pruner.ts`

详见[过滤与裁剪机制 - Markdown 裁剪](#markdown-管线裁剪markdownprunerts)。

### 渲染：`markdown/renderer.ts`

非常简洁 — 遍历树，对每个 ELEMENT/DOCUMENT/DOCUMENT_FRAGMENT 节点调用 `convertNodeToAiText()`，以 tab 缩进输出：

```typescript
// markdown/renderer.ts:21
function renderNode(node, depth, lines) {
  if (node.nodeType in [ELEMENT, DOCUMENT, DOCUMENT_FRAGMENT]) {
    const { text } = convertNodeToAiText(node);
    lines.push(indent(depth) + text);
  }
  for (const child of node.childrenNodes ?? []) {
    renderNode(child, depth + 1, lines);
  }
}
```

### AI 文本转化：`markdown/ai-text.ts`

30+ 元素处理器，每种元素/角色有专门的文本格式：

| 元素/角色                 | 输出示例                                                           |
| ------------------------- | ------------------------------------------------------------------ |
| `<button>`                | `BUTTON: 保存 [disabled] (title: 保存更改)`                        |
| `<input type="text">`     | `INPUT[text]: 用户名 \| john_doe [required] (placeholder: 请输入)` |
| `<input type="password">` | `INPUT[password]: 密码 \| ******** [required]`                     |
| `<input type="checkbox">` | `CHECKBOX: 同意条款 = checked [disabled]`                          |
| `<input type="radio">`    | `RADIO: 选项A (name=choice) = checked`                             |
| `<input type="range">`    | `SLIDER: 音量 = 50 (min=0, max=100)`                               |
| `<textarea>`              | `TEXTAREA: 消息 \| "Hello\nWorld" [readonly, 5/100 chars]`         |
| `<select>`                | `SELECT: 颜色 = 红色 (name: color_select)`                         |
| `<a>`                     | `LINK: 点击这里`                                                   |
| `<img>`                   | `IMAGE: 日落照片`                                                  |
| `<h1>` ~ `<h6>`           | `# 标题` ~ `###### 标题`                                           |
| `<progress>`              | `PROGRESS: 加载中 = 75% (value=75, max=100)`                       |
| `<meter>`                 | `METER: 存储 = 80% [optimal] (min=0, low=20, high=80, max=100)`    |
| `<details>`               | `DETAILS: 详情 [open]`                                             |
| `<video>`                 | `VIDEO: 演示视频 [controls, autoplay]`                             |
| `role="combobox"`         | `COMBOBOX: 搜索 \| value [expanded=true]`                          |
| `role="switch"`           | `SWITCH: 暗色模式 = on`                                            |
| `role="tab"`              | `TAB: 设置 [selected=true, controls=panel-1]`                      |
| `role="spinbutton"`       | `SPINBUTTON: 数量 = 5 (min=0, max=99)`                             |

**处理器查找优先级**（`ai-text.ts:1089`）：

```
1. ARIA role → ROLE_HANDLERS (button, combobox, switch, tab, spinbutton, slider)
2. input type → INPUT_TYPE_HANDLERS (text, email, password, checkbox, radio, range...)
3. tag name → TAG_HANDLERS (button, a, img, h1-h6, textarea, select, p, span...)
4. fallback → handleGenericElement → "TAG: text"
```

**文本来源**（`ai-text.ts:44`）：

`getDirectTextContent()` 从两个来源提取文本：

- `axNode.name`（当角色属于 NAME_FROM_CONTENT_ROLES 时）
- 直接子节点中 `role=StaticText` 的 `axNode.name`

**输出格式三部分**：

```
TYPE: label | value [state_flags] (context_info)
  │     │      │         │              │
  │     │      │         │              └─ title, placeholder, aria-label, name 等
  │     │      │         └─ disabled, readonly, required, checked 等
  │     │      └─ 当前值（input value, checked state 等）
  │     └─ 从 text / aria-label / title / placeholder 获取
  └─ BUTTON / INPUT[text] / CHECKBOX / LINK / IMAGE 等
```

---

## 过滤与裁剪机制

### 可见性过滤（`tree/visibility.ts`）

**三层检查**：

1. **CSS 可见性**（`visibility.ts:30`）：
   - `display !== 'none'`
   - `visibility !== 'hidden'`
   - `opacity > 0`

2. **边界框存在**：无 `bounds` 数据的节点不可见

3. **多帧视口交叉**（`visibility.ts:66`）：
   - 从内向外遍历所有祖先 HTML 帧节点
   - 对每个帧计算元素相对于视口的位置（考虑滚动偏移）
   - 检查交叉，允许 ±100px 容差（视口外略微可见的元素仍保留）

### 交互性检测（`tree/clickable-detector.ts`）

`ClickableElementDetector.isInteractive()` 依次检查：

| 优先级 | 检查项                                 | 示例                                                                                                    |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1      | 排除非元素节点                         | TEXT_NODE 跳过                                                                                          |
| 2      | 排除 html/body                         | 始终跳过                                                                                                |
| 3      | iframe/frame（尺寸 > 100x100）         | 大 iframe 可交互                                                                                        |
| 4      | disabled / aria-disabled / aria-hidden | 返回 false                                                                                              |
| 5      | INTERACTIVE_TAGS                       | button, input, select, textarea, a, details, summary, option, optgroup                                  |
| 6      | INTERACTIVE_ATTRIBUTES                 | onclick, onmousedown, onmouseup, onkeydown, onkeyup                                                     |
| 7      | INTERACTIVE_ROLES                      | button, link, menuitem, checkbox, radio, tab, textbox, combobox, slider, spinbutton, searchbox, listbox |
| 8      | cursor: pointer                        | CSS 指针样式                                                                                            |
| 9      | cursor: text（无子元素有相同样式）     | 文本输入区域                                                                                            |
| 10     | isClickable（CDP 标志，无可点击后代）  | CDP 报告的可点击性                                                                                      |

`ClickableElementDetector.isFillable()` 判定可填充元素：

- `<textarea>` → 始终可填充
- `<input>` → 排除 button/submit/reset/image/checkbox/radio/file/hidden
- `contenteditable="true"` → 可填充
- `role="textbox"` → 可填充
- `cursor: text`（无子元素有相同样式）→ 可填充

### 属性白名单过滤（`tree/attributes.ts`）

`getWhitelistedAttributes()` 使用分层白名单策略：

```
全局白名单: role, aria-label, aria-labelledby, title, disabled, id
     │
     ├─ 重要 data 属性: data-testid, data-id, data-value, data-label, data-name 等
     │
     ├─ ARIA 属性（仅当有 role 时）: aria-checked, aria-selected, aria-expanded 等
     │
     └─ 标签特定白名单:
        ├─ input[text]: name, value, placeholder, readonly, required, maxlength
        ├─ input[checkbox]: name, value, checked, aria-checked
        ├─ textarea: name, value, placeholder, readonly, required, maxlength, rows, cols
        ├─ select: name, value, multiple, aria-expanded
        ├─ button: type, aria-pressed
        ├─ img: alt
        ├─ a: （排除 href）
        └─ ... 更多标签
```

特殊规则：

- `<input type="hidden">` → 返回空对象（`attributes.ts:112`）
- `<a>` / `role="link"` → 删除 href（`attributes.ts:134`）
- `role="slider"` → 额外保留 value 和 aria-value\* 属性

### 内联元素合并（`tree/inline-merger.ts`）

在裁剪之前运行，减少树复杂度：

```
合并前:
<div>
  <span display:inline> "Hello " </span>
  <em display:inline> "world" </em>
  <strong display:inline> "!" </strong>
</div>

合并后:
<div>
  <span display:inline> "Hello world!" </span>  ← 文本写入第一个 TEXT_NODE
  <em display:inline> </em>                      ← 其他 TEXT_NODE 被移除
  <strong display:inline> </strong>
</div>
```

**判定条件**（`inline-merger.ts:57`）：

```typescript
function isInlineDisplay(node): boolean {
  const display = node.snapshotNode?.computedStyles?.display;
  return display === 'inline' || display === 'flow-root';
}
```

需要 2+ 连续 inline 兄弟节点才触发合并。底部向上处理（先合并子节点再合并父节点）。

### HTML 管线裁剪（`tree/pruner.ts`）

**前处理**：

1. `mergeInlineNodes()` — 合并连续 inline 元素
2. `flattenBoundaries()` — 将 shadowRoots 和 contentDocument 的子节点展平到 childrenNodes

**裁剪规则**（底部向上，迭代直到无变化）：

```
对每个节点（非根节点），按顺序检查：

1. TEXT_NODE && isTopElement → 保留
2. isCandidate → 检查有无内容：
   ├─ 有内容（文本或白名单属性）→ 保留
   └─ 无内容 → 移除候选标记，继续检查
3. isOnlyChild → 展开（用子节点替换自身）
4. hasNoChildren → 展开（空叶节点）
5. 子树无任何候选 → 展开
6. 默认 → 保留
```

### Markdown 管线裁剪（`markdown/pruner.ts`）

同样先执行 `mergeInlineNodes()` 和 `flattenBoundaries()`，然后：

```
对每个节点，按顺序检查：

1. Name-from-Content 角色（button, link, heading 等）
   → 剪除子树（axNode.name 已聚合文本），保留自身

2. StaticText 角色 → 保留

3. IMG 标签 → 展开（移除自身，保留子节点）

4. 自身无内容 && 子树无内容 → 完全移除

5. 非唯一子节点（排除 StaticText 兄弟）→ 保留

6. 唯一子节点的过滤规则：
   ├─ axNode.ignored → 展开
   ├─ inline hidden (display:none / visibility:hidden) → 展开
   ├─ aria-hidden="true" → 展开
   ├─ 自身无内容 → 展开
   └─ 默认 → 保留
```

**两个管线裁剪的核心区别**：

| 维度     | HTML 裁剪                  | Markdown 裁剪                  |
| -------- | -------------------------- | ------------------------------ |
| 保留依据 | isCandidate（交互 + 可见） | 是否有可展示内容               |
| 子树处理 | 仅在无候选时展开           | Name-from-Content 直接剪除子树 |
| IMG 处理 | 正常处理                   | 直接展开移除                   |
| AX 利用  | 不直接使用                 | 利用 role 和 ignored 判定      |

---

## 最终渲染

### HTML 渲染输出示例

```
[0]<button type='submit'> 登录 </button>
<div>
    [1]<a aria-label='首页'> 首页 </a>
    [2]<a> 关于我们 </a>
    <3><input name='username' placeholder='请输入用户名'></input>
    <4><textarea placeholder='留言'></textarea>
    欢迎来到我们的网站
    [5]<button> 提交 </button>
</div>
```

- `[N]` = 可点击元素（`isFill=false`）
- `<N>` = 可填充元素（`isFill=true`）
- 无标记 = 上下文文本（`isTopElement=true` 但非候选）
- tab 缩进表示 DOM 层级

### Markdown 渲染输出示例

```
html
    body
        nav
            BUTTON: 登录 (title: 用户登录)
            LINK: 首页
            LINK: 关于我们
        main
            ## 欢迎
            INPUT[text]: 用户名 | empty [required] (placeholder: 请输入用户名)
            TEXTAREA: 留言 | empty (rows=5, max=500 chars)
            BUTTON[submit]: 提交
```

- 每行一个节点，tab 缩进表示层级
- 元素类型大写标识（BUTTON, INPUT, LINK...）
- 包含状态、值和上下文信息

---

## 附录：完整管线流程图

### HTML 管线

```
WebContents
    │
    ▼
CDPClient.attach()
    │
    ▼
OOPIFManager.discoverOOPIFs()      ← 发现跨域 iframe
    │
    ▼
waitForPageReady()                  ← MutationObserver 等待稳定
    │
    ▼
CDPCommands.getAllTrees()            ← DOMSnapshot + DOM + AX + devicePixelRatio
    │
    ▼
DOMTreeBuilder.build()              ← 递归构建 EnhancedDOMTreeNode 树
    │                                  （融合 DOM/AX/Snapshot，计算可见性和 XPath）
    ▼
computeRenderInfo()
    ├─ initRenderInfo()             ← isInteractive, isFill, isShadowHost, isIframeHost
    ├─ checkTopElements()           ← elementFromPoint → isTopElement
    └─ markInteractiveCandidates()  ← isCandidate = isInteractive && isTopElement
    │
    ▼
pruneTree()
    ├─ mergeInlineNodes()           ← 合并连续 inline 兄弟
    ├─ flattenBoundaries()          ← 展平 shadow/iframe 边界
    └─ 迭代裁剪                     ← only-child / empty-leaf / no-candidate 规则
    │
    ▼
assignAndHighlight()
    ├─ deduplicateByEventListeners() ← 对比点击监听器签名，标记重复
    ├─ assignHighlightIndices()     ← DFS 分配 [0], [1], [2]...
    └─ highlightElements()          ← 设置 data-hl-idx + 注入 overlay JS
    │
    ▼
renderToHtml()                      ← 递归输出 [N]/<N> 格式文本
    │
    ▼
{ html: string, selectorMap: Map<number, EnhancedDOMTreeNode> }
```

### Markdown 管线

```
WebContents
    │
    ▼
CDPClient.attach() → OOPIFManager → waitForPageReady() → getAllTrees()
    │
    ▼
DOMTreeBuilder.build()              ← 同 HTML 管线
    │
    ▼
pruneForMarkdown()
    ├─ mergeInlineNodes()           ← 合并连续 inline 兄弟
    ├─ flattenBoundaries()          ← 展平 shadow/iframe 边界
    └─ 迭代裁剪                     ← name-from-content / no-content / only-child 规则
    │
    ▼
renderToMarkdown()
    └─ convertNodeToAiText()        ← 30+ 处理器，按 role → inputType → tagName 查找
    │
    ▼
string（缩进 AI 文本）
```
