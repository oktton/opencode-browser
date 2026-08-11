/**
 * CDP Commands
 *
 * High-level CDP command wrappers for DOM extraction.
 */

import type { CDPClient } from './client';
import type { OOPIFManager } from './oopif-manager';
import type {
  DOMSnapshot,
  DOM,
  Accessibility,
  Page,
  Runtime,
} from '../dom/types/cdp';
import type { TargetAllTrees } from '../dom/types/snapshot';
import { REQUIRED_COMPUTED_STYLES } from '../dom/types/snapshot';

/**
 * CDP commands wrapper for DOM extraction
 */
export class CDPCommands {
  constructor(private client: CDPClient) {}

  /**
   * Get all trees in parallel (snapshot, DOM, AX, viewport)
   */
  async getAllTrees(options?: {
    maxIframes?: number;
    timeout?: number;
    oopifManager?: OOPIFManager;
  }): Promise<TargetAllTrees> {
    const { maxIframes = 100, timeout = 10000, oopifManager } = options ?? {};

    // Run all CDP commands in parallel
    const [snapshot, domTree, axTree, metrics] = await Promise.all([
      this.captureSnapshot({ timeout }),
      this.getDocument({ timeout }),
      this.getAccessibilityTreeForAllFrames({ timeout }),
      this.getLayoutMetrics({ timeout }),
    ]);

    // Limit documents to prevent iframe explosion
    if (snapshot.documents.length > maxIframes) {
      // limit frames silently
      snapshot.documents = snapshot.documents.slice(0, maxIframes);
    }

    // Calculate device pixel ratio
    const devicePixelRatio = this.calculateDevicePixelRatio(metrics);

    const result: TargetAllTrees = {
      snapshot,
      domTree,
      axTree,
      devicePixelRatio,
    };

    // Capture OOPIF (cross-origin iframe) trees if manager is provided
    if (oopifManager?.hasOOPIFs()) {
      try {
        result.oopifTrees = await oopifManager.captureAllOOPIFTrees();
      } catch (error) {
        // silently ignore OOPIF capture failures
      }
    }

    return result;
  }

  /**
   * Capture DOM snapshot
   */
  async captureSnapshot(options?: {
    timeout?: number;
  }): Promise<DOMSnapshot.CaptureSnapshotResponse> {
    const params = {
      computedStyles: [...REQUIRED_COMPUTED_STYLES],
      includePaintOrder: true,
      includeDOMRects: true,
      includeBlendedBackgroundColors: false,
      includeTextColorOpacities: false,
    };

    return this.client.sendCommandWithRetry<DOMSnapshot.CaptureSnapshotResponse>(
      'DOMSnapshot.captureSnapshot',
      params,
      {
        timeout: options?.timeout ?? 15000,
        maxRetries: 2,
      },
    );
  }

  /**
   * Get full DOM document tree
   */
  async getDocument(options?: {
    depth?: number;
    pierce?: boolean;
    timeout?: number;
  }): Promise<DOM.GetDocumentResponse> {
    const params = {
      depth: options?.depth ?? -1,
      pierce: options?.pierce ?? true,
    };

    return this.client.sendCommand<DOM.GetDocumentResponse>(
      'DOM.getDocument',
      params,
      options?.timeout ?? 10000,
    );
  }

  /**
   * Get accessibility tree for all frames
   */
  async getAccessibilityTreeForAllFrames(options?: {
    timeout?: number;
  }): Promise<Accessibility.GetFullAXTreeResponse> {
    try {
      // Get frame tree first
      const frameTree = await this.getFrameTree({ timeout: options?.timeout });

      // Collect all frame IDs
      const frameIds: string[] = [];
      const collectFrameIds = (node: Page.FrameTree) => {
        if (node.frame?.id) {
          frameIds.push(node.frame.id);
        }
        if (node.childFrames) {
          node.childFrames.forEach(collectFrameIds);
        }
      };
      collectFrameIds(frameTree.frameTree);

      // Get AX tree for each frame in parallel
      const axTreePromises = frameIds.map(frameId =>
        this.client
          .sendCommand<Accessibility.GetFullAXTreeResponse>(
            'Accessibility.getFullAXTree',
            { frameId },
            options?.timeout ?? 10000,
          )
          .catch(() => ({ nodes: [] })),
      );

      const axTrees = await Promise.all(axTreePromises);

      // Merge all AX nodes
      const mergedNodes = axTrees.flatMap(tree => tree.nodes);

      return { nodes: mergedNodes };
    } catch (error) {
      // silently ignore AX tree failures
      return { nodes: [] };
    }
  }

