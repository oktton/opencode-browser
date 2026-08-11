/**
 * Inline Merger
 *
 * Merges consecutive inline-display siblings into a single text node.
 * This reduces tree complexity for LLM consumption by collapsing
 * sequences of inline elements (e.g., <span>, <em>, <strong>) into
 * a single text node containing their combined text content.
 */

import type { EnhancedDOMTreeNode } from '../types/dom-node';
import { NodeType } from '../types/dom-node';

/**
 * Recursively extract text content from a node and its descendants
 */
function extractTextContent(node: EnhancedDOMTreeNode): string {
  if (node.nodeType === NodeType.TEXT_NODE) {
    return node.nodeValue;
  }
  const parts: string[] = [];
  for (const child of node.childrenNodes ?? []) {
    parts.push(extractTextContent(child));
  }
  return parts.join('');
}

/**
 * Find the first TEXT_NODE in a node's subtree (depth-first)
 */
function findFirstTextNode(
  node: EnhancedDOMTreeNode,
): EnhancedDOMTreeNode | null {
  if (node.nodeType === NodeType.TEXT_NODE) {
    return node;
  }
  for (const child of node.childrenNodes ?? []) {
    const found = findFirstTextNode(child);
    if (found) return found;
  }
  return null;
}

/**
 * Recursively remove all TEXT_NODEs from a node's childrenNodes,
 * skipping the one to keep.
 */
function removeTextNodes(
  node: EnhancedDOMTreeNode,
  keep: EnhancedDOMTreeNode,
): void {
  const children = node.childrenNodes;
  if (!children) return;
  for (let i = children.length - 1; i >= 0; i--) {
    if (children[i].nodeType === NodeType.TEXT_NODE && children[i] !== keep) {
      children.splice(i, 1);
    } else {
      removeTextNodes(children[i], keep);
    }
  }
}

function isInlineDisplay(node: EnhancedDOMTreeNode): boolean {
  const nodeDisplay = node.snapshotNode?.computedStyles?.display;
  if (!nodeDisplay) return false;
  return nodeDisplay === 'inline' || nodeDisplay === 'flow-root';
}

/**
 * Merge consecutive inline siblings throughout the tree.
 *
 * For each parent, finds runs of 2+ consecutive inline-display children,
 * extracts all text, writes merged text into the first TEXT_NODE found
 * at any depth, removes all other TEXT_NODEs in the run, and updates
 * axNode.name accordingly.
 *
 * Processes bottom-up so inner merges happen before outer ones.
 */
export function mergeInlineNodes(root: EnhancedDOMTreeNode): void {
  for (const child of root.childrenNodes ?? []) {
    mergeInlineNodes(child);
  }
  for (const shadow of root.shadowRoots ?? []) {
    mergeInlineNodes(shadow);
  }
  if (root.contentDocument) {
    mergeInlineNodes(root.contentDocument);
  }

  const children = root.childrenNodes;
  if (!children || children.length < 2) return;

  let i = 0;
  while (i < children.length) {
    if (!isInlineDisplay(children[i])) {
      i++;
      continue;
    }

    let runEnd = i + 1;
    while (runEnd < children.length && isInlineDisplay(children[runEnd])) {
      runEnd++;
    }

    if (runEnd - i < 2) {
      i++;
      continue;
    }

    // Step 1: Find the first TEXT_NODE in the run
    let firstTextNode: EnhancedDOMTreeNode | null = null;
    for (let j = i; j < runEnd && !firstTextNode; j++) {
      firstTextNode = findFirstTextNode(children[j]);
    }

    if (firstTextNode) {
      // Step 2: Collect text from the entire run
      const textParts: string[] = [];
      for (let j = i; j < runEnd; j++) {
        textParts.push(extractTextContent(children[j]));
      }
      const mergedText = textParts.join('');

      // Step 3: Write merged text into the first TEXT_NODE
      firstTextNode.nodeValue = mergedText;
      if (firstTextNode.axNode) {
        firstTextNode.axNode.name = mergedText;
      }

      // Step 4: Remove all other TEXT_NODEs in the run
      for (let j = i; j < runEnd; j++) {
        if (
          children[j].nodeType === NodeType.TEXT_NODE &&
          children[j] !== firstTextNode
        ) {
          children.splice(j, 1);
          j--;
          runEnd--;
        } else {
          removeTextNodes(children[j], firstTextNode);
        }
      }
    }

    i = runEnd;
  }
}
