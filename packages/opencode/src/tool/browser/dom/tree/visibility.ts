/**
 * Multi-Frame Visibility Checking
 *
 * Checks element visibility with parent frame state propagation.
 * Optionally computes expanded viewport position for elements just outside the viewport.
 */

import type { EnhancedDOMTreeNode, DOMRect } from '../types/dom-node';
import { NodeType } from '../types/dom-node';

export type ExpandedViewportPosition = 'above' | 'below' | 'left' | 'right';

export interface VisibilityResult {
  isVisible: boolean;
  /** Set when element is not visible but within expand range of a frame viewport */
  expandedViewportPosition?: ExpandedViewportPosition;
}

interface ContainerViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Check if an element is visible inside its local viewport.
 * Ancestor frame/container visibility is propagated separately through
 * parentFrameState, so expand is decided against the nearest scrollable
 * ancestor, or the current page viewport when no scrollable ancestor exists.
 *
 * Checks:
 * 1. CSS visibility (display, visibility, opacity)
 * 2. Bounds existence
 * 3. Visibility within the nearest container viewport
 */
export type ParentFrameState = 'visible' | ExpandedViewportPosition | 'hidden';

export function checkElementVisibility(
  node: EnhancedDOMTreeNode,
  htmlFrames: EnhancedDOMTreeNode[],
  expand?: number,
  parentFrameState: ParentFrameState = 'visible',
): VisibilityResult {
  // Check if snapshot node exists
  if (!node.snapshotNode) {
    return { isVisible: false };
  }

  // Check CSS visibility
  const computedStyles = node.snapshotNode.computedStyles ?? {};

  const display = (computedStyles.display ?? '').toLowerCase();
  const visibility = (computedStyles.visibility ?? '').toLowerCase();
  const opacity = computedStyles.opacity ?? '1';

  // Parent frame already determined this element is fully hidden
  if (parentFrameState === 'hidden') {
    return { isVisible: false };
  }

  // CSS-hidden elements are never visible and never in expand range
  if (display === 'none' || visibility === 'hidden') {
    return { isVisible: false };
  }

  // Use absolute coordinates so elements and containers are compared in the same space.
  const elementBounds = node.absolutePosition ?? node.snapshotNode.bounds;
  const opacityValue = Number.parseFloat(opacity);

  if (!elementBounds) {
    return { isVisible: false };
  }

  // Some UI libraries visually hide native checkbox/radio inputs and delegate click to label wrappers.
  // Keep them in the tree so agent can still reason about form state/semantics.
  if (
    !node.renderInfo.isVisuallyHiddenNativeControl &&
    (elementBounds.width <= 0 ||
      elementBounds.height <= 0 ||
      (Number.isFinite(opacityValue) && opacityValue <= 0))
  ) {
    return { isVisible: false };
  }

  const frameResult = checkFrameVisibility(
    node,
    elementBounds,
    htmlFrames,
    expand,
  );

  if (parentFrameState !== 'visible') {
    // Parent frame is in expand range — children inherit that direction
    // as long as they are visible or in expand range locally
    if (frameResult.state === 'visible' || frameResult.state === 'expand') {
      return {
        isVisible: false,
        expandedViewportPosition: parentFrameState,
      };
    }
    return { isVisible: false };
  }

  // Parent frame is visible — use local frame result directly
  if (frameResult.state === 'visible') {
    return { isVisible: true };
  }
  if (frameResult.state === 'expand') {
    return {
      isVisible: false,
      expandedViewportPosition: frameResult.direction,
    };
  }
  return { isVisible: false };
}

type FrameVisibilityResult =
  | { state: 'visible' }
  | { state: 'expand'; direction: ExpandedViewportPosition }
  | { state: 'hidden' };

/**
 * Build a viewport rect for a node in absolute coordinates.
 * clientRects width/height reflect the visible viewport, while absolutePosition
 * anchors that viewport in the top-level coordinate space.
 *
 * For body/html inside an iframe, clientRects may underreport the visible area
 * (e.g. body clientHeight=310 inside a 384px iframe). In that case, use the
 * iframe's dimensions as the viewport since all content within the iframe is visible.
 */
