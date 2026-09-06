/**
 * DOM Tree Pruner
 *
 * Removes nodes without structural significance or interactive candidates,
 * reducing token cost for LLM consumption.
 */

import type { EnhancedDOMTreeNode } from '../types/dom-node';
import { NodeType } from '../types/dom-node';
import { mergeInlineNodes } from './inline-merger';
import { NAME_FROM_CONTENT_ROLES } from '../types/ax';
import { markPruneReason, isVisualElement } from '../utils/index';

const MAX_ITERATIONS = 100;

/**
 * Prune the DOM tree in-place, repeating until no more nodes are removed.
 *
 * @param root - The tree to prune (will be modified)
 * @param lookup - If provided, writes pruneReason back to original tree nodes via this lookup
 */
export function pruneTree(
  root: EnhancedDOMTreeNode,
  lookup?: Map<string, EnhancedDOMTreeNode>,
): void {
  // Merge consecutive inline elements into single text nodes
  mergeInlineNodes(root);
  // Flatten shadow roots and contentDocument into childrenNodes first
  flattenBoundaries(root);

  const effectiveLookup = lookup ?? new Map<string, EnhancedDOMTreeNode>();

  let changed = true;
  let iteration = 0;

  while (changed && iteration < MAX_ITERATIONS) {
    iteration++;

    // A pass reports whether it dropped or unwrapped anything. Node counts can
    // only shrink, so this is equivalent to comparing before/after counts —
    // without the two extra full-tree walks per iteration.
    const state: PruneState = { changed: false };

    root.childrenNodes = pruneChildren(
      root,
      root.childrenNodes ?? [],
      effectiveLookup,
      state,
    );

    changed = state.changed;
  }
}

