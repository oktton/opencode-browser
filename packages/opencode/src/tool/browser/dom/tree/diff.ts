/**
 * DOM Tree Diff
 *
 * Compares two DOM trees by backendNodeId (isTopElement nodes),
 * producing a merged tree with diffStatus markers ('added' / 'removed').
 */

import type { EnhancedDOMTreeNode } from '../types/dom-node';
import { copyDomTree, nodeKey, buildNodeKeyLookup } from '../utils/index';
import { getAllTextTillNextCandidate } from './pruner';
import { buildAttributesString } from '../serializer/renderer';

type SlotType = 'child' | 'shadow' | 'contentDocument';

/** Controls which diff sides to include in the output tree. */
export type DiffShow = 'both' | 'added' | 'removed';

/**
 * Create a diff tree from two DOM snapshots.
 * Returns null if roots differ (full page navigation).
 * @param show - 'both' (default), 'added' (only + elements), or 'removed' (only - elements)
 */
export function createDiffTree(
  oldTree: EnhancedDOMTreeNode,
  newTree: EnhancedDOMTreeNode,
  show: DiffShow = 'both',
): EnhancedDOMTreeNode | null {
  if (oldTree.backendNodeId !== newTree.backendNodeId) return null;

  const merged = copyDomTree(newTree);

  const oldTop = collectTopElements(oldTree);
  const newTop = collectTopElements(merged);
  const oldIds = new Set(oldTop.keys());
  const newIds = new Set(newTop.keys());
  const mergedLookup = buildNodeKeyLookup(merged);

  if (show !== 'removed') {
    // Mark entirely new elements (didn't exist in old tree)
    for (const key of newIds) {
      if (!oldIds.has(key)) {
        markDiff(newTop.get(key)!, 'added', 'new-element');
      }
    }

    // Mark new expanded elements not present in old tree's top + expanded sets
    const oldExpandedIds = new Set(collectExpandedElements(oldTree).keys());
    const oldAllIds = new Set([...oldIds, ...oldExpandedIds]);
    const newExpanded = collectExpandedElements(merged);
    for (const [key, node] of newExpanded) {
      if (!oldAllIds.has(key)) {
        markDiff(node, 'added', 'new-expanded-element');
      }
    }
  }

  // Handle content-changed elements (same element, different content)
  for (const key of oldIds) {
    if (!newIds.has(key)) continue;
    const oldNode = oldTop.get(key)!;
    const newNode = newTop.get(key)!;
    // console.log('[diff] checking key=%s oldCandidate=%s newCandidate=%s oldTag=%s', key, oldNode.renderInfo?.isCandidate, newNode.renderInfo?.isCandidate, oldNode.nodeName);
    if (!oldNode.renderInfo.isCandidate || !hasAncestorCandidate(oldNode))
      continue;
    if (!hasContentChanged(oldNode, newNode)) continue;

    if (show !== 'removed') {
      markDiff(newNode, 'added', 'content-changed');
    }
    if (show !== 'added') {
      insertBefore(
        newNode,
        shallowRemoved(oldNode, newNode.parentNode!, 'content-changed'),
      );
    }
  }

  // Handle candidate-changed elements (same element, interactivity toggled)
  for (const key of oldIds) {
    if (!newIds.has(key)) continue;
    const oldNode = oldTop.get(key)!;
    const newNode = newTop.get(key)!;
    const oldCandidate = !!oldNode.renderInfo?.isCandidate;
    const newCandidate = !!newNode.renderInfo?.isCandidate;
    if (oldCandidate === newCandidate) continue;

    if (newCandidate && show !== 'removed') {
      markDiff(newNode, 'added', 'candidate-gained');
    }
    if (oldCandidate && show !== 'added') {
      markDiff(newNode, 'removed', 'candidate-lost');
    }
  }

  if (show !== 'added') {
    // Walk old tree top-down for removed elements
    const visit = (node: EnhancedDOMTreeNode, slot: SlotType) => {
      if (node.renderInfo.isTopElement) {
        const key = nodeKey(node);

        if (!newIds.has(key)) {
          const existing = mergedLookup.get(key);
          if (existing) {
            overwriteWithRemoved(existing, node);
          } else if (node.parentNode) {
            const parent = mergedLookup.get(nodeKey(node.parentNode));
            if (parent) {
              const removed = shallowRemoved(node, parent, 'element-gone');
              removed.renderInfo.isTopElement = false;
              insertByPaintOrder(parent, removed, slot);
              mergedLookup.set(key, removed);
            }
          }
        }
      }

      for (const c of node.childrenNodes ?? []) visit(c, 'child');
      for (const s of node.shadowRoots ?? []) visit(s, 'shadow');
      if (node.contentDocument) visit(node.contentDocument, 'contentDocument');
    };

    visit(oldTree, 'child');
  }

  return merged;
}

