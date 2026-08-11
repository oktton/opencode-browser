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
      const position = getElementPosition(current);
      const tagName = current.nodeName.toLowerCase();
      const xpathIndex = position > 0 ? `[${position}]` : '';
      segments.unshift(`${tagName}${xpathIndex}`);
    }

    current = current.parentNode;
  }

  return '/' + segments.join('/');
}

/**
 * Get element position among siblings with same tag
 *
 * Returns 0 if only element of its type, otherwise 1-based index.
 */
function getElementPosition(element: EnhancedDOMTreeNode): number {
  if (!element.parentNode?.childrenNodes) {
    return 0;
  }

  const sameTagSiblings = element.parentNode.childrenNodes.filter(
    child =>
      child.nodeType === NodeType.ELEMENT_NODE &&
      child.nodeName.toLowerCase() === element.nodeName.toLowerCase(),
  );

  if (sameTagSiblings.length <= 1) {
    return 0;
  }

  const index = sameTagSiblings.indexOf(element);
  return index >= 0 ? index + 1 : 0;
}
