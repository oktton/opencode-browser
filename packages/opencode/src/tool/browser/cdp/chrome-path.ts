/**
 * Chrome executable discovery.
 *
 * Honours CHROME_PATH first, then the platform's default install locations.
 */

import * as fs from "fs"

export function findChromePath(): string {
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
          if (fs.existsSync(p)) return p
        } catch {}
      }
    }
  }
  return "google-chrome"
}
