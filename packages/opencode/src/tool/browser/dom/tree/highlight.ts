/**
 * Highlight Index Assignment & Visual Overlay
 *
 * Assigns sequential highlightIndex to remaining isCandidate nodes after pruning,
 * then marks each element with a data attribute via CDP and injects a highlight
 * script into each frame. Each frame draws its own overlays using getClientRects(),
 * which update dynamically on scroll/resize.
 */

import type { EnhancedDOMTreeNode } from '../types/dom-node';
import type { CDPClient } from '../../cdp/client';
import type { OOPIFManager } from '../../cdp/oopif-manager';
import { nodeKey } from '../utils/index';

export type DOMSelectorMap = Map<number, EnhancedDOMTreeNode>;

/**
 * Create a CDP command sender that routes to the correct session.
 */
function createSendCommand(
  node: EnhancedDOMTreeNode,
  cdpClient: CDPClient,
  oopifManager?: OOPIFManager,
): <T>(method: string, params?: Record<string, unknown>) => Promise<T> {
  if (node.oopifSessionId && oopifManager) {
    const sessionId = node.oopifSessionId;
    return <T>(method: string, params?: Record<string, unknown>) =>
      oopifManager.sendCommand<T>(sessionId, method, params);
  }
  return <T>(method: string, params?: Record<string, unknown>) =>
    cdpClient.sendCommand<T>(method, params);
}

const HIGHLIGHT_ATTR = 'data-hl-idx';
const HIGHLIGHT_CONTAINER_ID = '__elements_highlight_container__';

/**
 * Assign sequential highlightIndex and highlight elements in the page.
 * Returns the selectorMap for element lookup by index.
 *
 * @param root - The pruned tree to process (will be modified)
 * @param cdpClient - CDP client for browser communication
 * @param oopifManager - OOPIF manager for cross-origin iframes
 * @param lookup - If provided, writes highlightIndex back to original tree nodes via this lookup
 * @param options.highlight - Whether to inject visual highlight overlays into the page (default: true)
 */
export async function assignAndHighlight(
  root: EnhancedDOMTreeNode,
  cdpClient: CDPClient,
  oopifManager?: OOPIFManager,
  lookup?: Map<string, EnhancedDOMTreeNode>,
  options?: { highlight?: boolean },
): Promise<DOMSelectorMap> {
  const selectorMap = assignHighlightIndices(root, lookup);
  if (options?.highlight !== false) {
    await highlightElements(selectorMap, cdpClient, oopifManager);
  }
  return selectorMap;
}

/**
 * Assign backendNodeId as highlightIndex to all isCandidate nodes.
 * Using backendNodeId ensures stable indices across DOM snapshots of the same page,
 * so AI can reuse indices from a previous full DOM when reading a diff.
 */
function assignHighlightIndices(
  root: EnhancedDOMTreeNode,
  originalLookup?: Map<string, EnhancedDOMTreeNode>,
): DOMSelectorMap {
  const selectorMap: DOMSelectorMap = new Map();

  const visit = (node: EnhancedDOMTreeNode): void => {
    if (
      node.renderInfo?.isCandidate &&
      !node.renderInfo.isSelect &&
      (!node.renderInfo?.isDuplicateListener ||
        node.renderInfo.isSelectOption ||
        node.renderInfo.isFill) &&
      (!node.renderInfo.expandedViewportPosition ||
        node.renderInfo.diffStatus === 'removed')
    ) {
      const id = node.backendNodeId;
      node.renderInfo.highlightIndex = id;
      selectorMap.set(id, node);
      const originalNode = originalLookup?.get(nodeKey(node));
      if (originalNode?.renderInfo) {
        originalNode.renderInfo.highlightIndex = id;
      }
    }

    for (const child of node.childrenNodes ?? []) {
      visit(child);
    }
  };

  visit(root);
  return selectorMap;
}