// --- helpers ---

function markDiff(
  node: EnhancedDOMTreeNode,
  status: 'added' | 'removed',
  reason: string,
): void {
  node.renderInfo.diffStatus = status;
  node.renderInfo.diffReason = reason;
}

function overwriteWithRemoved(
  target: EnhancedDOMTreeNode,
  oldNode: EnhancedDOMTreeNode,
): void {
  target.renderInfo = {
    ...oldNode.renderInfo,
    expandedViewportPosition: target.renderInfo.expandedViewportPosition,
    diffStatus: 'removed',
    diffReason: 'existing',
    cachedText: getAllTextTillNextCandidate(oldNode),
  };
  target.attributes = { ...oldNode.attributes };
  target.whitelistedAttributes = oldNode.whitelistedAttributes
    ? { ...oldNode.whitelistedAttributes }
    : undefined;
  target.axNode = oldNode.axNode ? { ...oldNode.axNode } : undefined;
}

function shallowRemoved(
  oldNode: EnhancedDOMTreeNode,
  parent: EnhancedDOMTreeNode,
  reason: string,
): EnhancedDOMTreeNode {
  return {
    ...oldNode,
    renderInfo: {
      ...oldNode.renderInfo,
      diffStatus: 'removed',
      diffReason: reason,
      cachedText: getAllTextTillNextCandidate(oldNode),
    },
    parentNode: parent,
    childrenNodes: [],
    shadowRoots: undefined,
    contentDocument: undefined,
    attributes: { ...oldNode.attributes },
    whitelistedAttributes: oldNode.whitelistedAttributes
      ? { ...oldNode.whitelistedAttributes }
      : undefined,
    axNode: oldNode.axNode ? { ...oldNode.axNode } : undefined,
  };
}

function hasAncestorCandidate(node: EnhancedDOMTreeNode): boolean {
  let cur = node.parentNode;
  while (cur) {
    if (cur.renderInfo?.isCandidate) return true;
    cur = cur.parentNode;
  }
  return false;
}

function getNodeText(node: EnhancedDOMTreeNode): string {
  if (node.nodeType === 3 && node.nodeValue) return node.nodeValue.trim();
  return getAllTextTillNextCandidate(node);
}

function hasContentChanged(
  oldNode: EnhancedDOMTreeNode,
  newNode: EnhancedDOMTreeNode,
): boolean {
  const oldText = getNodeText(oldNode);
  const newText = getNodeText(newNode);
  const { attrsStr: oldAttrs } = buildAttributesString(oldNode, oldText);
  const { attrsStr: newAttrs } = buildAttributesString(newNode, newText);
  return oldText !== newText || oldAttrs !== newAttrs;
}

function collectExpandedElements(
  root: EnhancedDOMTreeNode,
): Map<string, EnhancedDOMTreeNode> {
  const map = new Map<string, EnhancedDOMTreeNode>();
  const visit = (node: EnhancedDOMTreeNode) => {
    if (
      node.renderInfo.expandedViewportPosition &&
      !node.renderInfo.isTopElement
    ) {
      map.set(nodeKey(node), node);
    }
    for (const c of node.childrenNodes ?? []) visit(c);
    for (const s of node.shadowRoots ?? []) visit(s);
    if (node.contentDocument) visit(node.contentDocument);
  };
  visit(root);
  return map;
}

function collectTopElements(
  root: EnhancedDOMTreeNode,
): Map<string, EnhancedDOMTreeNode> {
  const map = new Map<string, EnhancedDOMTreeNode>();
  const visit = (node: EnhancedDOMTreeNode) => {
    if (node.renderInfo.isTopElement) map.set(nodeKey(node), node);
    for (const c of node.childrenNodes ?? []) visit(c);
    for (const s of node.shadowRoots ?? []) visit(s);
    if (node.contentDocument) visit(node.contentDocument);
  };
  visit(root);
  return map;
}

function insertBefore(
  target: EnhancedDOMTreeNode,
  node: EnhancedDOMTreeNode,
): void {
  const parent = target.parentNode;
  if (!parent?.childrenNodes) return;
  const i = parent.childrenNodes.indexOf(target);
  if (i !== -1) parent.childrenNodes.splice(i, 0, node);
}

function insertByPaintOrder(
  parent: EnhancedDOMTreeNode,
  node: EnhancedDOMTreeNode,
  slot: SlotType,
): void {
  if (slot === 'contentDocument') {
    parent.contentDocument = node;
    return;
  }
  const list =
    slot === 'shadow'
      ? (parent.shadowRoots ??= [])
      : (parent.childrenNodes ??= []);
  const order = node.snapshotNode?.paintOrder ?? 0;
  const i = list.findIndex(c => (c.snapshotNode?.paintOrder ?? 0) > order);
  if (i === -1) list.push(node);
  else list.splice(i, 0, node);
}
