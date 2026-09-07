/**
 * Render Info Calculator
 *
 * Computes render information directly on EnhancedDOMTreeNode.
 * Uses DOM.getNodeForLocation to check if elements are visible at their position.
 */

import { type EnhancedDOMTreeNode, NodeType } from '../types/dom-node';
import { ClickableElementDetector } from './clickable-detector';
import { checkElementVisibility, type ParentFrameState } from './visibility';
import { fetchAxForUsedNodes } from './ax-fetch';
import type { CDPClient } from '../../cdp/client';
import type { OOPIFManager } from '../../cdp/oopif-manager';

/**
 * Options for computeRenderInfo
 */
export interface ComputeRenderInfoOptions {
  /** Expand viewport range in pages (1 = one viewport height/width) for marking elements outside visible area */
  expand?: number;
}

/**
 * Compute render info for DOM tree
 */
export async function computeRenderInfo(
  root: EnhancedDOMTreeNode,
  cdpClient: CDPClient,
  options?: ComputeRenderInfoOptions,
  oopifManager?: OOPIFManager,
): Promise<void> {
  const expand = options?.expand;

  // Step 1: Initialize renderInfo on all nodes (also computes expandedViewportPosition via visibility check)
  initRenderInfo(root, undefined, [], expand);

  // Step 2: Check top elements using DOM.getNodeForLocation
  await checkTopElements(root, cdpClient, oopifManager);

  // Step 3: Mark interactive top elements as candidates
  markInteractiveCandidates(root);

  // Step 4: Fetch click listener signatures for all candidate nodes
  await fetchClickListenerSignatures(root, cdpClient, oopifManager);

  // Step 5: Mark descendant candidates as isDuplicateListener if they share listener signatures with an ancestor
  deduplicateByListeners(root);

  // Step 6: Fetch accessible names, now that we know which nodes can use them
  await fetchAxForUsedNodes(root, cdpClient, oopifManager);
}


const SCROLLABLE_OVERFLOW_VALUES = new Set([
  'auto',
  'scroll',
  'overlay',
  'hidden',
]);
const OVERLAY_COVERAGE_THRESHOLD = 0.75;
const HIGHLIGHT_CONTAINER_ID = '__elements_highlight_container__';
const COMMON_CONTAINER_TAGS = new Set([
  'div',
  'main',
  'section',
  'article',
  'aside',
  'nav',
  'body',
  'html',
]);

interface ViewportSize {
  width: number;
  height: number;
}

function getMainViewportSize(root: EnhancedDOMTreeNode): ViewportSize | null {
  let bestArea = 0;
  let viewport: ViewportSize | null = null;

  const visit = (node: EnhancedDOMTreeNode): void => {
    if (node.nodeName === 'HTML') {
      const clientRects = node.snapshotNode?.clientRects;
      if (clientRects && clientRects.width > 0 && clientRects.height > 0) {
        const area = clientRects.width * clientRects.height;
        if (area > bestArea) {
          bestArea = area;
          viewport = {
            width: clientRects.width,
            height: clientRects.height,
          };
        }
      }
    }

    for (const child of node.childrenNodes ?? []) {
      visit(child);
    }
    for (const shadowRoot of node.shadowRoots ?? []) {
      visit(shadowRoot);
    }
    if (node.contentDocument) {
      visit(node.contentDocument);
    }
  };

  visit(root);
  return viewport;
}

function getViewportCoverageRatio(
  bounds: { x: number; y: number; width: number; height: number },
  viewport: ViewportSize,
): number {
  const overlapLeft = Math.max(0, bounds.x);
  const overlapTop = Math.max(0, bounds.y);
  const overlapRight = Math.min(viewport.width, bounds.x + bounds.width);
  const overlapBottom = Math.min(viewport.height, bounds.y + bounds.height);
  const overlapWidth = Math.max(0, overlapRight - overlapLeft);
  const overlapHeight = Math.max(0, overlapBottom - overlapTop);
  const overlapArea = overlapWidth * overlapHeight;
  const viewportArea = viewport.width * viewport.height;

  return viewportArea > 0 ? overlapArea / viewportArea : 0;
}