  /**
   * Get frame tree
   */
  async getFrameTree(options?: {
    timeout?: number;
  }): Promise<Page.GetFrameTreeResponse> {
    return this.client.sendCommand<Page.GetFrameTreeResponse>(
      'Page.getFrameTree',
      {},
      options?.timeout ?? 10000,
    );
  }

  /**
   * Get layout metrics
   */
  async getLayoutMetrics(options?: {
    timeout?: number;
  }): Promise<Page.GetLayoutMetricsResponse> {
    return this.client.sendCommand<Page.GetLayoutMetricsResponse>(
      'Page.getLayoutMetrics',
      {},
      options?.timeout ?? 10000,
    );
  }

  /**
   * Calculate device pixel ratio from layout metrics
   */
  private calculateDevicePixelRatio(
    metrics: Page.GetLayoutMetricsResponse,
  ): number {
    const visualViewport = metrics.visualViewport;
    const cssVisualViewport = metrics.cssVisualViewport;

    if (visualViewport && cssVisualViewport) {
      const deviceWidth = visualViewport.clientWidth;
      const cssWidth = cssVisualViewport.clientWidth;

      if (cssWidth > 0) {
        return deviceWidth / cssWidth;
      }
    }

    return 1.0;
  }

  /**
   * Get device pixel ratio directly
   */
  async getDevicePixelRatio(): Promise<number> {
    try {
      const metrics = await this.getLayoutMetrics();
      return this.calculateDevicePixelRatio(metrics);
    } catch {
      return 1.0;
    }
  }

  /**
   * Evaluate JavaScript expression
   */
  async evaluate<T = unknown>(
    expression: string,
    options?: {
      returnByValue?: boolean;
      timeout?: number;
    },
  ): Promise<T> {
    const params = {
      expression,
      returnByValue: options?.returnByValue ?? true,
    };

    const response = await this.client.sendCommand<Runtime.EvaluateResponse>(
      'Runtime.evaluate',
      params,
      options?.timeout ?? 10000,
    );

    if (response.exceptionDetails) {
      throw new Error(
        `[CDP] JavaScript evaluation failed: ${response.exceptionDetails.text}`,
      );
    }

    return response.result.value as T;
  }

  /**
   * Inject value attribute on all <select> elements so the snapshot captures current selection.
   * Called right before captureSnapshot; overwritten on each snapshot cycle.
   */
  async injectSelectValues(): Promise<void> {
    try {
      await this.evaluate(`
        document.querySelectorAll('select').forEach(sel => {
          const idx = sel.selectedIndex;
          if (idx >= 0 && sel.options[idx]) {
            sel.setAttribute('value', sel.options[idx].text);
          }
        })
      `);
    } catch {
      // Non-critical: if injection fails, select values just won't appear
    }
  }

  /**
   * Sync live input state back to HTML attributes before snapshot.
   * CDP DOMSnapshot captures attributes, not live DOM properties.
   */
  async injectInputValues(): Promise<void> {
    try {
      await this.evaluate(`
        document.querySelectorAll('input').forEach(el => {
          const type = el.type;
          if (type === 'checkbox' || type === 'radio') {
            if (el.checked) el.setAttribute('checked', 'checked');
            else el.removeAttribute('checked');
          } else if (type !== 'file' && type !== 'hidden' && type !== 'submit' && type !== 'button' && type !== 'reset' && type !== 'image') {
            if (el.value !== el.defaultValue) el.setAttribute('value', el.value);
          }
        })
      `);
    } catch {
      // Non-critical
    }
  }

  /**
   * Get document ready state
   */
  async getReadyState(): Promise<string> {
    return this.evaluate<string>('document.readyState');
  }

  /**
   * Get iframe scroll positions
   */
  async getIframeScrollPositions(): Promise<
    Record<string, { scrollTop: number; scrollLeft: number }>
  > {
    try {
      return await this.evaluate<
        Record<string, { scrollTop: number; scrollLeft: number }>
      >(`
        (() => {
          const scrollData = {};
          const iframes = document.querySelectorAll('iframe');
          iframes.forEach((iframe, index) => {
            try {
              const doc = iframe.contentDocument || iframe.contentWindow.document;
              if (doc) {
                scrollData[index] = {
                  scrollTop: doc.documentElement.scrollTop || doc.body.scrollTop || 0,
                  scrollLeft: doc.documentElement.scrollLeft || doc.body.scrollLeft || 0
                };
              }
            } catch (e) {
              // Cross-origin iframe, can't access
            }
          });
          return scrollData;
        })()
      `);
    } catch {
      return {};
    }
  }
}
