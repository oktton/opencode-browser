import type { Browser, Page, CDPSession } from "puppeteer-core"
import { DomService } from "./dom/service.js"
import { CDPClient } from "./cdp/client.js"
import { findChromePath } from "./cdp/chrome-path.js"

export interface TabState {
  id: string
  page: Page
  cdpSession: CDPSession
  cdpClient: CDPClient
  domService: DomService
  lastDomId?: string
}

export class BrowserManager {
  private static instance: BrowserManager | null = null
  private browser: Browser | null = null
  private tabs = new Map<string, TabState>()
  private activeTabId: string | null = null
  private tabCounter = 0
  private pending = 0
  private chain: Promise<void> = Promise.resolve()

  static getInstance(): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager()
    }
    return BrowserManager.instance
  }

  static peekInstance(): BrowserManager | null {
    return BrowserManager.instance
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      const puppeteer = await import("puppeteer-core")
      const executablePath = findChromePath()
      this.browser = await puppeteer.default.launch({
        executablePath,
        headless: false,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
        ],
        defaultViewport: { width: 1280, height: 900 },
      })

      // Register tabs opened by the page itself (target="_blank", window.open, etc.)
      this.browser.on("targetcreated", async (target) => {
        if (target.type() !== "page") return
        const page = await target.page()
        if (!page) return
        for (const tab of this.tabs.values()) {
          if (tab.page === page) return
        }
        const id = `tab${this.tabCounter++}`
        const cdpSession = await page.createCDPSession()
        const cdpClient = new CDPClient(cdpSession)
        const domService = new DomService(page, cdpClient)
        this.tabs.set(id, { id, page, cdpSession, cdpClient, domService })
      })
    }
    return this.browser
  }

  async newTab(url?: string): Promise<TabState> {
    const browser = await this.ensureBrowser()
    const id = `tab${this.tabCounter++}`

    const page = await browser.newPage()
    const cdpSession = await page.createCDPSession()
    const cdpClient = new CDPClient(cdpSession)
    const domService = new DomService(page, cdpClient)

    const tab: TabState = { id, page, cdpSession, cdpClient, domService }
    this.tabs.set(id, tab)
    this.activeTabId = id

    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {})
    }

    return tab
  }

  async switchTab(tabId: string): Promise<TabState> {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error(`Tab ${tabId} not found`)
    this.activeTabId = tabId
    await tab.page.bringToFront()
    return tab
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return

    await tab.domService.destroySettle()
    await tab.cdpClient.cleanup()
    await tab.page.close()
    this.tabs.delete(tabId)

    if (this.activeTabId === tabId) {
      const remaining = [...this.tabs.keys()]
      if (remaining.length > 0) {
        await this.switchTab(remaining[remaining.length - 1])
      } else {
        this.activeTabId = null
      }
    }
  }

  async syncActiveTab(): Promise<void> {
    // Clean up closed pages
    for (const [tabId, tab] of this.tabs) {
      if (tab.page.isClosed()) {
        await tab.domService.destroySettle().catch(() => {})
        await tab.cdpClient.cleanup().catch(() => {})
        this.tabs.delete(tabId)
        if (this.activeTabId === tabId) this.activeTabId = null
      }
    }
    // Pick a fallback if active was closed
    if (!this.activeTabId && this.tabs.size > 0) {
      this.activeTabId = [...this.tabs.keys()].pop()!
    }
    if (this.tabs.size <= 1) return
    // Find the visible (topmost) tab
    for (const [tabId, tab] of this.tabs) {
      try {
        const visible = await tab.page.evaluate(() => document.visibilityState === "visible")
        if (visible) {
          this.activeTabId = tabId
          return
        }
      } catch {}
    }
  }

  getActiveTab(): TabState {
    this.ensureStarted()
    if (!this.activeTabId) throw new Error("No active tab. Call browser_start first to enter browser mode.")
    const tab = this.tabs.get(this.activeTabId)
    if (!tab) throw new Error("Active tab not found")
    return tab
  }

  getTab(tabId: string): TabState | undefined {
    return this.tabs.get(tabId)
  }

  listTabs(): { id: string; title: string; url: string; isActive: boolean }[] {
    return [...this.tabs.values()].map((tab) => ({
      id: tab.id,
      title: tab.page.url(),
      url: tab.page.url(),
      isActive: tab.id === this.activeTabId,
    }))
  }

  hasActiveTab(): boolean {
    return this.activeTabId !== null && this.tabs.has(this.activeTabId)
  }

  isStarted(): boolean {
    return this.browser !== null && this.browser.connected
  }

  async detectStateChanges(): Promise<{ tabId: string; lastUrl: string; currentUrl: string }[]> {
    if (!this.browser || !this.browser.connected) return []
    const changes: { tabId: string; lastUrl: string; currentUrl: string }[] = []
    for (const [tabId, tab] of this.tabs) {
      if (tab.page.isClosed() || !tab.lastDomId) continue
      const lastUrl = tab.domService.getCachedUrl(tab.lastDomId)
      if (!lastUrl) continue
      try {
        const currentUrl = tab.page.url()
        if (currentUrl !== lastUrl) {
          changes.push({ tabId, lastUrl, currentUrl })
        }
      } catch {}
    }
    return changes
  }

  ensureStarted(): void {
    if (!this.browser) throw new Error("Browser not started. Call browser_start first to enter browser mode.")
    if (!this.browser.connected) {
      this.reset()
      throw new Error("Browser was closed. Call browser_start again to re-enter browser mode.")
    }
  }

  private reset(): void {
    this.tabs.clear()
    this.activeTabId = null
    this.browser = null
  }

  async enqueue<T>(fn: (isLast: () => boolean) => Promise<T>): Promise<T> {
    this.pending++
    const prev = this.chain
    let resolve!: () => void
    this.chain = new Promise<void>((r) => { resolve = r })
    await prev
    try {
      return await fn(() => this.pending === 1)
    } finally {
      this.pending--
      resolve()
    }
  }

  async cleanup(): Promise<void> {
    for (const tab of this.tabs.values()) {
      await tab.domService.destroySettle()
      await tab.cdpClient.cleanup()
    }
    this.tabs.clear()
    this.activeTabId = null
    if (this.browser) {
      await this.browser.close()
    }
    this.browser = null
    BrowserManager.instance = null
  }
}