interface PruneState {
  changed: boolean;
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

function pruneChildren(
  parent: EnhancedDOMTreeNode,
  children: EnhancedDOMTreeNode[],
  lookup: Map<string, EnhancedDOMTreeNode>,
  state: PruneState,
): EnhancedDOMTreeNode[] {
  const result: EnhancedDOMTreeNode[] = [];

  for (const child of children) {
    const processed = pruneNode(child, lookup, state);
    if (processed.length !== 1 || processed[0] !== child) {
      state.changed = true;
    }
    for (const node of processed) {
      node.parentNode = parent;
      result.push(node);
    }
  }

  return result;
}

function pruneNode(
  node: EnhancedDOMTreeNode,
  lookup: Map<string, EnhancedDOMTreeNode>,
  state: PruneState,
): EnhancedDOMTreeNode[] {
  const result = pruneNodeInner(node, lookup, state);
  // Memo for the parent's hasDescendantCandidate. Nodes other than `node` in
  // the result are its own children, already memoised when they were pruned.
  if (result.length === 1 && result[0] === node) {
    node._hasCandidate = hasDescendantCandidate(node);
  }
  return result;
}

function pruneNodeInner(
  node: EnhancedDOMTreeNode,
  lookup: Map<string, EnhancedDOMTreeNode>,
  state: PruneState,
): EnhancedDOMTreeNode[] {
  // Bottom-up: prune children first
  node.childrenNodes = pruneChildren(
    node,
    node.childrenNodes ?? [],
    lookup,
    state,
  );

  // Always keep root
  if (!node.parentNode) return [node];

  // Filter out expanded elements blocked by overlay
  if (node.renderInfo?.isBlockedByOverlay) {
    markPruneReason(lookup, node, 'blocked-by-overlay: removed');
    return [];
  }

  // Keep visible text nodes
  if (
    node.nodeType === NodeType.TEXT_NODE &&
    (node.renderInfo.isTopElement ||
      node.renderInfo.expandedViewportPosition !== undefined ||
      node.renderInfo.diffStatus === 'removed')
  )
    return [node];

  // Preserve visual elements (visual top + structural children)
  if (isVisualElement(node)) {
    const useHref = extractSvgUseHref(node);
    if (useHref) {
      node.renderInfo.cachedText = useHref;
    }
    return [node];
  }

  // Candidate nodes: demote duplicate-listener candidates with same content as ancestor
  if (
    node.renderInfo?.isCandidate &&
    node.renderInfo.isDuplicateListener &&
    !node.renderInfo.isSelectOption
  ) {
    const ancestor = findAncestorCandidate(node);
    if (ancestor && isSameContent(node, ancestor)) {
      markPruneReason(lookup, node, 'duplicate-listener: unwrapped');
      node.renderInfo.isCandidate = false;
    }
  }

  // Listener hosts must be preserved as structural anchors for their duplicate-listener descendants
  if (node.renderInfo?.isListenerHost) return [node];

  // Keep candidates with content (including svg/img), otherwise clear candidate status
  if (node.renderInfo?.isCandidate) {
    if (hasContent(node)) return [node];
    markPruneReason(lookup, node, 'empty-candidate: demoted');
    node.renderInfo.isCandidate = false;
  }

  // Remove if: only child (structurally redundant), empty leaf, or no candidate in subtree
  if (node.parentNode.childrenNodes?.length === 1) {
    markPruneReason(lookup, node, 'only-child: unwrapped');
    return node.childrenNodes ?? [];
  }
  if ((node.childrenNodes?.length ?? 0) === 0) {
    markPruneReason(lookup, node, 'empty-leaf: unwrapped');
    return node.childrenNodes ?? [];
  }
  if (!hasDescendantCandidate(node)) {
    markPruneReason(lookup, node, 'no-candidate-in-subtree: unwrapped');
    return node.childrenNodes ?? [];
  }

  return [node];
}

/**
 * Whether this subtree still holds a candidate.
 *
 * Pruning is bottom-up, so every child already carries the answer for its own
 * subtree in _hasCandidate — one level of children is enough, instead of
 * re-walking the whole subtree at every level.
 */
function hasDescendantCandidate(node: EnhancedDOMTreeNode): boolean {
  if (node.renderInfo?.isCandidate) return true;
  for (const child of node.childrenNodes ?? []) {
    if (child._hasCandidate) return true;
  }
  return false;
}

function hasVisualElementTillNextCandidate(node: EnhancedDOMTreeNode): boolean {
  if (isVisualElement(node)) return true;
  for (const child of node.childrenNodes ?? []) {
    if (child.renderInfo?.isCandidate) continue;
    if (hasVisualElementTillNextCandidate(child)) return true;
  }
  return false;
}

function hasContent(node: EnhancedDOMTreeNode): boolean {
  const text =
    node.renderInfo.cachedText !== undefined
      ? node.renderInfo.cachedText
      : getAllTextTillNextCandidate(node);
  const hasAttrs = hasWhitelistedAttributes(node);
  return !!(text || hasAttrs || hasVisualElementTillNextCandidate(node));
}

export function getAllTextTillNextCandidate(node: EnhancedDOMTreeNode): string {
  const texts: string[] = [];
  for (const child of node.childrenNodes ?? []) {
    if (child.renderInfo?.isCandidate) continue;
    if (isVisualElement(child)) continue;
    if (child.nodeType === NodeType.TEXT_NODE && child.nodeValue) {
      texts.push(child.nodeValue.trim());
    } else {
      texts.push(getAllTextTillNextCandidate(child));
    }
  }
  const result = texts.filter(Boolean).join(' ').replace(/\s+/g, ' ');
  if (
    !result &&
    node.axNode?.role &&
    NAME_FROM_CONTENT_ROLES.has(node.axNode.role)
  ) {
    return node.axNode.name?.trim() ?? '';
  }
  return result;
}

function hasWhitelistedAttributes(node: EnhancedDOMTreeNode): boolean {
  const wa = node.whitelistedAttributes;
  return !!wa && Object.keys(wa).length > 0;
}

function hasSameWhitelistedAttributes(
  desc: EnhancedDOMTreeNode,
  ancestor: EnhancedDOMTreeNode,
): boolean {
  const descAttrs = desc.whitelistedAttributes ?? {};
  const ancestorAttrs = ancestor.whitelistedAttributes ?? {};
  const descEntries = Object.entries(descAttrs);
  const ancestorEntries = Object.entries(ancestorAttrs);

  if (descEntries.length !== ancestorEntries.length) {
    return false;
  }

  return descEntries.every(([key, value]) => ancestorAttrs[key] === value);
}

function findAncestorCandidate(
  node: EnhancedDOMTreeNode,
): EnhancedDOMTreeNode | undefined {
  let ancestor = node.parentNode;
  while (ancestor) {
    if (
      ancestor.renderInfo?.isCandidate &&
      !ancestor.renderInfo.isDuplicateListener
    ) {
      return ancestor;
    }
    ancestor = ancestor.parentNode;
  }
  return undefined;
}

function isSameContent(
  desc: EnhancedDOMTreeNode,
  ancestor: EnhancedDOMTreeNode,
): boolean {
  const descText = getAllTextTillNextCandidate(desc);
  const ancestorText = getAllTextTillNextCandidate(ancestor);
  if (descText && !ancestorText.includes(descText)) return false;
  return hasSameWhitelistedAttributes(desc, ancestor);
}

/** Extract href from <use> descendants to identify the SVG icon */
function extractSvgUseHref(node: EnhancedDOMTreeNode): string | undefined {
  const hrefs: string[] = [];
  collectUseHrefs(node, hrefs);
  return hrefs.length > 0 ? hrefs.join(' ') : undefined;
}

function collectUseHrefs(node: EnhancedDOMTreeNode, hrefs: string[]): void {
  if (node.nodeName.toLowerCase() === 'use' && node.attributes) {
    const href = node.attributes['href'] || node.attributes['xlink:href'];
    if (href) hrefs.push(href);
  }
  for (const child of node.childrenNodes ?? []) {
    collectUseHrefs(child, hrefs);
  }
}