function isVisuallyHiddenNativeControl(node: EnhancedDOMTreeNode): boolean {
  if (node.nodeType !== NodeType.ELEMENT_NODE) {
    return false;
  }

  const tag = node.nodeName.toLowerCase();

  // Native <select> elements are often hidden (opacity:0 / zero-size) by UI
  // libraries that render a custom dropdown via Shadow DOM on top.
  const isHiddenSelect = tag === 'select';

  const isHiddenCheckboxRadio =
    tag === 'input' &&
    ['checkbox', 'radio'].includes(
      (node.attributes?.type ?? 'text').toLowerCase(),
    );

  if (!isHiddenSelect && !isHiddenCheckboxRadio) {
    return false;
  }

  const bounds = node.snapshotNode?.bounds;
  const opacityRaw = node.snapshotNode?.computedStyles?.opacity ?? '1';
  const opacity = Number.parseFloat(opacityRaw);
  const isOpacityHidden = Number.isFinite(opacity) && opacity <= 0;
  const isZeroSize = !!bounds && (bounds.width <= 0 || bounds.height <= 0);

  return isOpacityHidden || isZeroSize;
}

/**
 * Check if a node is a scrollable container.
 * Compares scrollRects vs clientRects (+1 tolerance for float rounding),
 * then validates CSS overflow allows scrolling.
 */
function checkIsScrollable(
  node: EnhancedDOMTreeNode,
  htmlFrames: EnhancedDOMTreeNode[],
): boolean {
  // Top-frame HTML/BODY scrolling is the main page scroll (container 0), not a separate container.
  // Iframe HTML/BODY may be genuine scroll containers.
  const tag = node.nodeName.toLowerCase();
  const isInIframe = htmlFrames.some(
    f => f.nodeName === 'IFRAME' || f.nodeName === 'FRAME',
  );
  if ((tag === 'html' || tag === 'body') && !isInIframe) return false;

  const snapshot = node.snapshotNode;
  if (!snapshot?.scrollRects || !snapshot?.clientRects) return false;

  const hasVerticalScroll =
    snapshot.scrollRects.height > snapshot.clientRects.height + 1;
  const hasHorizontalScroll =
    snapshot.scrollRects.width > snapshot.clientRects.width + 1;

  if (!hasVerticalScroll && !hasHorizontalScroll) return false;

  const styles = snapshot.computedStyles;
  if (!styles) {
    return COMMON_CONTAINER_TAGS.has(node.nodeName.toLowerCase());
  }

  const overflowY = styles['overflow-y'] ?? styles['overflow'] ?? 'visible';
  const overflowX = styles['overflow-x'] ?? styles['overflow'] ?? 'visible';

  const result =
    (hasVerticalScroll && SCROLLABLE_OVERFLOW_VALUES.has(overflowY)) ||
    (hasHorizontalScroll && SCROLLABLE_OVERFLOW_VALUES.has(overflowX));

  return result;
}

/**
 * Find the first scrollable container inside shadow roots.
 * Used to propagate scrollableContainerId to slotted light DOM children.
 */
function findShadowScrollContainer(
  shadowRoots: EnhancedDOMTreeNode[],
): number | undefined {
  for (const shadowRoot of shadowRoots) {
    const result = findFirstScrollable(shadowRoot);
    if (result !== undefined) return result;
  }
  return undefined;
}

function findFirstScrollable(node: EnhancedDOMTreeNode): number | undefined {
  if (node.renderInfo?.isScrollable) {
    return node.backendNodeId;
  }
  for (const child of node.childrenNodes ?? []) {
    const result = findFirstScrollable(child);
    if (result !== undefined) return result;
  }
  return undefined;
}

/**
 * Initialize renderInfo on all nodes in the tree.
 * Also computes expandedViewportPosition using frame-aware visibility check.
 */