function getNodeViewportRect(
  node: EnhancedDOMTreeNode,
): ContainerViewport | null {
  const anchor = node.absolutePosition ?? node.snapshotNode?.bounds;
  const clientRect = node.snapshotNode?.clientRects;

  if (!anchor) {
    return null;
  }

  if (clientRect && clientRect.width > 0 && clientRect.height > 0) {
    let width = clientRect.width;
    let height = clientRect.height;

    // For iframe body/html, use iframe dimensions when larger than clientRects
    const tag = node.nodeName.toLowerCase();
    if (tag === 'body' || tag === 'html') {
      const iframeViewport = getIframeHostViewport(node);
      if (iframeViewport) {
        width = Math.max(width, iframeViewport.width);
        height = Math.max(height, iframeViewport.height);
      }
    }

    return {
      x: anchor.x + clientRect.x,
      y: anchor.y + clientRect.y,
      width,
      height,
    };
  }

  if (anchor.width <= 0 || anchor.height <= 0) {
    return null;
  }

  return {
    x: anchor.x,
    y: anchor.y,
    width: anchor.width,
    height: anchor.height,
  };
}

/**
 * Walk up from an iframe's body/html to find the hosting iframe element
 * and return its clientRects dimensions.
 * Path: body/html → #document → IFRAME
 */
function getIframeHostViewport(
  node: EnhancedDOMTreeNode,
): { width: number; height: number } | null {
  let current = node.parentNode;
  while (current) {
    const tag = current.nodeName.toUpperCase();
    if (tag === 'IFRAME' || tag === 'FRAME') {
      const cr = current.snapshotNode?.clientRects;
      if (cr && cr.width > 0 && cr.height > 0) {
        return { width: cr.width, height: cr.height };
      }
      return null;
    }
    current = current.parentNode;
  }
  return null;
}

/**
 * Returns the nearest scrollable ancestor viewport.
 */
function getScrollableAncestorViewport(
  node: EnhancedDOMTreeNode,
): ContainerViewport | null {
  let current = node.parentNode;
  while (current) {
    if (current.renderInfo?.isScrollable) {
      const viewport = getNodeViewportRect(current);
      if (viewport) {
        return viewport;
      }
    }

    current = current.parentNode;
  }

  return null;
}

/**
 * Returns the current page viewport when no scrollable ancestor exists.
 */
function getPageViewport(
  node: EnhancedDOMTreeNode,
  htmlFrames: EnhancedDOMTreeNode[],
): ContainerViewport | null {
  let current: EnhancedDOMTreeNode | undefined = node;
  while (current) {
    if (
      current.nodeType === NodeType.ELEMENT_NODE &&
      current.nodeName === 'HTML' &&
      current.snapshotNode?.clientRects
    ) {
      return getNodeViewportRect(current);
    }

    current = current.parentNode;
  }

  for (let i = htmlFrames.length - 1; i >= 0; i--) {
    const frame = htmlFrames[i];
    if (
      frame.nodeType === NodeType.ELEMENT_NODE &&
      frame.nodeName === 'HTML' &&
      frame.snapshotNode?.clientRects
    ) {
      return getNodeViewportRect(frame);
    }
  }

  return null;
}

/**
 * Check element visibility against the local viewport.
 */
function checkFrameVisibility(
  node: EnhancedDOMTreeNode,
  elementBounds: DOMRect,
  htmlFrames: EnhancedDOMTreeNode[],
  expand?: number,
): FrameVisibilityResult {
  const containerViewport =
    getScrollableAncestorViewport(node) ?? getPageViewport(node, htmlFrames);
  if (!containerViewport) {
    return { state: 'visible' };
  }

  const vpLeft = containerViewport.x;
  const vpTop = containerViewport.y;
  const vpRight = vpLeft + containerViewport.width;
  const vpBottom = vpTop + containerViewport.height;

  const inH =
    elementBounds.x + elementBounds.width > vpLeft && elementBounds.x < vpRight;
  const inV =
    elementBounds.y + elementBounds.height > vpTop &&
    elementBounds.y < vpBottom;

  if (inH && inV) {
    return { state: 'visible' };
  }

  if (expand !== undefined && expand > 0) {
    // expand is in page units — convert to pixels using container dimensions
    const expandV = expand * containerViewport.height;
    const expandH = expand * containerViewport.width;
    const centerX = elementBounds.x + elementBounds.width / 2;
    const centerY = elementBounds.y + elementBounds.height / 2;
    const inHExpand = centerX > vpLeft - expandH && centerX < vpRight + expandH;
    const inVExpand = centerY > vpTop - expandV && centerY < vpBottom + expandV;

    if (centerY < vpTop && centerY > vpTop - expandV && inHExpand)
      return { state: 'expand', direction: 'above' };
    if (centerY >= vpBottom && centerY < vpBottom + expandV && inHExpand)
      return { state: 'expand', direction: 'below' };
    if (centerX < vpLeft && centerX > vpLeft - expandH && inVExpand)
      return { state: 'expand', direction: 'left' };
    if (centerX >= vpRight && centerX < vpRight + expandH && inVExpand)
      return { state: 'expand', direction: 'right' };
  }

  return { state: 'hidden' };
}
