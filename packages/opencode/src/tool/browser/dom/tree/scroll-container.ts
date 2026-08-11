/**
 * Scroll Container Detection
 *
 * Builds a map of scrollable containers for elements outside the viewport.
 * Relies on renderInfo.scrollableContainerId being pre-computed in initRenderInfo.
 */

import type { EnhancedDOMTreeNode } from '../types/dom-node';
import { nodeKey } from '../utils/index';

/** Maps scroll container index → container node */
export type ScrollContainerMap = Map<number, EnhancedDOMTreeNode>;

/**
 * Build scroll container map for all expanded viewport elements.
 * Uses pre-computed scrollableContainerId to avoid parent chain walks.
 *
 * @param root - Pruned tree to iterate
 * @param lookup - nodeKey → un-pruned node (containers may have been pruned away)
 */
export function buildScrollContainerMap(
  root: EnhancedDOMTreeNode,
  lookup?: Map<string, EnhancedDOMTreeNode>,
): ScrollContainerMap {
  const scrollContainerMap: ScrollContainerMap = new Map();
  const containerToIndex = new Map<number, number>();
  let nextIndex = 1; // 0 is reserved for the main page

  // Build backendNodeId → node index from lookup for resolving scrollable containers
  const containerById = new Map<number, EnhancedDOMTreeNode>();
  if (lookup) {
    for (const node of lookup.values()) {
      if (node.renderInfo?.isScrollable) {
        containerById.set(node.backendNodeId, node);
      }
    }
  }

  const visit = (node: EnhancedDOMTreeNode): void => {
    const containerId = node.renderInfo?.scrollableContainerId;
    if (
      node.renderInfo?.expandedViewportPosition !== undefined &&
      containerId !== undefined
    ) {
      const expandDir = node.renderInfo.expandedViewportPosition;
      let index = containerToIndex.get(containerId);
      if (index === undefined) {
        const containerNode = containerById.get(containerId);
        if (containerNode) {
          index = nextIndex++;
          containerToIndex.set(containerId, index);
          scrollContainerMap.set(index, containerNode);
          // Mark scroll direction on the container node
          if (containerNode.renderInfo) {
            containerNode.renderInfo.isHorizontalScroll =
              expandDir === 'left' || expandDir === 'right';
          }
        }
      }
      if (index !== undefined) {
        node.renderInfo.scrollContainerIndex = index;
        const originalNode = lookup?.get(nodeKey(node));
        if (originalNode?.renderInfo) {
          originalNode.renderInfo.scrollContainerIndex = index;
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
  return scrollContainerMap;
}
