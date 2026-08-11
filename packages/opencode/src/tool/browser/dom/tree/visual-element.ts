/**
 * Visual Element Map
 *
 * Collects visual top elements (img/svg/table/etc.) keyed by backendNodeId.
 * Used by tools to look up visual elements for viewing/inspection.
 */

import type { EnhancedDOMTreeNode } from '../types/dom-node';
import { NodeType } from '../types/dom-node';
import { isVisualTopNode, encodeViewId } from '../utils/index';

/** Maps encoded view ID (e.g. "ife") → node for visual top elements */
export type VisualElementMap = Map<string, EnhancedDOMTreeNode>;

/**
 * Build visual element map keyed by encoded view ID.
 */
export function buildVisualElementMap(
  root: EnhancedDOMTreeNode,
): VisualElementMap {
  const map: VisualElementMap = new Map();

  const visit = (node: EnhancedDOMTreeNode): void => {
    if (
      node.nodeType === NodeType.ELEMENT_NODE &&
      node.renderInfo?.isTopElement &&
      isVisualTopNode(node)
    ) {
      map.set(encodeViewId(node.backendNodeId), node);
    }

    for (const child of node.childrenNodes ?? []) {
      visit(child);
    }
  };

  visit(root);
  return map;
}