function initRenderInfo(
  node: EnhancedDOMTreeNode,
  parentScrollableId?: number,
  htmlFrames: EnhancedDOMTreeNode[] = [],
  expand?: number,
  parentFrameState: ParentFrameState = 'visible',
): void {
  // Check for shadow host
  const shadowRoots = node.shadowRoots ?? [];
  const isShadowHost = shadowRoots.length > 0;
  const isIframeHost = node.contentDocument !== undefined;

  // Check if element is interactive
  const isInteractive = ClickableElementDetector.isInteractive(node);
  const isFill = ClickableElementDetector.isFillable(node);
  node.renderInfo.isVisuallyHiddenNativeControl =
    isVisuallyHiddenNativeControl(node);

  const isScrollable = checkIsScrollable(node, htmlFrames);
  const scrollableId = isScrollable ? node.backendNodeId : parentScrollableId;

  // Frame-aware visibility + expanded viewport position
  const visResult = checkElementVisibility(
    node,
    htmlFrames,
    expand,
    parentFrameState,
  );

  // Update renderInfo
  node.renderInfo.isVisible = visResult.isVisible;
  node.renderInfo.isInteractive = isInteractive;
  node.renderInfo.isTopElement = false;
  node.renderInfo.expandedViewportPosition = visResult.expandedViewportPosition;
  node.renderInfo.isScrollable = isScrollable;
  node.renderInfo.scrollableContainerId = parentScrollableId;
  node.renderInfo.isSelectOption = false;
  node.renderInfo.isShadowHost = isShadowHost;
  node.renderInfo.isIframeHost = isIframeHost;
  node.renderInfo.isFill = isFill;

  // Track HTML frames for children. Only frame nodes extend the list, so the
  // copy is made when one is found rather than at every node.
  const upper =
    node.nodeType === NodeType.ELEMENT_NODE ? node.nodeName.toUpperCase() : '';
  const isFrameElement = upper === 'IFRAME' || upper === 'FRAME';
  const isFrameHtml =
    node.nodeType === NodeType.ELEMENT_NODE &&
    node.nodeName === 'HTML' &&
    !!node.frameId;
  const updatedFrames =
    isFrameElement || isFrameHtml ? [...htmlFrames, node] : htmlFrames;

  // Process shadow roots first — discover scrollable containers inside them
  // so slotted light DOM children inherit the correct scrollableContainerId.
  // (e.g. Ionic's ion-content has <main class="inner-scroll"><slot/></main> in shadow DOM)
  for (const shadowRoot of shadowRoots) {
    initRenderInfo(
      shadowRoot,
      scrollableId,
      updatedFrames,
      expand,
      parentFrameState,
    );
  }

  // For shadow hosts, find the first scrollable container inside shadow roots
  // to use as scrollableId for slotted light DOM children
  let childScrollableId = scrollableId;
  if (isShadowHost) {
    const shadowScrollId = findShadowScrollContainer(shadowRoots);
    if (shadowScrollId !== undefined) {
      childScrollableId = shadowScrollId;
    }
  }

  // Process children (light DOM — may be slotted into shadow root's scroll container)
  const children = node.childrenNodes ?? [];
  for (const child of children) {
    initRenderInfo(
      child,
      childScrollableId,
      updatedFrames,
      expand,
      parentFrameState,
    );
  }

  // Process content document (iframes)
  // Compute iframe's own visibility state and propagate to children
  if (node.contentDocument) {
    let iframeState: ParentFrameState = parentFrameState;
    if (parentFrameState === 'visible') {
      // iframe visible in parent → compute its own state for children
      const iframeVis = checkElementVisibility(node, htmlFrames, expand);
      if (iframeVis.isVisible) {
        iframeState = 'visible';
      } else if (iframeVis.expandedViewportPosition) {
        iframeState = iframeVis.expandedViewportPosition;
      } else {
        iframeState = 'hidden';
      }
    }
    // parentFrameState is expand/hidden → children inherit it directly
    initRenderInfo(
      node.contentDocument,
      scrollableId,
      updatedFrames,
      expand,
      iframeState,
    );
  }
}

/**
 * Walk up hit node's parent chain via CDP to check if it's related to the target.
 * Needed when hit node is not in our tree (e.g., shadow DOM internals, pseudo-elements).
 */
