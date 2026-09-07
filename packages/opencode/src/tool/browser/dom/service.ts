/**
 * DOM Service
 *
 * Main entry point for DOM extraction and serialization.
 * Provides high-level API for getting DOM trees and serialized states.
 */

import type { Page } from 'puppeteer-core';
import { CDPClient } from '../cdp/client';
import { CDPCommands } from '../cdp/commands';
import { OOPIFManager } from '../cdp/oopif-manager';
import { DOMTreeBuilder } from './tree/builder';
import { renderToHtml } from './serializer/renderer';
import {
  computeRenderInfo,
  elementFromPoint,
  type ComputeRenderInfoOptions,
} from './tree/render-info';
import {
  buildScrollContainerMap,
  type ScrollContainerMap,
} from './tree/scroll-container';
import {
  buildVisualElementMap,
  type VisualElementMap,
} from './tree/visual-element';
import { pruneTree } from './tree/pruner';
import { createDiffTree, type DiffShow } from './tree/diff';
import { assignAndHighlight, type DOMSelectorMap } from './tree/highlight';
import type {
  DOMRect,
  EnhancedDOMTreeNode,
  InteractionRecord,
} from './types/dom-node';
import {
  copyDomTree,
  flattenDomTree,
  saveDebugJson,
  saveDebugHtml,
  buildNodeKeyLookup,
} from './utils/index';
import { renderToMarkdown } from './markdown/renderer';
import { pruneForMarkdown } from './markdown/pruner';
import {
  PageSettleMonitor,
  DOM_MUTATION_EVENTS,
  NON_CRITICAL_RESOURCE_TYPES,
  STUCK_REQUEST_MS,
  NON_CRITICAL_MAX_MS,
  IMAGE_URL_RE,
  isIgnoredUrl,
} from './settle-monitor';

/**
 * Result from getting serialized DOM tree
 */
export interface SerializedDomResult {
  html: string;
  selectorMap: DOMSelectorMap;
  url?: string;
}

/**
 * Result from getting DOM tree (without serialization)
 */
export interface DomTreeResult {
  root: EnhancedDOMTreeNode;
}

export interface ScrollContainerPages {
  index: number;
  pagesAbove: number;
  pagesBelow: number;
}

export type ViewportStats = ScrollContainerPages[];

interface DomSnapshot {
  domTree: EnhancedDOMTreeNode;
  selectorMap: DOMSelectorMap;
  scrollContainerMap: ScrollContainerMap;
  visualElementMap: VisualElementMap;
  timestamp: number;
  topElementCount: number;
  navigationIndex?: number;
  url?: string;
  historyEntryId?: number;
  viewportStats?: ViewportStats;
  expand?: number;
  hasOverlay?: boolean;
  interactions?: InteractionRecord[];
}

/**
 * Persistent page change monitor.
 *
 * Start it after a DOM extraction and keep it alive until the next one.
 * CDP stays attached for the lifetime of the monitor (held via clientRefCount).
 *
 * Lifecycle per agent iteration:
 *   monitor.reset()          ← right after DOM extraction
 *   ... tool executes ...
 *   monitor.hasChanged()     ← decide whether to re-extract
 *   monitor.markDirty()      ← call explicitly for scroll/navigation tools
 *   monitor.stop()           ← at agent session end
 */
/**
 * DOM Service
 *
 * High-level service for DOM extraction, combining CDP communication,
 * tree building, and serialization into a single API.
 */
/** Centre of a rect, in whatever space the rect is already expressed in. */
function centerOf(
  rect?: DOMRect | null,
): { x: number; y: number } | undefined {
  if (!rect) return undefined;
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}

export class DomService {
  private client: CDPClient;
  readonly commands: CDPCommands;
  private oopifManager: OOPIFManager;
  private cache = new Map<string, DomSnapshot>();
  private maxCacheSize: number;
  private domIdCounter = 0;
  private domSubCounter = 0;
  private lastNavigationUrl: string | undefined;
  private clientRefCount = 0;
  private settleMonitor: PageSettleMonitor;
  private settleReady: Promise<void>;
  readonly page: Page;

  constructor(
    page: Page,
    client: CDPClient,
    maxCacheSize = 10,
  ) {
    this.page = page;
    this.client = client;
    this.commands = new CDPCommands(this.client);
    this.oopifManager = new OOPIFManager();
    this.maxCacheSize = maxCacheSize;
    this.settleMonitor = new PageSettleMonitor(this.client.getDebugger(), {
      enableOOPIFSession: async (sessionId: string) => {
        await this.client
          .sendCommand('Network.enable', {}, 5000, sessionId)
          .catch(() => {});
        await this.client
          .sendCommand('DOM.enable', {}, 5000, sessionId)
          .catch(() => {});
      },
    });
    this.settleReady = this.initSettle();
  }

  private async initSettle(): Promise<void> {
    this.clientRefCount++;
    await this.client.attach();
    await this.client.sendCommand('Network.enable', {}).catch(() => {});
    await this.client.sendCommand('DOM.enable', {}).catch(() => {});
  }

  async destroySettle(): Promise<void> {
    await this.settleReady.catch(() => {});
    this.settleMonitor.stop();
    this.clientRefCount--;
    if (this.clientRefCount === 0) {
      await this.oopifManager.cleanup();
      await this.client.cleanup();
    }
  }

  getSelectorMap(domId: string): DOMSelectorMap | undefined {
    return this.cache.get(domId)?.selectorMap;
  }

  getScrollContainerMap(domId: string): ScrollContainerMap {
    return this.cache.get(domId)?.scrollContainerMap ?? new Map();
  }

  getCachedUrl(domId: string): string | undefined {
    return this.cache.get(domId)?.url;
  }

  getHistoryEntryId(domId: string): number | undefined {
    return this.cache.get(domId)?.historyEntryId;
  }

  async captureHistoryEntryId(): Promise<number | undefined> {
    try {
      const result = await this.client.sendCommand<{
        currentIndex: number
        entries: Array<{ id: number; url: string }>
      }>("Page.getNavigationHistory")
      return result.entries[result.currentIndex]?.id
    } catch {
      return undefined
    }
  }

