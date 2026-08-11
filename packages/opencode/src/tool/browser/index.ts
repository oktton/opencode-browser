import { BrowserStartTool } from "./tools/start"
import { BrowserGotoTool, BrowserRefreshTool, BrowserRestoreStateTool } from "./tools/navigate"
import { BrowserNewTabTool, BrowserSwitchTabTool, BrowserCloseTabTool } from "./tools/tab"
import { BrowserClickTool, BrowserInputTool } from "./tools/interact"
import {
  BrowserRevealOffscreenTool,
  BrowserScrollNextScreenTool,
  BrowserScrollToPageTool,
} from "./tools/scroll"
import { BrowserExecuteScriptTool } from "./tools/script"
import { BrowserViewElementsTool } from "./tools/observe"
import { BrowserWaitTool } from "./tools/wait"

export { BrowserStartTool }

export const BrowserTools = [
  BrowserStartTool,
  BrowserGotoTool,
  BrowserRefreshTool,
  BrowserRestoreStateTool,
  BrowserNewTabTool,
  BrowserSwitchTabTool,
  BrowserCloseTabTool,
  BrowserClickTool,
  BrowserInputTool,
  BrowserRevealOffscreenTool,
  BrowserScrollNextScreenTool,
  BrowserScrollToPageTool,
  BrowserExecuteScriptTool,
  BrowserViewElementsTool,
  BrowserWaitTool,
]
