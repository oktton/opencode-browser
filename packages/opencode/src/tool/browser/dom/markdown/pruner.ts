/**
 * Markdown-specific DOM Tree Pruner
 *
 * Bottom-up pruning (recurse children first), then apply rules in order:
 * 1. Name from Content roles → prune subtree (axNode.name has aggregated text)
 * 2. StaticText → keep
 * 3. No content in self AND no content in subtree → remove entirely
 * 4. Not an only-child → keep
 * 5. Only-child filters (ignored, hidden, no-content wrapper) → promote children
 * 6. Default: keep
 */

import type { EnhancedDOMTreeNode } from '../types/dom-node';
import { NodeType } from '../types/dom-node';
import { NAME_FROM_CONTENT_ROLES } from '../types/ax';
import { convertNodeToAiText } from './ai-text';
import { mergeInlineNodes } from '../tree/inline-merger';
import { markPruneReason } from '../utils/index';

const MAX_ITERATIONS = 100;

/**
 * Prune the DOM tree in-place for markdown rendering.
 *
 * @param root - The tree to prune (will be modified)
 * @param lookup - If provided, writes pruneReason back to original tree nodes via this lookup
 */
export function pruneForMarkdown(
  root: EnhancedDOMTreeNode,
  lookup?: Map<string, EnhancedDOMTreeNode>,
): void {
  // Merge consecutive inline elements into single text nodes
  mergeInlineNodes(root);
  flattenBoundaries(root);

  const effectiveLookup = lookup ?? new Map<string, EnhancedDOMTreeNode>();

  let changed = true;
  let iteration = 0;

  while (changed && iteration < MAX_ITERATIONS) {
    iteration++;
    const countBefore = countNodes(root);

    root.childrenNodes = pruneChildren(
      root,
      root.childrenNodes ?? [],
      effectiveLookup,
    );

    const countAfter = countNodes(root);
    changed = countBefore !== countAfter;
  }
}

/**
 * Recursively merge shadowRoots and contentDocument children into childrenNodes
 */
function flattenBoundaries(node: EnhancedDOMTreeNode): void {
  const merged: EnhancedDOMTreeNode[] = [];

  for (const child of node.childrenNodes ?? []) {
    merged.push(child);
  }

  if (node.shadowRoots) {
    for (const shadow of node.shadowRoots) {
      for (const child of shadow.childrenNodes ?? []) {
        child.parentNode = node;
        merged.push(child);
      }
    }
    node.shadowRoots = undefined;
  }

  if (node.contentDocument) {
    for (const child of node.contentDocument.childrenNodes ?? []) {
      child.parentNode = node;
      merged.push(child);
    }
    node.contentDocument = undefined;
  }

  node.childrenNodes = merged;

  for (const child of node.childrenNodes) {
    flattenBoundaries(child);
  }
}

function countNodes(node: EnhancedDOMTreeNode): number {
  let count = 1;
  for (const child of node.childrenNodes ?? []) {
    count += countNodes(child);
  }
  return count;
}

function pruneChildren(
  parent: EnhancedDOMTreeNode,
  children: EnhancedDOMTreeNode[],
  lookup: Map<string, EnhancedDOMTreeNode>,
): EnhancedDOMTreeNode[] {
  const result: EnhancedDOMTreeNode[] = [];

  for (const child of children) {
    const processed = pruneNode(child, lookup, parent);
    for (const node of processed) {
      node.parentNode = parent;
    }
    result.push(...processed);
  }

  return result;
}

function pruneNode(
  node: EnhancedDOMTreeNode,
  lookup: Map<string, EnhancedDOMTreeNode>,
  parent?: EnhancedDOMTreeNode,
): EnhancedDOMTreeNode[] {
  // Bottom-up: recurse children first
  node.childrenNodes = pruneChildren(node, node.childrenNodes ?? [], lookup);

  const role = node.axNode?.role;

  // Rule 1: Name from Content roles → remove StaticText children already in axNode.name
  if (role && NAME_FROM_CONTENT_ROLES.has(role) && node.axNode?.name) {
    const aggregatedName = node.axNode.name.trim();
    removeRedundantStaticText(node, aggregatedName, lookup);
    return [node];
  }

  // Rule 2: Keep StaticText nodes
  if (role === 'StaticText') {
    return [node];
  }

  if (node.nodeName === 'IMG') {
    markPruneReason(lookup, node, 'img: unwrapped');
    return node.childrenNodes ?? [];
  }

  // Rule 3: No content in self AND no content in subtree → remove entirely
  const { hasContent } = convertNodeToAiText(node);
  if (!hasContent && !hasContentInSubtree(node)) {
    markPruneReason(lookup, node, 'no-content: removed');
    return [];
  }

  // Rule 4: Not an only-child (excluding StaticText siblings) → keep
  const nonTextSiblings = parent?.childrenNodes?.filter(
    c => c.axNode?.role !== 'StaticText',
  );
  if ((nonTextSiblings?.length ?? 0) !== 1) {
    return [node];
  }

  // Rule 5: Only-child filters → promote children (unwrap wrapper)
  if (node.axNode?.ignored) {
    markPruneReason(lookup, node, 'only-child-ignored: unwrapped');
    return node.childrenNodes ?? [];
  }
  if (isInlineHidden(node)) {
    markPruneReason(lookup, node, 'only-child-hidden: unwrapped');
    return node.childrenNodes ?? [];
  }
  if (node.attributes?.['aria-hidden'] === 'true') {
    markPruneReason(lookup, node, 'only-child-aria-hidden: unwrapped');
    return node.childrenNodes ?? [];
  }
  if (!hasContent) {
    markPruneReason(lookup, node, 'only-child-no-content: unwrapped');
    return node.childrenNodes ?? [];
  }

  // Rule 6: Default keep
  return [node];
}

// --- Helpers ---

function isInlineHidden(node: EnhancedDOMTreeNode): boolean {
  const style = node.attributes?.style;
  if (!style) return false;
  const normalized = style.replace(/\s/g, '').toLowerCase();
  return (
    normalized.includes('display:none') ||
    normalized.includes('visibility:hidden')
  );
}

/**
 * Recursively remove StaticText descendants whose text is already in aggregatedName.
 * Preserves non-StaticText children (interactive elements, containers, etc.).
 */
function removeRedundantStaticText(
  node: EnhancedDOMTreeNode,
  aggregatedName: string,
  lookup: Map<string, EnhancedDOMTreeNode>,
): void {
  if (!node.childrenNodes) return;

  node.childrenNodes = node.childrenNodes.filter(child => {
    if (
      child.axNode?.name !== undefined &&
      child.axNode?.name &&
      aggregatedName.includes(child.axNode.name.trim())
    ) {
      markPruneReason(lookup, child, 'name-from-content: redundant text');
      return false;
    }
    removeRedundantStaticText(child, aggregatedName, lookup);
    return true;
  });
}

function hasContentInSubtree(node: EnhancedDOMTreeNode): boolean {
  if (node.axNode?.name) return true;

  if (
    node.nodeType === NodeType.ELEMENT_NODE ||
    node.nodeType === NodeType.DOCUMENT_NODE ||
    node.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE
  ) {
    const { hasContent } = convertNodeToAiText(node);
    if (hasContent) return true;
  }

  for (const child of node.childrenNodes ?? []) {
    if (hasContentInSubtree(child)) return true;
  }

  return false;
}