  async restoreHistoryEntry(entryId: number): Promise<boolean> {
    try {
      // Verify the entry still exists in the history stack
      const history = await this.client.sendCommand<{
        currentIndex: number
        entries: Array<{ id: number }>
      }>("Page.getNavigationHistory")
      if (!history.entries.some(e => e.id === entryId)) return false

      const nav = this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {})
      await this.client.sendCommand("Page.navigateToHistoryEntry", { entryId })
      await nav
      return true
    } catch {
      return false
    }
  }

  getRootAxName(domId: string): string | null {
    return this.cache.get(domId)?.domTree.axNode?.name?.trim() || null;
  }

  getLatestSelectorMap(): DOMSelectorMap | undefined {
    let latest: DomSnapshot | undefined;
    for (const snapshot of this.cache.values()) {
      if (!latest || snapshot.timestamp > latest.timestamp) {
        latest = snapshot;
      }
    }
    return latest?.selectorMap;
  }

  getLatestScrollContainerMap(): ScrollContainerMap {
    let latest: DomSnapshot | undefined;
    for (const snapshot of this.cache.values()) {
      if (!latest || snapshot.timestamp > latest.timestamp) {
        latest = snapshot;
      }
    }
    return latest?.scrollContainerMap ?? new Map();
  }

  getLatestVisualElementMap(): VisualElementMap {
    let latest: DomSnapshot | undefined;
    for (const snapshot of this.cache.values()) {
      if (!latest || snapshot.timestamp > latest.timestamp) {
        latest = snapshot;
      }
    }
    return latest?.visualElementMap ?? new Map();
  }

  getLatestExpand(): number | null {
    let latest: DomSnapshot | undefined;
    for (const snapshot of this.cache.values()) {
      if (!latest || snapshot.timestamp > latest.timestamp) {
        latest = snapshot;
      }
    }
    return latest?.expand ?? null;
  }

  getScrollContainerNode(index: number): EnhancedDOMTreeNode | undefined {
    return this.getLatestScrollContainerMap().get(index);
  }

  async scrollToOffscreenElementByIndex(
    target: string,
    container: number,
    direction: 'up' | 'down',
  ): Promise<EnhancedDOMTreeNode | undefined> {
    const node = this.findOffscreenNodeByRenderedLine(target, container, direction);
    if (!node) return undefined;
    await this.withClient(() => this.scrollToElement(node));
    return node;
  }

  async scrollToPositionByIndex(
    container: number,
    x: number,
    y: number,
  ): Promise<void> {
    return this.withClient(async () => {
      if (container === 0) {
        await this.evaluate(`window.scrollTo(${x}, ${y})`);
      } else {
        const node = this.getScrollContainerNode(container);
        if (!node) {
          throw new Error(
            `Scroll container [${container}] not found. Check the [container:N] comments in the current DOM.`,
          );
        }
        await this.scrollContainerTo(node, x, y);
      }
    });
  }

  async getScrollInfoByIndex(container: number): Promise<{
    scrollX: number;
    scrollY: number;
    viewportWidth: number;
    viewportHeight: number;
    totalWidth: number;
    totalHeight: number;
  }> {
    return this.withClient(async () => {
      if (container === 0) {
        const metrics = await this.commands.getLayoutMetrics();
        const css = metrics.cssLayoutViewport ?? metrics.layoutViewport;
        return {
          scrollX: css.pageX,
          scrollY: css.pageY,
          viewportWidth: css.clientWidth,
          viewportHeight: css.clientHeight,
          totalWidth: metrics.cssContentSize!.width,
          totalHeight: metrics.cssContentSize!.height,
        };
      } else {
        const node = this.getScrollContainerNode(container);
        if (!node) {
          throw new Error(
            `Scroll container [${container}] not found. Check the [container:N] comments in the current DOM.`,
          );
        }
        return this.getContainerScrollInfo(node);
      }
    });
  }

  /**
   * Find an off-screen node by its renderedLine text within a specific scroll container and direction.
   * direction 'down' matches expandedViewportPosition 'below'|'right', 'up' matches 'above'|'left'.
   */
  findOffscreenNodeByRenderedLine(
    target: string,
    container: number,
    direction: 'up' | 'down',
  ): EnhancedDOMTreeNode | undefined {
    let latest: DomSnapshot | undefined;
    for (const snapshot of this.cache.values()) {
      if (!latest || snapshot.timestamp > latest.timestamp) {
        latest = snapshot;
      }
    }
    if (!latest) return undefined;

    const trimmed = target.trim();
    if (!trimmed) return undefined;

    const downPositions = new Set(['below', 'right']);
    const upPositions = new Set(['above', 'left']);
    const validPositions = direction === 'down' ? downPositions : upPositions;

    const queue: EnhancedDOMTreeNode[] = [latest.domTree];
    while (queue.length > 0) {
      const node = queue.shift()!;
      const ri = node.renderInfo;
      if (
        ri?.renderedLine &&
        (ri.renderedLine.includes(trimmed) ||
          trimmed.includes(ri.renderedLine)) &&
        ri.expandedViewportPosition !== undefined &&
        validPositions.has(ri.expandedViewportPosition) &&
        (ri.scrollContainerIndex ?? 0) === container
      ) {
        return node;
      }
      for (const child of node.childrenNodes ?? []) {
        queue.push(child);
      }
    }
    return undefined;
  }

  clearCache(): void {
    this.cache.clear();
    this.domIdCounter = 0;
    this.domSubCounter = 0;
    this.lastNavigationUrl = undefined;
  }

  generateDomId(): string {
    const currentUrl = this.page.url();
    if (
      this.lastNavigationUrl !== undefined &&
      currentUrl === this.lastNavigationUrl
    ) {
      this.domSubCounter++;
      return `dom${this.domIdCounter}.${this.domSubCounter}`;
    }
    if (this.lastNavigationUrl !== undefined) {
      this.domIdCounter++;
    }
    this.domSubCounter = 0;
    this.lastNavigationUrl = currentUrl;
    return `dom${this.domIdCounter}`;
  }

  /**
   * Evaluate JS expression via CDP Runtime.evaluate.
   * Must be called within withClient().
   */
  async evaluate(expression: string): Promise<void> {
    await this.client.sendCommand('Runtime.evaluate', {
      expression,
      awaitPromise: false,
    });
  }

  async evaluateWithReturn(expression: string): Promise<any> {
    const result = await this.client.sendCommand<{
      result: { value?: any; subtype?: string; description?: string };
      exceptionDetails?: { text?: string };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? 'Script error');
    }
    return result.result.value;
  }

  /**
   * Scroll a container element to an absolute position via JS.
   * Must be called within withClient().
   */
  async scrollContainerTo(
    node: EnhancedDOMTreeNode,
    x: number,
    y: number,
  ): Promise<void> {
    if (node.oopifSessionId) await this.ensureOOPIF();
    const sendCommand = node.oopifSessionId
      ? (method: string, params?: Record<string, unknown>) =>
          this.oopifManager.sendCommand(node.oopifSessionId!, method, params)
      : (method: string, params?: Record<string, unknown>) =>
          this.client.sendCommand(method, params);

    const { object } = (await sendCommand('DOM.resolveNode', {
      backendNodeId: node.backendNodeId,
    })) as { object: { objectId: string } };

    await sendCommand('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function(x, y) { this.scrollTop = y; this.scrollLeft = x; }`,
      arguments: [{ value: x }, { value: y }],
      returnByValue: true,
    });

    await sendCommand('Runtime.releaseObject', {
      objectId: object.objectId,
    }).catch(() => {});
  }

  /**
   * Query live scroll info of a container element via CDP.
   * Must be called within withClient().
   */
  async getContainerScrollInfo(node: EnhancedDOMTreeNode): Promise<{
    scrollX: number;
    scrollY: number;
    viewportWidth: number;
    viewportHeight: number;
    totalWidth: number;
    totalHeight: number;
  }> {
    if (node.oopifSessionId) await this.ensureOOPIF();
    const sendCommand = node.oopifSessionId
      ? (method: string, params?: Record<string, unknown>) =>
          this.oopifManager.sendCommand(node.oopifSessionId!, method, params)
      : (method: string, params?: Record<string, unknown>) =>
          this.client.sendCommand(method, params);

    const { object } = (await sendCommand('DOM.resolveNode', {
      backendNodeId: node.backendNodeId,
    })) as { object: { objectId: string } };

    const { result } = (await sendCommand('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        return {
          scrollX: this.scrollLeft,
          scrollY: this.scrollTop,
          viewportWidth: this.clientWidth,
          viewportHeight: this.clientHeight,
          totalWidth: this.scrollWidth,
          totalHeight: this.scrollHeight,
        };
      }`,
      returnByValue: true,
    })) as {
      result: {
        value: {
          scrollX: number;
          scrollY: number;
          viewportWidth: number;
          viewportHeight: number;
          totalWidth: number;
          totalHeight: number;
        };
      };
    };

    await sendCommand('Runtime.releaseObject', {
      objectId: object.objectId,
    }).catch(() => {});

    return result.value;
  }

  /**
   * Click at (x, y) via CDP Input.dispatchMouseEvent.
   * Coordinates are CSS pixels relative to the viewport.
   * Must be called within withClient().
   */
  async click(x: number, y: number): Promise<void> {
    await this.client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    await this.client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    await this.client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  /**
   * Scroll via CDP Input.dispatchMouseEvent mouseWheel.
   * Moves mouse to (x, y) first, then dispatches wheel event.
   * Must be called within withClient().
   */
  async scroll(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
  ): Promise<void> {
    await this.client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    await this.client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
    });
  }

  /**
   * Press Enter key via CDP Input.dispatchKeyEvent.
   * Must be called within withClient().
   */
  async pressEnter(): Promise<void> {
    await this.client.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await this.client.sendCommand('Input.dispatchKeyEvent', {
      type: 'char',
      key: 'Enter',
      code: 'Enter',
      text: '\r',
      unmodifiedText: '\r',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await this.client.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  }

  /**
   * Show a temporary click/input annotation on the page.
   * Must be called within withClient().
   */
  async showClickAnnotation(
    x: number,
    y: number,
    type: 'click' | 'input',
    elementIndex: number,
  ): Promise<void> {
    const color = type === 'click' ? '#FF0000' : '#00FF00';
    const icon = type === 'click' ? '🖱️' : '⌨️';
    const js = `(function() {
      var existing = document.querySelectorAll('.abrowser-click-annotation');
      existing.forEach(function(el) { el.remove(); });
      var annotation = document.createElement('div');
      annotation.className = 'abrowser-click-annotation';
      annotation.style.cssText = 'position:fixed;left:${x}px;top:${y}px;width:20px;height:20px;margin-left:-10px;margin-top:-10px;border:3px solid ${color};border-radius:50%;background-color:${color}44;pointer-events:none;z-index:2147483647;animation:abrowser-annotation-pulse 0.5s ease-in-out;';
      var label = document.createElement('div');
      label.style.cssText = 'position:absolute;top:-35px;left:50%;transform:translateX(-50%);background:${color};color:white;padding:4px 8px;border-radius:4px;font-size:14px;font-weight:bold;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
      label.textContent = '${icon} [${elementIndex}] (${Math.round(x)},${Math.round(y)})';
      annotation.appendChild(label);
      if (!document.getElementById('abrowser-annotation-style')) {
        var style = document.createElement('style');
        style.id = 'abrowser-annotation-style';
        style.textContent = '@keyframes abrowser-annotation-pulse { 0%,100% { opacity:1; transform:translate(-10px,-10px) scale(1); } 50% { opacity:0.7; transform:translate(-10px,-10px) scale(1.5); } }';
        document.head.appendChild(style);
      }
      document.body.appendChild(annotation);
      setTimeout(function() {
        annotation.style.transition = 'opacity 0.3s';
        annotation.style.opacity = '0';
        setTimeout(function() { annotation.remove(); }, 300);
      }, 2500);
    })()`;
    await this.evaluate(js);
  }

  /**
   * Show a camera viewfinder overlay and shutter flash effect for screenshot capture.
   * The rect is in viewport-relative CSS pixels.
   * Must be called within withClient().
   */
  async showCaptureAnnotation(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<void> {
    const { x, y, width, height } = rect;
    const js = `(function() {
      var existing = document.querySelectorAll('.abrowser-capture-annotation');
      existing.forEach(function(el) { el.remove(); });

      if (!document.getElementById('abrowser-capture-style')) {
        var style = document.createElement('style');
        style.id = 'abrowser-capture-style';
        style.textContent = [
          '@keyframes abrowser-capture-focus { 0% { opacity:0; transform:scale(1.1); } 20% { opacity:1; transform:scale(1); } 80% { opacity:1; } 100% { opacity:0; } }',
          '@keyframes abrowser-shutter-flash { 0% { opacity:0; } 10% { opacity:0.5; } 100% { opacity:0; } }'
        ].join('\\n');
        document.head.appendChild(style);
      }

      /* viewfinder rectangle */
      var vf = document.createElement('div');
      vf.className = 'abrowser-capture-annotation';
      vf.style.cssText = 'position:fixed;left:${x}px;top:${y}px;width:${width}px;height:${height}px;border:3px solid #00BFFF;border-radius:4px;box-shadow:0 0 0 9999px rgba(0,0,0,0.35),0 0 20px rgba(0,191,255,0.5);pointer-events:none;z-index:2147483647;animation:abrowser-capture-focus 2.5s ease-out forwards;';

      /* corner brackets */
      var corners = [
        'top:0;left:0;border-top:3px solid #fff;border-left:3px solid #fff;',
        'top:0;right:0;border-top:3px solid #fff;border-right:3px solid #fff;',
        'bottom:0;left:0;border-bottom:3px solid #fff;border-left:3px solid #fff;',
        'bottom:0;right:0;border-bottom:3px solid #fff;border-right:3px solid #fff;'
      ];
      corners.forEach(function(css) {
        var c = document.createElement('div');
        c.style.cssText = 'position:absolute;width:16px;height:16px;' + css;
        vf.appendChild(c);
      });

      /* camera icon label */
      var label = document.createElement('div');
      label.style.cssText = 'position:absolute;top:-32px;left:50%;transform:translateX(-50%);background:#00BFFF;color:white;padding:3px 10px;border-radius:4px;font-size:13px;font-weight:bold;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
      label.textContent = '📷 capture';
      vf.appendChild(label);

      document.body.appendChild(vf);

      /* shutter flash overlay */
      var flash = document.createElement('div');
      flash.className = 'abrowser-capture-annotation';
      flash.style.cssText = 'position:fixed;left:${x}px;top:${y}px;width:${width}px;height:${height}px;background:white;pointer-events:none;z-index:2147483647;animation:abrowser-shutter-flash 0.8s ease-out forwards;border-radius:4px;';
      document.body.appendChild(flash);

      setTimeout(function() {
        var all = document.querySelectorAll('.abrowser-capture-annotation');
        all.forEach(function(el) {
          el.style.transition = 'opacity 0.3s';
          el.style.opacity = '0';
          setTimeout(function() { el.remove(); }, 300);
        });
      }, 2800);
    })()`;
    await this.evaluate(js);
  }

  /**
   * Scroll element into view (centered), supports OOPIF.
   * Must be called within withClient().
   */
  async scrollToElement(node: EnhancedDOMTreeNode): Promise<void> {
    if (node.oopifSessionId) await this.ensureOOPIF();
    const sendCommand = node.oopifSessionId
      ? (method: string, params?: Record<string, unknown>) =>
          this.oopifManager.sendCommand(node.oopifSessionId!, method, params)
      : (method: string, params?: Record<string, unknown>) =>
          this.client.sendCommand(method, params);

    // Resolve node to get objectId for JS execution
    let resolveResult: { object: { objectId?: string } };
    try {
      resolveResult = (await sendCommand('DOM.resolveNode', {
        backendNodeId: node.backendNodeId,
      })) as { object: { objectId?: string } };
    } catch (e) {
      // silently ignore resolve failures
      return;
    }

    const objectId = resolveResult.object?.objectId;
    if (!objectId) {
      // no objectId available
      return;
    }

    await sendCommand('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        var el = this.nodeType === 3 ? this.parentElement : this;
        if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      }`,
      returnByValue: true,
    });

    // Release the object
    await sendCommand('Runtime.releaseObject', { objectId }).catch(() => {});
  }

  /**
   * Select an option in a native <select> element using page-context DOM APIs.
   * Must be called within withClient().
   */
  async selectOption(node: EnhancedDOMTreeNode): Promise<{
    value: string;
    text: string;
    multiple: boolean;
  }> {
    if (node.oopifSessionId) await this.ensureOOPIF();
    const sendCommand = node.oopifSessionId
      ? <T>(method: string, params?: Record<string, unknown>) =>
          this.oopifManager.sendCommand<T>(node.oopifSessionId!, method, params)
      : <T>(method: string, params?: Record<string, unknown>) =>
          this.client.sendCommand<T>(method, params);

    const resolved = await sendCommand<{
      object?: { objectId?: string };
    }>('DOM.resolveNode', {
      backendNodeId: node.backendNodeId,
    });

    const objectId = resolved.object?.objectId;
    if (!objectId) {
      throw new Error(
        `Option element no longer exists in the page (backendNodeId: ${node.backendNodeId}).`,
      );
    }

    try {
      const result = await sendCommand<{
        result?: {
          value?: {
            ok: boolean;
            error?: string;
            value?: string;
            text?: string;
            multiple?: boolean;
          };
        };
      }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          const option = this;
          if (!(option instanceof HTMLOptionElement)) {
            return { ok: false, error: 'Target is not an option element' };
          }
          if (option.disabled) {
            return { ok: false, error: 'Option is disabled' };
          }

          const select = option.closest('select');
          if (!(select instanceof HTMLSelectElement)) {
            return { ok: false, error: 'No parent select element found' };
          }
          if (select.disabled) {
            return { ok: false, error: 'Select element is disabled' };
          }

          if (select.multiple) {
            option.selected = true;
          } else {
            const valueSetter = Object.getOwnPropertyDescriptor(
              HTMLSelectElement.prototype,
              'value',
            )?.set;
            if (valueSetter) {
              valueSetter.call(select, option.value);
            } else {
              select.value = option.value;
            }
            option.selected = true;
          }

          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));

          return {
            ok: true,
            value: option.value,
            text: option.textContent ? option.textContent.trim() : '',
            multiple: select.multiple,
          };
        }`,
        returnByValue: true,
      });

      const payload = result.result?.value;
      if (!payload?.ok) {
        throw new Error(payload?.error ?? 'Failed to select option');
      }

      return {
        value: payload.value ?? '',
        text: payload.text ?? '',
        multiple: payload.multiple ?? false,
      };
    } finally {
      await sendCommand('Runtime.releaseObject', { objectId }).catch(() => {});
    }
  }

  /**
   * Set value on inputs that don't support keyboard text entry (range, color, date, etc.)
   * Uses the native property setter to trigger React/framework state updates.
   * Must be called within withClient().
   */
  async setInputValue(node: EnhancedDOMTreeNode, value: string): Promise<void> {
    if (node.oopifSessionId) await this.ensureOOPIF();
    const sendCommand = node.oopifSessionId
      ? <T>(method: string, params?: Record<string, unknown>) =>
          this.oopifManager.sendCommand<T>(node.oopifSessionId!, method, params)
      : <T>(method: string, params?: Record<string, unknown>) =>
          this.client.sendCommand<T>(method, params);

    const resolved = await sendCommand<{
      object?: { objectId?: string };
    }>('DOM.resolveNode', {
      backendNodeId: node.backendNodeId,
    });

    const objectId = resolved.object?.objectId;
    if (!objectId) {
      throw new Error(
        `Element no longer exists in the page (backendNodeId: ${node.backendNodeId}).`,
      );
    }

    const isAriaSlider = node.attributes?.role === 'slider';

    try {
      const result = await sendCommand<{
        result?: { value?: { ok: boolean; error?: string } };
      }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: isAriaSlider
          ? `function(newValue) {
            // ARIA slider: focus + simulate keyboard arrow keys to reach target value
            this.focus();
            const min = parseFloat(this.getAttribute('aria-valuemin') ?? '0');
            const max = parseFloat(this.getAttribute('aria-valuemax') ?? '100');
            const step = parseFloat(this.getAttribute('aria-valuestep') ?? '1');
            const current = parseFloat(this.getAttribute('aria-valuenow') ?? String(min));
            const target = Math.max(min, Math.min(max, parseFloat(newValue)));
            const steps = Math.round((target - current) / step);
            const key = steps > 0 ? 'ArrowRight' : 'ArrowLeft';
            for (let i = 0; i < Math.abs(steps); i++) {
              this.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
            }
            return { ok: true };
          }`
          : `function(newValue) {
            // Native input: use property setter to trigger framework reactivity
            const proto = Object.getPrototypeOf(this);
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
              || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) {
              setter.call(this, newValue);
            } else {
              this.value = newValue;
            }
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true };
          }`,
        arguments: [{ value }],
        returnByValue: true,
      });

      const payload = result.result?.value;
      if (!payload?.ok) {
        throw new Error(payload?.error ?? 'Failed to set input value');
      }
    } finally {
      await sendCommand('Runtime.releaseObject', { objectId }).catch(() => {});
    }
  }

  /**
   * Get real-time absolute position of a node via CDP DOM.getBoxModel.
   * Same logic as absolutePosition: element bounds in its frame + iframe ancestor offsets.
   * Must be called within withClient().
   */
  async getElementRect(node: EnhancedDOMTreeNode): Promise<DOMRect> {
    if (node.oopifSessionId) await this.ensureOOPIF();
    // Get element bounds in its own frame via CDP
    const sendCommand = node.oopifSessionId
      ? <T>(method: string, params?: Record<string, unknown>) =>
          this.oopifManager.sendCommand<T>(node.oopifSessionId!, method, params)
      : <T>(method: string, params?: Record<string, unknown>) =>
          this.client.sendCommand<T>(method, params);

    let result: { model: { border: number[]; content: number[] } };
    try {
      result = await sendCommand<{
        model: { border: number[]; content: number[] };
      }>('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
    } catch (e) {
      throw new Error(
        `Element no longer exists in the page (backendNodeId: ${node.backendNodeId}). The page may have changed since the last DOM snapshot.`,
      );
    }

    if (!result?.model?.border) {
      throw new Error(
        `Element no longer exists in the page (backendNodeId: ${node.backendNodeId}). The page may have changed since the last DOM snapshot.`,
      );
    }
    // Use border box to match DOMSnapshot bounds (which report the border box).
    // Compute bounding box from all 4 quad points — point order isn't guaranteed.
    const q = result.model.border;
    const boundsInFrame: DOMRect = {
      x: Math.min(q[0], q[2], q[4], q[6]),
      y: Math.min(q[1], q[3], q[5], q[7]),
      width:
        Math.max(q[0], q[2], q[4], q[6]) - Math.min(q[0], q[2], q[4], q[6]),
      height:
        Math.max(q[1], q[3], q[5], q[7]) - Math.min(q[1], q[3], q[5], q[7]),
    };

    // Walk up parentNode chain to accumulate iframe offsets (same as builder's frameOffset)
    let offsetX = 0;
    let offsetY = 0;
    let current = node.parentNode;
    while (current) {
      const tag = current.nodeName.toUpperCase();
      if (tag === 'IFRAME' || tag === 'FRAME') {
        // Get iframe element's real-time position in its parent frame
        const iframeSend = current.oopifSessionId
          ? <T>(method: string, params?: Record<string, unknown>) =>
              this.oopifManager.sendCommand<T>(
                current!.oopifSessionId!,
                method,
                params,
              )
          : <T>(method: string, params?: Record<string, unknown>) =>
              this.client.sendCommand<T>(method, params);
        try {
          const iframeResult = await iframeSend<{
            model: { content: number[] };
          }>('DOM.getBoxModel', { backendNodeId: current.backendNodeId });
          if (iframeResult?.model?.content) {
            const iq = iframeResult.model.content;
            offsetX += iq[0];
            offsetY += iq[1];
          }
        } catch {
          // Fallback to cached position
          if (current.absolutePosition) {
            offsetX += current.absolutePosition.x;
            offsetY += current.absolutePosition.y;
          }
        }
      }
      current = current.parentNode;
    }

    return {
      x: boundsInFrame.x + offsetX,
      y: boundsInFrame.y + offsetY,
      width: boundsInFrame.width,
      height: boundsInFrame.height,
    };
  }

  /**
   * Capture a region of the page via CDP Page.captureScreenshot (no scrolling needed).
   * Clip coordinates are in CSS pixels (absolute, not viewport-relative).
   * Must be called within withClient().
   */
  async captureClip(clip: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<string> {
    const result = await this.client.sendCommand<{ data: string }>(
      'Page.captureScreenshot',
      {
        format: 'jpeg',
        quality: 80,
        clip: { ...clip, scale: 1 },
      },
    );
    return result.data;
  }

  /**
   * Re-check whether the node is still the topmost one at its own centre, so a
   * click is not sent into something that now covers it.
   *
   * Hit testing takes coordinates in the target frame's document space and only
   * resolves points inside its visible band, so the probe is built in the frame
   * the command is routed to. `rect` should be the element's live viewport
   * rect when the caller already has one — the snapshot's position is stale as
   * soon as the page scrolls.
   *
   * Must be called within withClient().
   */
  async hitTestAtPoint(
    node: EnhancedDOMTreeNode,
    rect?: DOMRect,
  ): Promise<boolean> {
    const sessionId = node.oopifSessionId
      ? this.oopifManager.resolveSessionId(node.oopifSessionId)
      : undefined;

    const point = sessionId
      ? centerOf(node.snapshotNode?.bounds)
      : await this.toDocumentPoint(rect ?? node.absolutePosition);
    if (!point) return true;

    const sendCmd = <T>(method: string, params?: Record<string, unknown>) =>
      this.client.sendCommand<T>(method, params, undefined, sessionId);

    const hitBackendNodeId = await elementFromPoint(sendCmd, point.x, point.y);
    if (hitBackendNodeId === undefined) return false;

    const snapshotHit = node.renderInfo.hitBackendNodeId;
    return (
      hitBackendNodeId === (snapshotHit ?? node.backendNodeId) ||
      hitBackendNodeId === node.backendNodeId
    );
  }

  /** Centre of a viewport rect, moved into the main document's coordinates. */
  private async toDocumentPoint(
    rect?: DOMRect | null,
  ): Promise<{ x: number; y: number } | undefined> {
    if (!rect) return undefined;
    const metrics = await this.commands.getLayoutMetrics();
    const css = metrics.cssLayoutViewport ?? metrics.layoutViewport;
    return {
      x: Math.round(rect.x + rect.width / 2 + css.pageX),
      y: Math.round(rect.y + rect.height / 2 + css.pageY),
    };
  }

  /**
   * Execute a JS function on the given node, with the element as `this`.
   * Returns the JSON-serializable return value of the function.
   */
  async executeOnElement(
    node: EnhancedDOMTreeNode,
    functionDeclaration: string,
  ): Promise<any> {
    const sessionId = node.oopifSessionId
      ? this.oopifManager.resolveSessionId(node.oopifSessionId)
      : undefined;

    const { object } = await this.client.sendCommand<{
      object: { objectId?: string };
    }>(
      'DOM.resolveNode',
      { backendNodeId: node.backendNodeId },
      undefined,
      sessionId,
    );
    if (!object.objectId) throw new Error('Could not resolve element');

    const result = await this.client.sendCommand<{
      result: { value?: any; description?: string; subtype?: string };
    }>(
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId,
        functionDeclaration,
        returnByValue: true,
        awaitPromise: true,
      },
      undefined,
      sessionId,
    );

    await this.client
      .sendCommand(
        'Runtime.releaseObject',
        { objectId: object.objectId },
        undefined,
        sessionId,
      )
      .catch(() => {});
    return result.result.value;
  }

  async withClient<T>(fn: () => Promise<T>): Promise<T> {
    this.clientRefCount++;
    try {
      await this.client.attach();
      return await fn();
    } finally {
      this.clientRefCount--;
      if (this.clientRefCount === 0) {
        await this.oopifManager.cleanup();
        await this.client.cleanup();
      }
    }
  }

  /**
   * Lazily re-discover OOPIF sessions if they were cleaned up.
   * Call before any operation that needs to send CDP commands to an OOPIF node.
   * Must be called within withClient().
   */
  private async ensureOOPIF(): Promise<void> {
    if (!this.oopifManager.isConnected()) {
      await this.oopifManager.discoverOOPIFs(this.client, 'remap');
    }
  }

  /**
   * Get cached DOM tree by domId (returns a safe copy)
   */
  getCachedDomTree(domId: string): EnhancedDOMTreeNode | undefined {
    const cached = this.getSnapshot(domId);
    if (!cached?.domTree) {
      return undefined;
    }
    return copyDomTree(cached.domTree);
  }

  /**
   * Set cached DOM tree by domId
   */
  setCachedDomTree(
    domId: string,
    domTree: EnhancedDOMTreeNode,
    selectorMap: DOMSelectorMap,
    scrollContainerMap: ScrollContainerMap,
    visualElementMap: VisualElementMap,
    url?: string,
    viewportStats?: ViewportStats,
    expand?: number,
    hasOverlay?: boolean,
    topElementCount?: number,
    historyEntryId?: number,
  ): void {
    this.setSnapshot(domId, {
      domTree,
      selectorMap,
      scrollContainerMap,
      visualElementMap,
      topElementCount: topElementCount ?? 0,
      url,
      viewportStats,
      expand,
      hasOverlay,
      historyEntryId,
    });
  }

  /**
   * Record an interaction (click/input) on the latest cached snapshot.
   * Stores the backendNodeId so downstream consumers can trace which elements were acted on.
   */
  recordInteraction(
    backendNodeId: number,
    action: InteractionRecord['action'],
    renderedLine?: string,
    params?: Record<string, unknown>,
  ): void {
    // Find the latest snapshot
    let latest: DomSnapshot | undefined;
    for (const snapshot of this.cache.values()) {
      if (!latest || snapshot.timestamp > latest.timestamp) {
        latest = snapshot;
      }
    }
    if (!latest) return;

    if (!latest.interactions) {
      latest.interactions = [];
    }
    latest.interactions.push({
      backendNodeId,
      action,
      renderedLine,
      params,
      timestamp: Date.now(),
    });
  }

  /**
   * Get interaction records for a cached snapshot.
   */
  getInteractions(domId: string): InteractionRecord[] {
    return this.cache.get(domId)?.interactions ?? [];
  }

  /**
   * Collect all interaction records across all cached snapshots, grouped by backendNodeId.
   */
  private collectInteractions(): Map<number, InteractionRecord[]> {
    const map = new Map<number, InteractionRecord[]>();
    for (const snapshot of this.cache.values()) {
      if (!snapshot.interactions) continue;
      for (const record of snapshot.interactions) {
        let list = map.get(record.backendNodeId);
        if (!list) {
          list = [];
          map.set(record.backendNodeId, list);
        }
        list.push(record);
      }
    }
    return map;
  }

  getViewportStats(domId: string): ViewportStats | null {
    return this.cache.get(domId)?.viewportStats ?? null;
  }

  getExpand(domId: string): number | null {
    return this.cache.get(domId)?.expand ?? null;
  }

  getHasOverlay(domId: string): boolean {
    return this.cache.get(domId)?.hasOverlay ?? false;
  }

  /**
   * Build exploration bars for all containers, showing which pages have been seen.
   * Scans cached snapshots sharing the same root backendNodeId.
   * '#' = previously seen, '>' = current viewport, '_' = unexplored.
   */
  getExplorationBars(
    domId: string,
  ): Map<
    number,
    { explored: number[]; current: number[]; unexplored: number[] }
  > | null {
    const target = this.getSnapshot(domId);
    if (!target?.viewportStats) return null;

    const rootId = target.domTree.backendNodeId;

    // No bar if this is the only snapshot with this root (first visit)
    let siblingCount = 0;
    for (const [id, snapshot] of this.cache) {
      if (id !== domId && snapshot.domTree.backendNodeId === rootId) {
        siblingCount++;
        break;
      }
    }
    if (siblingCount === 0) return null;

    // container index → total pages (skip single-page containers)
    const totalPagesMap = new Map<number, number>();
    for (const sc of target.viewportStats) {
      const total = Math.ceil(sc.pagesAbove + 1 + sc.pagesBelow);
      if (total > 1) totalPagesMap.set(sc.index, total);
    }

    if (totalPagesMap.size === 0) return null;

    // For each container, collect explored pages from all snapshots with same root
    const result = new Map<
      number,
      { explored: number[]; current: number[]; unexplored: number[] }
    >();

    for (const [cIdx, totalPages] of totalPagesMap) {
      // Collect coverage intervals from all snapshots with same root
      const intervals: [number, number][] = [];
      let curInterval: [number, number] | null = null;

      for (const [id, snapshot] of this.cache) {
        if (snapshot.domTree.backendNodeId !== rootId) continue;
        if (!snapshot.viewportStats) continue;

        const sc = snapshot.viewportStats.find(s => s.index === cIdx);
        if (!sc) continue;

        const exp = cIdx === 0 ? (snapshot.expand ?? 0) : 0;
        const expandAbove = Math.min(exp, sc.pagesAbove);
        const expandBelow = Math.min(exp, sc.pagesBelow);
        const start = sc.pagesAbove - expandAbove;
        const end = sc.pagesAbove + 1 + expandBelow;
        intervals.push([start, end]);
        if (id === domId) curInterval = [start, end];
      }

      // Merge overlapping intervals
      intervals.sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const [s, e] of intervals) {
        if (merged.length > 0 && s <= merged[merged.length - 1][1]) {
          merged[merged.length - 1][1] = Math.max(
            merged[merged.length - 1][1],
            e,
          );
        } else {
          merged.push([s, e]);
        }
      }

      // Check each page [p, p+1) for full coverage
      const explored: number[] = [];
      const current: number[] = [];
      const unexplored: number[] = [];
      for (let p = 0; p < totalPages; p++) {
        const isCurrent =
          curInterval && curInterval[0] <= p && curInterval[1] >= p + 1;
        const isExplored = merged.some(([s, e]) => s <= p && e >= p + 1);
        if (isCurrent) {
          current.push(p);
        } else if (isExplored) {
          explored.push(p);
        } else {
          unexplored.push(p);
        }
      }

      result.set(cIdx, { explored, current, unexplored });
    }

    return result;
  }

  /**
   * Get DOM tree without serialization
   *
   * Use this when you need the raw DOM tree structure without
   * LLM serialization (e.g., for analysis or custom processing).
   */
  async getDomTree(): Promise<DomTreeResult> {
    try {
      await this.client.attach();
      const root = await this.buildTree();
      return { root };
    } finally {
      await this.oopifManager.cleanup();
      await this.client.cleanup();
    }
  }

  /**
   * Build DOM tree and compute render info (assumes CDP client is attached)
   * @param options.expand - Expand viewport range in pages (1 = one viewport height/width) for marking elements outside visible area
   */
  async extractCurrentDomTree(
    options?: ComputeRenderInfoOptions,
  ): Promise<EnhancedDOMTreeNode> {
    const root = await this.buildTree();
    await computeRenderInfo(root, this.client, options, this.oopifManager);
    return root;
  }

  /**
   * Render DOM tree to HTML and compute selectorMap (assumes CDP client is attached)
   */
  async renderDomTree(
    domTree: EnhancedDOMTreeNode,
    options?: { highlight?: boolean; incrementalDiff?: boolean },
  ): Promise<{
    html: string;
    selectorMap: DOMSelectorMap;
    scrollContainerMap: ScrollContainerMap;
    visualElementMap: VisualElementMap;
    hasOverlay: boolean;
    topElementCount: number;
  }> {
    const rootForRender = copyDomTree(domTree);
    const lookup = buildNodeKeyLookup(domTree);

    // Prune structurally redundant nodes (writes pruneReason back to domTree via lookup)
    pruneTree(rootForRender, lookup);

    // Assign highlightIndex (writes highlightIndex back to domTree via lookup)
    const selectorMap = await assignAndHighlight(
      rootForRender,
      this.client,
      this.oopifManager,
      lookup,
      { highlight: options?.highlight },
    );

    // Build scroll container map for expanded viewport elements (after prune)
    const scrollContainerMap = buildScrollContainerMap(rootForRender, lookup);

    // Build visual element map keyed by backendNodeId
    const visualElementMap = buildVisualElementMap(rootForRender);

    // Collect interaction history from all cached snapshots
    const interactionMap = this.collectInteractions();

    // Render to HTML (lookup writes renderedLine back to domTree)
    const html = renderToHtml(rootForRender, 0, lookup, interactionMap, {
      incrementalDiff: options?.incrementalDiff,
    });

    // Detect overlay: any node with isOverlay = true means a modal/dialog covers the page
    const hasOverlay = (function walk(node: EnhancedDOMTreeNode): boolean {
      if (node.renderInfo?.isOverlay) return true;
      for (const child of node.childrenNodes ?? []) {
        if (walk(child)) return true;
      }
      return false;
    })(domTree);

    // Save single debug file with all info (pruneReason + highlightIndex + isDuplicateListener)
    // Skipped for secondary diff renders, which would otherwise overwrite the full-tree dump
    if (options?.highlight !== false) {
      saveDebugJson('domTree.json', flattenDomTree(domTree));
      saveDebugHtml('domTree.txt', domTree);
    }

    let topElementCount = 0;
    const countTop = (node: EnhancedDOMTreeNode): void => {
      if (node.renderInfo?.isTopElement) topElementCount++;
      for (const c of node.childrenNodes ?? []) countTop(c);
      for (const s of node.shadowRoots ?? []) countTop(s);
      if (node.contentDocument) countTop(node.contentDocument);
    };
    countTop(rootForRender);

    return {
      html,
      selectorMap,
      scrollContainerMap,
      visualElementMap,
      hasOverlay,
      topElementCount,
    };
  }

  /**
   * Fetch layout metrics via CDP and compute page-based scroll stats.
   * Must be called within withClient().
   */
  async computeViewportStats(
    scrollContainerMap: ScrollContainerMap,
  ): Promise<ViewportStats> {
    const metrics = await this.commands.getLayoutMetrics();
    const css = metrics.cssLayoutViewport ?? metrics.layoutViewport;
    const viewportHeight = css.clientHeight;
    const scrollY = css.pageY;
    const pageHeight = metrics.cssContentSize!.height;

    const scrollContainers: ScrollContainerPages[] = [];

    // Container 0: main page scroll
    const pixelsAbove = scrollY;
    const pixelsBelow = Math.max(0, pageHeight - viewportHeight - scrollY);
    scrollContainers.push({
      index: 0,
      pagesAbove:
        viewportHeight > 0
          ? Math.round((pixelsAbove / viewportHeight) * 10) / 10
          : 0,
      pagesBelow:
        viewportHeight > 0
          ? Math.round((pixelsBelow / viewportHeight) * 10) / 10
          : 0,
    });

    // Container 1+: scroll containers from DOM
    for (const [index, node] of scrollContainerMap) {
      const sr = node.snapshotNode?.scrollRects;
      const cr = node.snapshotNode?.clientRects;
      if (!sr || !cr || cr.height <= 0) continue;
      const scrollTop = sr.y;
      const scrollableHeight = sr.height;
      const visibleHeight = cr.height;
      const above = scrollTop;
      const below = Math.max(0, scrollableHeight - visibleHeight - scrollTop);
      scrollContainers.push({
        index,
        pagesAbove: Math.round((above / visibleHeight) * 10) / 10,
        pagesBelow: Math.round((below / visibleHeight) * 10) / 10,
      });
    }

    return scrollContainers;
  }

  renderMarkdown(domTree: EnhancedDOMTreeNode): string {
    const rootForRender = copyDomTree(domTree);
    const lookup = buildNodeKeyLookup(domTree);

    // Prune for markdown (writes pruneReason back to domTree via lookup)
    pruneForMarkdown(rootForRender, lookup);
    const markdown = renderToMarkdown(rootForRender, lookup);

    // Save single debug file
    saveDebugJson('markdownTree.json', flattenDomTree(domTree));
    saveDebugHtml('markdownTree.txt', domTree);

    return markdown;
  }

  /**
   * Create a diff tree by comparing two cached DOM snapshots.
   * Returns null if roots differ (different page) or snapshots missing.
   */
  getDiffTree(
    oldDomId: string,
    newDomId: string,
    show: DiffShow = 'both',
  ): EnhancedDOMTreeNode | null {
    const oldSnapshot = this.cache.get(oldDomId);
    const newSnapshot = this.cache.get(newDomId);
    if (!oldSnapshot?.domTree || !newSnapshot?.domTree) return null;
    try {
      if (oldSnapshot.url && newSnapshot.url) {
        const oldOrigin = new URL(oldSnapshot.url).origin;
        const newOrigin = new URL(newSnapshot.url).origin;
        if (oldOrigin !== newOrigin) return null;
      }
    } catch {}
    return createDiffTree(oldSnapshot.domTree, newSnapshot.domTree, show);
  }

  /**
   * Get diff stats (added/removed element counts) between two cached snapshots.
   */
  getDiffStats(
    oldDomId: string,
    newDomId: string,
    prebuiltTree?: EnhancedDOMTreeNode | null,
  ): {
    added: number;
    removed: number;
    addedRatio: number;
    removedRatio: number;
  } | null {
    const oldSnapshot = this.cache.get(oldDomId);
    const newSnapshot = this.cache.get(newDomId);
    const diffTree =
      prebuiltTree === undefined
        ? this.getDiffTree(oldDomId, newDomId)
        : prebuiltTree;
    if (!diffTree || !oldSnapshot || !newSnapshot) return null;

    // Prune before counting so stats reflect what the AI actually sees
    const prunedTree = copyDomTree(diffTree);
    pruneTree(prunedTree);

    let added = 0;
    let removed = 0;
    const visit = (node: EnhancedDOMTreeNode) => {
      if (node.renderInfo.diffStatus === 'added') added++;
      else if (node.renderInfo.diffStatus === 'removed') removed++;
      for (const c of node.childrenNodes ?? []) visit(c);
      for (const s of node.shadowRoots ?? []) visit(s);
      if (node.contentDocument) visit(node.contentDocument);
    };
    visit(prunedTree);

    const oldTotal = oldSnapshot.topElementCount;
    const newTotal = newSnapshot.topElementCount;

    return {
      added,
      removed,
      addedRatio: newTotal > 0 ? added / newTotal : 0,
      removedRatio: oldTotal > 0 ? removed / oldTotal : 0,
    };
  }

  /**
   * Shared tree-building logic: wait for page, capture CDP snapshot, build DOM tree
   */
  private async buildTree(): Promise<EnhancedDOMTreeNode> {
    await this.settleReady;
    // Attach OOPIF sessions first so settle monitor can track their network activity
    await this.oopifManager.discoverOOPIFs(this.client);
    await this.settleMonitor.waitForSettle(10000);

    // Inject current select/radio/checkbox values before snapshot
    // (CDP DOMSnapshot reflects HTML attributes, not live DOM properties)
    await this.commands.injectSelectValues();
    await this.commands.injectInputValues();

    const trees = await this.commands.getAllTrees({
      oopifManager: this.oopifManager,
    });

    const builder = new DOMTreeBuilder(trees);
    const { root } = builder.build();

    return root;
  }

  private getSnapshot(domId: string): DomSnapshot | undefined {
    const snapshot = this.cache.get(domId);
    if (snapshot) {
      snapshot.timestamp = Date.now();
    }
    return snapshot;
  }

  private setSnapshot(
    domId: string,
    snapshot: Omit<DomSnapshot, 'timestamp' | 'navigationIndex'>,
  ): void {
    this.evictIfNeeded();
    this.cache.set(domId, {
      ...snapshot,
      timestamp: Date.now(),
      navigationIndex: this.domIdCounter,
    });
  }

  getNavigationIndex(domId: string): number | undefined {
    return this.cache.get(domId)?.navigationIndex;
  }

  private evictIfNeeded(): void {
    if (this.cache.size >= this.maxCacheSize) {
      let oldestId: string | null = null;
      let oldestTime = Infinity;
      for (const [id, snapshot] of this.cache) {
        if (snapshot.timestamp < oldestTime) {
          oldestTime = snapshot.timestamp;
          oldestId = id;
        }
      }
      if (oldestId) {
        this.cache.delete(oldestId);
      }
    }
  }
}
