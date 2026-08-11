<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
paru -S opencode-bin               # Arch Linux
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                              |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm`, or AppImage           |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also, included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as a part of its name; for example, "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

### Browser Tools (Experimental)

OpenCode includes built-in browser automation tools powered by CDP (Chrome DevTools Protocol). The AI agent can open a real Chrome browser, navigate pages, read DOM structures, click elements, fill forms, and more — all without leaving the terminal.

#### Setup

1. **Install Chrome** — the system Chrome is used automatically (`C:\Program Files\Google\Chrome\Application\chrome.exe` on Windows, `/Applications/Google Chrome.app` on macOS, `google-chrome` on Linux). Set `CHROME_PATH` to override.

2. **Install puppeteer-core** — already included as a dependency.

3. **Enable the feature flag**:
   ```bash
   # Environment variable
   OPENCODE_EXPERIMENTAL_BROWSER=true opencode

   # PowerShell
   $env:OPENCODE_EXPERIMENTAL_BROWSER = "true"; opencode
   ```

#### Available Tools

| Tool | Description |
|------|-------------|
| `browser_goto` | Navigate to a URL. Opens a Chrome window if not already open. |
| `browser_refresh` | Refresh the current page. |
| `browser_restore_state` | Return to a previous page state by stateId. |
| `browser_click` | Click an element marked with `[N]` in the DOM output. |
| `browser_input` | Fill text into an input field marked with `<N>`. Supports `pressEnter` and `clear` options. |
| `browser_execute_script` | Run JavaScript in the page context with built-in helpers (`__q`, `__find`, `__get`). |
| `browser_screenshot` | Capture a full-page screenshot. |
| `browser_view_elements` | Screenshot specific visual elements (`[view:ID]` markers — images, tables, SVGs). |
| `browser_reveal_offscreen` | Scroll to make an off-screen element visible. |
| `browser_scroll_explore` | Scroll one viewport to discover new content. |
| `browser_scroll_to_page` | Jump to a specific page number in a scrollable container. |
| `browser_new_tab` | Open a new browser tab, optionally navigating to a URL. |
| `browser_switch_tab` | Switch to a different tab by ID. |
| `browser_close_tab` | Close one or more tabs. |
| `browser_wait` | Wait for a specified duration (useful after dynamic content loads). |

#### How It Works

- **DOM extraction**: Every tool that modifies the page returns a structured DOM snapshot in its output. The DOM is pruned, indexed, and serialized so the AI can understand page structure.
- **Element indices**: Interactive elements are marked with `[N]` (clickable) or `<N>` (fillable input) in the DOM output. The AI uses these indices to target clicks and inputs.
- **Incremental diff**: When less than 30% of elements change, only the diff is shown (`+|` added, `-|` removed), saving context tokens.
- **DOM omission**: Old DOM snapshots are automatically replaced with lightweight placeholders, keeping only the latest full DOM and any incremental diff chain. The agent can restore previous states with `browser_restore_state`.
- **Scroll containers**: Off-screen elements show `<!-- above/below viewport [container:N] -->` markers. The scroll map tracks explored vs unexplored pages per container.

#### Example Usage

Just ask the agent naturally:

```
> Go to https://news.ycombinator.com and find the top 3 stories about AI
> Open https://example.com and click the "More information" link
> Search for "opencode" on GitHub and tell me the star count
```

The agent will automatically use the appropriate browser tools to complete the task.

### FAQ

#### How is this different from Claude Code?

It's very similar to Claude Code in terms of capability. Here are the key differences:

- 100% open source
- Not coupled to any provider. Although we recommend the models we provide through [OpenCode Zen](https://opencode.ai/zen); OpenCode can be used with Claude, OpenAI, Google or even local models. As models evolve the gaps between them will close and pricing will drop so being provider-agnostic is important.
- Out of the box LSP support
- A focus on TUI. OpenCode is built by neovim users and the creators of [terminal.shop](https://terminal.shop); we are going to push the limits of what's possible in the terminal.
- A client/server architecture. This for example can allow OpenCode to run on your computer, while you can drive it remotely from a mobile app. Meaning that the TUI frontend is just one of the possible clients.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