/**
 * Mark each candidate element with a data attribute, then inject
 * the highlight script into every frame that contains candidates.
 */
async function highlightElements(
  selectorMap: DOMSelectorMap,
  cdpClient: CDPClient,
  oopifManager?: OOPIFManager,
): Promise<void> {
  if (selectorMap.size === 0) return;

  try {
    await cdpClient.sendCommand('DOM.enable');
  } catch {
    // May already be enabled
  }

  // Clean up previous highlights before re-marking
  await cleanupHighlights(cdpClient, oopifManager);

  // Track which frameIds have candidate elements (main frame only)
  const frameIds = new Set<string | undefined>();
  // Track which OOPIF sessions have candidate elements
  const oopifSessionIds = new Set<string>();

  // Mark each element with data-hl-idx via CDP
  for (const [index, node] of selectorMap) {
    try {
      const sendCmd = createSendCommand(node, cdpClient, oopifManager);

      const result = await sendCmd<{
        object: { objectId?: string };
      }>('DOM.resolveNode', { backendNodeId: node.backendNodeId });

      const objectId = result?.object?.objectId;
      if (!objectId) continue;

      // setAttribute runs in the element's own frame context via callFunctionOn
      await sendCmd('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() { this.setAttribute('${HIGHLIGHT_ATTR}', '${index}'); }`,
        awaitPromise: false,
      });

      if (node.oopifSessionId) {
        oopifSessionIds.add(node.oopifSessionId);
      } else {
        // IFRAME/FRAME elements have frameId pointing to their HOSTED content frame,
        // not the parent frame they live in — use parent's frameId for script injection
        const tag = node.nodeName?.toUpperCase();
        if (tag === 'IFRAME' || tag === 'FRAME') {
          frameIds.add(node.parentNode?.frameId);
        } else {
          frameIds.add(node.frameId);
        }
      }
    } catch {
      // Element may not be resolvable
    }
  }

  // Inject highlight script into each frame
  const script = generateDynamicHighlightScript();

  // Main frame and same-origin sub-frames
  for (const frameId of frameIds) {
    try {
      if (!frameId) {
        await cdpClient.sendCommand('Runtime.evaluate', {
          expression: script,
          awaitPromise: false,
        });
      } else {
        const contextResult = await cdpClient.sendCommand<{
          executionContextId: number;
        }>('Page.createIsolatedWorld', {
          frameId,
          worldName: '__highlight__',
          grantUniveralAccess: true,
        });
        if (contextResult?.executionContextId) {
          await cdpClient.sendCommand('Runtime.evaluate', {
            expression: script,
            contextId: contextResult.executionContextId,
            awaitPromise: false,
          });
        }
      }
    } catch (error) {
      console.error(
        `[Highlight] Failed to inject into frame ${frameId}:`,
        error,
      );
    }
  }

  // OOPIF sessions: inject highlight script directly via session
  if (oopifManager) {
    for (const rawSessionId of oopifSessionIds) {
      const sessionId = oopifManager.resolveSessionId(rawSessionId);
      try {
        await oopifManager.sendCommand(sessionId, 'Runtime.evaluate', {
          expression: script,
          awaitPromise: false,
        });
      } catch (error) {
        console.warn(
          `[Highlight] Failed to inject into OOPIF session ${rawSessionId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}

/**
 * Run cleanup functions and remove old overlay containers in all frames.
 */
async function cleanupHighlights(
  cdpClient: CDPClient,
  oopifManager?: OOPIFManager,
): Promise<void> {
  const cleanupScript = `
(function() {
  if (window._highlightCleanupFunctions) {
    window._highlightCleanupFunctions.forEach(function(fn) { fn(); });
    window._highlightCleanupFunctions = [];
  }
  var c = document.getElementById('${HIGHLIGHT_CONTAINER_ID}');
  if (c) { try { if (typeof c.hidePopover === 'function') c.hidePopover(); } catch(e) {} c.remove(); }
  function removeAttrDeep(root) {
    root.querySelectorAll('[${HIGHLIGHT_ATTR}]').forEach(function(el) {
      el.removeAttribute('${HIGHLIGHT_ATTR}');
    });
    root.querySelectorAll('*').forEach(function(el) {
      if (el.shadowRoot) removeAttrDeep(el.shadowRoot);
    });
  }
  removeAttrDeep(document);
})();
`;
  try {
    // Clean main frame
    await cdpClient.sendCommand('Runtime.evaluate', {
      expression: cleanupScript,
      awaitPromise: false,
    });
    // Clean all sub-frames via Page.getFrameTree + evaluate in each
    const frameTree = await cdpClient.sendCommand<{
      frameTree: {
        frame: { id: string };
        childFrames?: Array<{ frame: { id: string } }>;
      };
    }>('Page.getFrameTree');
    const subFrames = collectFrameIds(frameTree?.frameTree);
    for (const frameId of subFrames) {
      try {
        const ctx = await cdpClient.sendCommand<{
          executionContextId: number;
        }>('Page.createIsolatedWorld', {
          frameId,
          worldName: '__highlight_cleanup__',
          grantUniveralAccess: true,
        });
        if (ctx?.executionContextId) {
          await cdpClient.sendCommand('Runtime.evaluate', {
            expression: cleanupScript,
            contextId: ctx.executionContextId,
            awaitPromise: false,
          });
        }
      } catch {
        // Frame may have been removed
      }
    }
  } catch {
    // Ignore cleanup errors
  }

  // Clean OOPIF sessions
  if (oopifManager) {
    for (const session of oopifManager.getSessions()) {
      try {
        await oopifManager.sendCommand(session.sessionId, 'Runtime.evaluate', {
          expression: cleanupScript,
          awaitPromise: false,
        });
      } catch {
        // OOPIF may have been removed
      }
    }
  }
}

/**
 * Recursively collect child frame IDs from a frame tree.
 */
function collectFrameIds(
  frameTree:
    | {
        frame: { id: string };
        childFrames?: Array<{
          frame: { id: string };
          childFrames?: Array<any>;
        }>;
      }
    | undefined,
): string[] {
  if (!frameTree?.childFrames) return [];
  const ids: string[] = [];
  for (const child of frameTree.childFrames) {
    ids.push(child.frame.id);
    ids.push(...collectFrameIds(child));
  }
  return ids;
}

function generateDynamicHighlightScript(): string {
  const colors = [
    '#FF0000',
    '#00FF00',
    '#0000FF',
    '#FFA500',
    '#800080',
    '#008080',
    '#FF69B4',
    '#4B0082',
    '#FF4500',
    '#2E8B57',
    '#DC143C',
    '#4682B4',
  ];

  return `
(function() {
  var CONTAINER_ID = '${HIGHLIGHT_CONTAINER_ID}';
  var ATTR = '${HIGHLIGHT_ATTR}';
  var colors = ${JSON.stringify(colors)};

  // Recursively find marked elements, piercing shadow DOM boundaries
  function findMarkedElements(root) {
    var result = [];
    var els = root.querySelectorAll('[' + ATTR + ']');
    for (var i = 0; i < els.length; i++) result.push(els[i]);
    // Search inside shadow roots
    var allEls = root.querySelectorAll('*');
    for (var j = 0; j < allEls.length; j++) {
      if (allEls[j].shadowRoot) {
        var shadowResults = findMarkedElements(allEls[j].shadowRoot);
        for (var k = 0; k < shadowResults.length; k++) result.push(shadowResults[k]);
      }
    }
    return result;
  }
  var elements = findMarkedElements(document);
  if (elements.length === 0) return;

  var container = document.createElement('div');
  container.id = CONTAINER_ID;
  container.style.position = 'fixed';
  container.style.pointerEvents = 'none';
  container.style.top = '0';
  container.style.left = '0';
  container.style.width = '100%';
  container.style.height = '100%';
  container.style.zIndex = '2147483647';
  container.style.backgroundColor = 'transparent';
  // Place in top layer to render above dialog/popover elements
  if (typeof container.showPopover === 'function') {
    container.setAttribute('popover', 'manual');
    document.body.appendChild(container);
    try { container.showPopover(); } catch(e) { /* fallback to normal flow */ }
  } else {
    document.body.appendChild(container);
  }

  var cleanupFunctions = [];

  elements.forEach(function(element) {
    var index = parseInt(element.getAttribute(ATTR), 10);
    var colorIndex = index % colors.length;
    var baseColor = colors[colorIndex];
    var backgroundColor = baseColor + '1A';

    var overlays = [];
    var label = null;
    var labelWidth = 20;
    var labelHeight = 16;

    function updatePositions() {
      var rects = element.getClientRects();

      for (var i = 0; i < rects.length; i++) {
        var rect = rects[i];
        if (rect.width === 0 || rect.height === 0) {
          if (overlays[i]) overlays[i].style.display = 'none';
          continue;
        }

        var overlay = overlays[i];
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.style.position = 'fixed';
          overlay.style.border = '2px solid ' + baseColor;
          overlay.style.backgroundColor = backgroundColor;
          overlay.style.pointerEvents = 'none';
          overlay.style.boxSizing = 'border-box';
          container.appendChild(overlay);
          overlays[i] = overlay;
        }

        overlay.style.top = rect.top + 'px';
        overlay.style.left = rect.left + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
        overlay.style.display = 'block';
      }

      for (var j = rects.length; j < overlays.length; j++) {
        overlays[j].style.display = 'none';
      }

      if (rects.length > 0) {
        var firstRect = rects[0];

        if (!label) {
          label = document.createElement('div');
          label.style.position = 'fixed';
          label.style.background = baseColor;
          label.style.color = 'white';
          label.style.padding = '1px 4px';
          label.style.borderRadius = '4px';
          label.style.fontSize = Math.min(12, Math.max(8, firstRect.height / 2)) + 'px';
          label.style.pointerEvents = 'none';
          label.textContent = index;
          container.appendChild(label);

          if (label.offsetWidth > 0) labelWidth = label.offsetWidth;
          if (label.offsetHeight > 0) labelHeight = label.offsetHeight;
        }

        var labelTop = firstRect.top + 2;
        var labelLeft = firstRect.left + firstRect.width - labelWidth - 2;

        if (firstRect.width < labelWidth + 4 || firstRect.height < labelHeight + 4) {
          labelTop = firstRect.top - labelHeight - 2;
          labelLeft = firstRect.left + firstRect.width - labelWidth;
          if (labelLeft < 0) labelLeft = firstRect.left;
        }

        labelTop = Math.max(0, Math.min(labelTop, window.innerHeight - labelHeight));
        labelLeft = Math.max(0, Math.min(labelLeft, window.innerWidth - labelWidth));

        label.style.top = labelTop + 'px';
        label.style.left = labelLeft + 'px';
        label.style.display = 'block';
      } else if (label) {
        label.style.display = 'none';
      }
    }

    updatePositions();

    var lastCall = 0;
    var throttledUpdate = function() {
      var now = performance.now();
      if (now - lastCall < 16) return;
      lastCall = now;
      updatePositions();
    };

    window.addEventListener('scroll', throttledUpdate, true);
    window.addEventListener('resize', throttledUpdate);

    cleanupFunctions.push(function() {
      window.removeEventListener('scroll', throttledUpdate, true);
      window.removeEventListener('resize', throttledUpdate);
      overlays.forEach(function(o) { o.remove(); });
      if (label) label.remove();
    });
  });

  window._highlightCleanupFunctions = cleanupFunctions;
})();
`;
}
