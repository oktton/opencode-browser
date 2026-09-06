/**
 * XPath Utilities
 *
 * Functions for generating and working with XPath selectors.
 */

import type { EnhancedDOMTreeNode } from '../types/dom-node';
import { NodeType } from '../types/dom-node';

/**
 * Generate XPath for a DOM node
 *
 * Stops at shadow boundaries or iframes.
 */
export function generateXPath(node: EnhancedDOMTreeNode): string {
  const segments: string[] = [];
  let current: EnhancedDOMTreeNode | undefined = node;

  while (current) {
    // Stop at document or shadow root boundaries (iframe contentDocument / shadow root)
    if (
      current.nodeType === NodeType.DOCUMENT_NODE ||
      current.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE
    ) {
      break;
    }

    if (current.nodeType === NodeType.ELEMENT_NODE) {
      segments.unshift(elementSegment(current));
    }

    current = current.parentNode;
  }

  return '/' + segments.join('/');
}

/**
 * One xpath segment for an element: tag name plus a 1-based index when the
 * element has same-tag siblings.
 */
export function elementSegment(element: EnhancedDOMTreeNode): string {
  const position = getElementPosition(element);
  const tagName = element.nodeName.toLowerCase();
  return position > 0 ? `${tagName}[${position}]` : tagName;
}

/**
 * Get element position among siblings with same tag
 *
 * Returns 0 if only element of its type, otherwise 1-based index.
 */
function getElementPosition(element: EnhancedDOMTreeNode): number {
  const siblings = element.parentNode?.childrenNodes;
  if (!siblings) {
    return 0;
  }

  // Single pass: count same-tag siblings and note where this element lands.
  // (A filter + indexOf here allocates an array per element, which is hot
  // enough on large pages to dominate tree building.)
  const tagName = element.nodeName.toLowerCase();
  let count = 0;
  let index = 0;
  for (const child of siblings) {
    if (
      child.nodeType !== NodeType.ELEMENT_NODE ||
      child.nodeName.toLowerCase() !== tagName
    ) {
      continue;
    }
    count++;
    if (child === element) index = count;
  }

  return count > 1 ? index : 0;
}
