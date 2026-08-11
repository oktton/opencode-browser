import type { Browser, Page, CDPSession } from "puppeteer-core"
import { DomService } from "./dom/service.js"
import { CDPClient } from "./cdp/client.js"

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

  static getInstance(): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager()
    }
    return BrowserManager.instance
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      const puppeteer = await import("puppeteer-core")
      const executablePath = this.findChromePath()
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
    }
    return this.browser
  }

  private findChromePath(): string {
    if (process.platform === "win32") {
      const paths = [
        process.env.CHROME_PATH,
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      ]
      for (const p of paths) {
        if (p) {
          try {
            const fs = require("fs")
            if (fs.existsSync(p)) return p
          } catch {}
        }
      }
    } else if (process.platform === "darwin") {
      return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    } else {
      const paths = [
        process.env.CHROME_PATH,
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
      ]
      for (const p of paths) {
        if (p) {
          try {
            const fs = require("fs")
            if (fs.existsSync(p)) return p
          } catch {}
        }
      }
    }
    return "google-chrome"
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

  getActiveTab(): TabState {
    if (!this.activeTabId) throw new Error("No active tab")
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