export async function checkHitNodeParentChain(
  sendCmd: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  hitBackendNodeId: number,
  targetBackendNodeId: number,
  targetAncestors: Set<number>,
  nodeByBackendId: Map<number, EnhancedDOMTreeNode>,
  maxDepth = 20,
): Promise<boolean> {
  let currentBackendNodeId = hitBackendNodeId;

  for (let depth = 0; depth < maxDepth; depth++) {
    try {
      const nodeInfo = await sendCmd<{
        node: { nodeId: number; backendNodeId: number; parentId?: number };
      }>('DOM.describeNode', {
        backendNodeId: currentBackendNodeId,
        depth: 0,
      });

      const parentNodeId = nodeInfo.node.parentId;
      if (!parentNodeId) return false;

      const parentInfo = await sendCmd<{
        node: { backendNodeId: number };
      }>('DOM.describeNode', { nodeId: parentNodeId, depth: 0 });

      const parentBackendNodeId = parentInfo.node.backendNodeId;

      if (parentBackendNodeId === targetBackendNodeId) return true;
      if (targetAncestors.has(parentBackendNodeId)) return true;

      const parentNode = nodeByBackendId.get(parentBackendNodeId);
      if (parentNode) {
        let current = parentNode.parentNode;
        while (current) {
          if (current.backendNodeId === targetBackendNodeId) return true;
          current = current.parentNode;
        }
        return false;
      }

      currentBackendNodeId = parentBackendNodeId;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Run elementFromPoint via Runtime.evaluate, resolve to backendNodeId.
 */
export async function elementFromPoint(
  sendCmd: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  centerX: number,
  centerY: number,
): Promise<number | undefined> {
  // One round trip. Resolving the same point through
  // document.elementFromPoint costs four (evaluate -> requestNode ->
  // releaseObject -> describeNode) and this runs once per visible node, so it
  // used to dominate live extraction time.
  //
  // It hit-tests the page rather than a document, so it pierces into child
  // frames and can land on a ::before/::after pseudo-element; checkTopElements
  // maps those back to the element that owns them.
  const hit = await sendCmd<{ backendNodeId?: number }>(
    'DOM.getNodeForLocation',
    { x: centerX, y: centerY },
  ).catch(() => undefined);

  return hit?.backendNodeId;
}

/**
 * Scroll offset of the main frame's document, as the builder subtracted it when
 * turning snapshot bounds into viewport-relative absolutePosition.
 */
function findMainFrameScroll(root: EnhancedDOMTreeNode): { x: number; y: number } {
  let found: { x: number; y: number } | null = null;

  const visit = (node: EnhancedDOMTreeNode): void => {
    if (found) return;
    // Stop at frame boundaries: only the top document's scroll applies here
    if (node.contentDocument) return;
    if (node.nodeName === 'HTML' && node.frameId && node.snapshotNode?.scrollRects) {
      found = {
        x: node.snapshotNode.scrollRects.x,
        y: node.snapshotNode.scrollRects.y,
      };
      return;
    }
    for (const child of node.childrenNodes ?? []) visit(child);
  };

  visit(root);
  return found ?? { x: 0, y: 0 };
}

/**
 * Check if elements are top-level (not occluded) using elementFromPoint.
 */
async function checkTopElements(
  root: EnhancedDOMTreeNode,
  cdpClient: CDPClient,
  oopifManager?: OOPIFManager,
): Promise<void> {
  const nodesToCheck: EnhancedDOMTreeNode[] = [];
  const nodeByBackendId = new Map<number, EnhancedDOMTreeNode>();

  // A hit can land on a ::before/::after pseudo-element, which has no tree node
  // and whose DOM.describeNode carries no parentId — so it has to be resolved
  // to its owning element here, from data the DOM tree already carries.
  const pseudoToHost = new Map<number, number>();

  const collectNodes = (node: EnhancedDOMTreeNode) => {
    if (node.renderInfo.isVisible) {
      nodesToCheck.push(node);
      nodeByBackendId.set(node.backendNodeId, node);
    }
    for (const pseudoId of node.pseudoElementIds ?? []) {
      pseudoToHost.set(pseudoId, node.backendNodeId);
    }
    for (const child of node.childrenNodes ?? []) {
      collectNodes(child);
    }
    for (const shadowRoot of node.shadowRoots ?? []) {
      collectNodes(shadowRoot);
    }
    if (node.contentDocument) {
      collectNodes(node.contentDocument);
    }
  };
  collectNodes(root);

  if (nodesToCheck.length === 0) return;

  // DOM.getNodeForLocation hit-tests in document coordinates, while
  // absolutePosition is relative to the viewport (the builder subtracts the
  // main frame's scroll offset). Without adding it back, every probe on a
  // scrolled page lands outside the document and comes back "No node found at
  // given location" — which reads as "nothing is a top element" and empties
  // the extraction of every interactive element.
  const mainScroll = findMainFrameScroll(root);

  // Build ancestor lookup within the same frame (stop at iframe/OOPIF boundary)
  const getAncestorBackendIds = (node: EnhancedDOMTreeNode): Set<number> => {
    const ancestors = new Set<number>();
    const sessionId = node.oopifSessionId;
    let current = node.parentNode;
    while (current) {
      if (current.oopifSessionId !== sessionId) break;
      ancestors.add(current.backendNodeId);
      current = current.parentNode;
    }
    return ancestors;
  };

  const checkPromises = nodesToCheck.map(async node => {
    // absolutePosition = viewport coords for main frame, includes frame offset for iframes
    const pos = node.absolutePosition ?? node.snapshotNode?.bounds;
    if (!pos) {
      node.renderInfo.isTopElement = false;
      return;
    }
    const centerX = Math.round(pos.x + pos.width / 2 + mainScroll.x);
    const centerY = Math.round(pos.y + pos.height / 2 + mainScroll.y);

    const ancestors = getAncestorBackendIds(node);

    // Build sendCmd for the appropriate session
    const sendCmd =
      node.oopifSessionId && oopifManager
        ? <T>(method: string, params?: Record<string, unknown>) =>
            oopifManager.sendCommand<T>(node.oopifSessionId!, method, params)
        : <T>(method: string, params?: Record<string, unknown>) =>
            cdpClient.sendCommand<T>(method, params);

    try {
      // For OOPIF nodes, use local coords within their session
      let hitBackendNodeId: number | undefined;
      if (node.oopifSessionId && oopifManager) {
        const localBounds = node.snapshotNode?.bounds;
        if (!localBounds) {
          node.renderInfo.isTopElement = false;
          return;
        }
        const localX = Math.round(localBounds.x + localBounds.width / 2);
        const localY = Math.round(localBounds.y + localBounds.height / 2);
        hitBackendNodeId = await elementFromPoint(sendCmd, localX, localY);
      } else {
        hitBackendNodeId = await elementFromPoint(sendCmd, centerX, centerY);
      }

      if (hitBackendNodeId === undefined) {
        node.renderInfo.isTopElement = false;
        return;
      }

      hitBackendNodeId = pseudoToHost.get(hitBackendNodeId) ?? hitBackendNodeId;

      node.renderInfo.hitBackendNodeId = hitBackendNodeId;

      if (hitBackendNodeId === node.backendNodeId) {
        node.renderInfo.isTopElement = true;
        return;
      }

      if (ancestors.has(hitBackendNodeId)) {
        node.renderInfo.isTopElement = true;
        return;
      }

      // Check if hit node is a descendant of self
      const hitNode = nodeByBackendId.get(hitBackendNodeId);
      if (hitNode) {
        const hitAncestors = getAncestorBackendIds(hitNode);
        if (hitAncestors.has(node.backendNodeId)) {
          node.renderInfo.isTopElement = true;
          return;
        }
      } else {
        // Hit node not in our tree (e.g., shadow DOM internals)
        const isRelated = await checkHitNodeParentChain(
          sendCmd,
          hitBackendNodeId,
          node.backendNodeId,
          ancestors,
          nodeByBackendId,
        );
        if (isRelated) {
          node.renderInfo.isTopElement = true;
          return;
        }
      }

      node.renderInfo.isTopElement = false;
    } catch {
      node.renderInfo.isTopElement = false;
    }
  });

  await Promise.all(checkPromises);
}

/**
 * Mark interactive top elements as candidates (no index assignment yet)
 * For expanded viewport elements, only mark as candidate if not covered by overlay
 */
function markInteractiveCandidates(root: EnhancedDOMTreeNode): void {
  const expandElements: EnhancedDOMTreeNode[] = [];
  const visibleElements: EnhancedDOMTreeNode[] = [];

  const markSelectDescendantsAsCandidates = (
    node: EnhancedDOMTreeNode,
  ): void => {
    const visit = (current: EnhancedDOMTreeNode): void => {
      if (current.nodeType === NodeType.ELEMENT_NODE) {
        const tagName = current.nodeName.toLowerCase();
        if (tagName === 'option' || tagName === 'optgroup') {
          current.renderInfo.isCandidate = true;
          current.renderInfo.isSelectOption = true;
        }
      }

      for (const child of current.childrenNodes ?? []) {
        visit(child);
      }
      for (const shadowRoot of current.shadowRoots ?? []) {
        visit(shadowRoot);
      }
      if (current.contentDocument) {
        visit(current.contentDocument);
      }
    };

    for (const child of node.childrenNodes ?? []) {
      visit(child);
    }
  };

  const collectElements = (node: EnhancedDOMTreeNode): void => {
    if (node.renderInfo?.isVisible && node.nodeType === NodeType.ELEMENT_NODE) {
      visibleElements.push(node);
    }
    if (node.renderInfo?.expandedViewportPosition !== undefined) {
      expandElements.push(node);
    }

    for (const child of node.childrenNodes ?? []) {
      collectElements(child);
    }
    for (const shadowRoot of node.shadowRoots ?? []) {
      collectElements(shadowRoot);
    }
    if (node.contentDocument) {
      collectElements(node.contentDocument);
    }
  };
  collectElements(root);

  let highestOverlayPaintOrder: number | undefined;
  let highestOverlayNode: EnhancedDOMTreeNode | undefined;

  if (expandElements.length > 0) {
    const viewport = getMainViewportSize(root);
    if (viewport) {
      const largeVisibleElements = visibleElements.filter(node => {
        const tagName = node.nodeName.toLowerCase();
        if (tagName === 'html' || tagName === 'body') {
          return false;
        }
        if (node.attributes.id === HIGHLIGHT_CONTAINER_ID) {
          return false;
        }

        // Only fixed/absolute positioned elements can be overlays
        const styles = node.snapshotNode?.computedStyles;
        const position = styles?.['position'];
        if (position !== 'fixed' && position !== 'absolute') {
          return false;
        }

        // pointer-events:none elements don't block interaction
        if (styles?.['pointer-events'] === 'none') {
          return false;
        }

        const bounds = node.absolutePosition ?? node.snapshotNode?.bounds;
        if (!bounds) {
          return false;
        }

        const coverageRatio = getViewportCoverageRatio(bounds, viewport);
        return coverageRatio >= OVERLAY_COVERAGE_THRESHOLD;
      });

      if (largeVisibleElements.length > 0) {
        highestOverlayNode = largeVisibleElements.reduce((highest, node) => {
          const highestPaintOrder = highest.snapshotNode?.paintOrder ?? 0;
          const nodePaintOrder = node.snapshotNode?.paintOrder ?? 0;
          return nodePaintOrder > highestPaintOrder ? node : highest;
        });
        highestOverlayPaintOrder =
          highestOverlayNode.snapshotNode?.paintOrder ?? 0;
        highestOverlayNode.renderInfo.isOverlay = true;
      }
    }
  }

  // Mark candidates
  const processNode = (node: EnhancedDOMTreeNode): void => {
    if (!node.renderInfo) return;

    if (node.renderInfo.expandedViewportPosition !== undefined) {
      const nodePaintOrder = node.snapshotNode?.paintOrder ?? 0;
      node.renderInfo.isBlockedByOverlay =
        highestOverlayPaintOrder !== undefined &&
        highestOverlayPaintOrder > nodePaintOrder;
    }

    if (node.renderInfo.isInteractive) {
      if (node.renderInfo.isTopElement) {
        node.renderInfo.isCandidate = true;
      } else if (node.renderInfo.expandedViewportPosition !== undefined) {
        node.renderInfo.isCandidate = true;
      } else if (
        node.renderInfo.isVisuallyHiddenNativeControl &&
        node.renderInfo.isVisible
      ) {
        node.renderInfo.isCandidate = true;
      }
    }

    if (
      node.renderInfo.isCandidate &&
      node.nodeType === NodeType.ELEMENT_NODE &&
      node.nodeName.toLowerCase() === 'select'
    ) {
      node.renderInfo.isSelect = true;
      markSelectDescendantsAsCandidates(node);
    }

    for (const child of node.childrenNodes ?? []) {
      processNode(child);
    }
    for (const shadowRoot of node.shadowRoots ?? []) {
      processNode(shadowRoot);
    }
    if (node.contentDocument) {
      processNode(node.contentDocument);
    }
  };

  processNode(root);
}

/**
 * Create a CDP command sender that routes to the correct session.
 * For OOPIF nodes, commands go through the OOPIF session;
 * for main-frame nodes, commands go through the main CDPClient.
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

interface CDPEventListener {
  type: string;
  scriptId: string;
  lineNumber: number;
  columnNumber: number;
}

/**
 * Extract click handlers from an element and its ancestor chain.
 * Covers React, Vue 2/3, jQuery, and inline onclick.
 */
const EXTRACT_ELEMENT_HANDLERS_JS = `
function() {
  var handlers = [];

  function extractFromElement(el) {
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key.startsWith('__reactProps$') || key.startsWith('__reactInternalInstance$')) {
        var props = el[key];
        if (props && typeof props.onClick === 'function') {
          handlers.push(props.onClick.toString());
        }
      }
      if (key.startsWith('__reactEvents$')) {
        var events = el[key];
        if (events && typeof events.onClick === 'function') {
          handlers.push(events.onClick.toString());
        }
      }
    }

    if (el.__vue__) {
      var vm = el.__vue__;
      if (vm.$listeners && typeof vm.$listeners.click === 'function') {
        handlers.push(vm.$listeners.click.toString());
      }
      if (vm._events && vm._events.click) {
        var clicks = vm._events.click;
        for (var j = 0; j < clicks.length; j++) {
          if (typeof clicks[j] === 'function') handlers.push(clicks[j].toString());
        }
      }
    }

    if (el.__vueParentComponent) {
      var vnode = el.__vueParentComponent;
      if (vnode.props && typeof vnode.props.onClick === 'function') {
        handlers.push(vnode.props.onClick.toString());
      }
    }

    if (typeof jQuery !== 'undefined' && jQuery._data) {
      try {
        var jqEvents = jQuery._data(el, 'events');
        if (jqEvents && jqEvents.click) {
          for (var k = 0; k < jqEvents.click.length; k++) {
            if (typeof jqEvents.click[k].handler === 'function') {
              handlers.push(jqEvents.click[k].handler.toString());
            }
          }
        }
      } catch(e) {}
    }
  }

  // 1. Self
  extractFromElement(this);

  // 2. Walk ancestor chain to find delegated click handlers
  var el = this.parentElement;
  var depth = 0;
  while (el && depth < 50) {
    extractFromElement(el);
    el = el.parentElement;
    depth++;
  }

  return handlers;
}
`;

/**
 * Get click listener signatures for a node.
 * Combines CDP native listeners + framework-specific handler extraction.
 */
async function getClickListenerSignatures(
  node: EnhancedDOMTreeNode,
  cdpClient: CDPClient,
  oopifManager?: OOPIFManager,
): Promise<string[]> {
  const sigs: string[] = [];
  const sendCmd = createSendCommand(node, cdpClient, oopifManager);
  try {
    const resolved = await sendCmd<{
      object: { objectId?: string };
    }>('DOM.resolveNode', { backendNodeId: node.backendNodeId });

    const objectId = resolved?.object?.objectId;
    if (!objectId) return sigs;

    // 1. CDP native event listeners
    const result = await sendCmd<{
      listeners: CDPEventListener[];
    }>('DOMDebugger.getEventListeners', { objectId });

    for (const l of result?.listeners ?? []) {
      if (l.type === 'click') {
        sigs.push(`native:${l.scriptId}:${l.lineNumber}:${l.columnNumber}`);
      }
    }

    // 2. Framework handlers (React, Vue, jQuery)
    const fwResult = await sendCmd<{
      result: { value?: string[] };
    }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: EXTRACT_ELEMENT_HANDLERS_JS,
      returnByValue: true,
    });

    const fwHandlers = fwResult?.result?.value;
    if (Array.isArray(fwHandlers)) {
      for (const h of fwHandlers) {
        sigs.push(`framework:${h}`);
      }
    }
  } catch {
    // Element may not be resolvable
  }
  return sigs;
}

/**
 * Batch fetch click listener signatures for all isCandidate nodes.
 * Must run after markInteractiveCandidates since it only targets candidate nodes.
 */
async function fetchClickListenerSignatures(
  root: EnhancedDOMTreeNode,
  cdpClient: CDPClient,
  oopifManager?: OOPIFManager,
): Promise<void> {
  const allCandidates: EnhancedDOMTreeNode[] = [];
  const collectAll = (node: EnhancedDOMTreeNode) => {
    if (node.renderInfo?.isCandidate) {
      allCandidates.push(node);
    }
    for (const child of node.childrenNodes ?? []) {
      collectAll(child);
    }
  };
  collectAll(root);

  if (allCandidates.length === 0) return;

  try {
    await cdpClient.sendCommand('DOM.enable');
  } catch {
    // May already be enabled
  }

  await Promise.all(
    allCandidates.map(async node => {
      const sigs = await getClickListenerSignatures(
        node,
        cdpClient,
        oopifManager,
      );
      if (node.renderInfo) {
        node.renderInfo.clickListenerSignatures = sigs;
      }
    }),
  );
}

function collectCandidateDescendants(
  node: EnhancedDOMTreeNode,
): EnhancedDOMTreeNode[] {
  const result: EnhancedDOMTreeNode[] = [];
  const visit = (n: EnhancedDOMTreeNode, isRoot: boolean) => {
    if (!isRoot && n.renderInfo?.isCandidate) {
      result.push(n);
    }
    for (const child of n.childrenNodes ?? []) {
      visit(child, false);
    }
  };
  visit(node, true);
  return result;
}

/**
 * Mark descendant candidates as isDuplicateListener if they share the same
 * click target (hitBackendNodeId) or click listener signatures as an ancestor candidate.
 */
function deduplicateByListeners(root: EnhancedDOMTreeNode): void {
  const visit = (node: EnhancedDOMTreeNode) => {
    if (node.renderInfo?.isDuplicateListener) return;

    if (node.renderInfo?.isCandidate) {
      const descendants = collectCandidateDescendants(node);
      for (const desc of descendants) {
        if (desc.renderInfo?.isDuplicateListener) continue;
        if (!desc.renderInfo) continue;

        // 1. Same hit target (same frame, excluding self-hits)
        if (
          node.oopifSessionId === desc.oopifSessionId &&
          node.renderInfo.hitBackendNodeId !== undefined &&
          desc.renderInfo.hitBackendNodeId ===
            node.renderInfo.hitBackendNodeId &&
          desc.renderInfo.hitBackendNodeId !== desc.backendNodeId
        ) {
          desc.renderInfo.isDuplicateListener = true;
          desc.renderInfo.listenerHostId = node.backendNodeId;
          node.renderInfo.isListenerHost = true;
          continue;
        }

        // 2. Listener signatures subset + same hit target check
        // Same signatures alone is not enough — delegated handlers often differentiate
        // by event.target, so also require the hit test target to match.
        const parentSigs = node.renderInfo.clickListenerSignatures;
        const childSigs = desc.renderInfo.clickListenerSignatures;
        if (!parentSigs || parentSigs.length === 0) continue;
        if (!childSigs || childSigs.length === 0) continue;
        if (
          node.renderInfo.hitBackendNodeId === undefined ||
          desc.renderInfo.hitBackendNodeId === undefined ||
          desc.renderInfo.hitBackendNodeId !== node.renderInfo.hitBackendNodeId
        )
          continue;

        const parentSigSet = new Set(parentSigs);
        const isSubset = childSigs.every(sig => parentSigSet.has(sig));
        if (isSubset) {
          desc.renderInfo.isDuplicateListener = true;
          desc.renderInfo.listenerHostId = node.backendNodeId;
          node.renderInfo.isListenerHost = true;
        }
      }
    }

    for (const child of node.childrenNodes ?? []) {
      visit(child);
    }
  };

  visit(root);
}
