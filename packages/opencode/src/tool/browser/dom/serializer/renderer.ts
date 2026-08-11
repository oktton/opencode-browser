/**
 * DOM Tree Renderer
 *
 * Renders the DOM tree to HTML-like text format for LLM consumption.
 * Format:
 *   [N]<tag attrs> text </tag>   (clickable)
 *   <N><tag attrs> text </tag>   (fillable input)
 *
 * Off-screen zones:
 *   === OFF-SCREEN above ===  ...  === END OFF-SCREEN ===
 *   === OFF-SCREEN below ===  ...  === END OFF-SCREEN ===
 *
 * Diff prefixes:
 *   +|  (added)
 *   -|  (removed)
 */

import type {
  EnhancedDOMTreeNode,
  InteractionRecord,
} from '../types/dom-node';
import { NodeType } from '../types/dom-node';
import { getAllTextTillNextCandidate } from '../tree/pruner';
import {
  nodeKey,
  STRUCTURAL_CHILD_TAGS,
  isVisualTopNode,
  isVisualElement,
  encodeViewId,
} from '../utils/index';

/**
 * Get all child nodes including shadow roots and content document
 */
function getAllChildren(node: EnhancedDOMTreeNode): EnhancedDOMTreeNode[] {
  return node.childrenNodes ?? [];
}

/**
 * Check if any ancestor is a candidate or visual element (text already consumed by parent)
 */
function hasCandidateOrVisualAncestor(node: EnhancedDOMTreeNode): boolean {
  let ancestor = node.parentNode;
  while (ancestor) {
    if (ancestor.renderInfo.isCandidate || isVisualElement(ancestor)) {
      return true;
    }
    ancestor = ancestor.parentNode;
  }
  return false;
}

/**
 * Build attributes string from whitelistedAttributes, deduplicating against inline text.
 * Returns { attrsStr, text } — text may be cleared if an attribute already covers it.
 */
export function buildAttributesString(
  node: EnhancedDOMTreeNode,
  text: string,
): { attrsStr: string; text: string } {
  const attrs = node.whitelistedAttributes;
  if (!attrs || Object.keys(attrs).length === 0) return { attrsStr: '', text };

  const attributesToInclude = { ...attrs };

  // Remove redundant: role matches tagName
  if (
    attributesToInclude.role &&
    node.nodeName.toLowerCase() === attributesToInclude.role
  ) {
    delete attributesToInclude.role;
  }

  // Deduplicate: if attribute value and text contain each other, keep the longer one; if equal, prefer attribute
  const trimmedText = text.trim();
  let suppressText = false;
  if (trimmedText) {
    for (const key of Object.keys(attributesToInclude)) {
      const attrVal = attributesToInclude[key]?.trim();
      if (!attrVal) continue;
      if (attrVal.includes(trimmedText)) {
        suppressText = true; // attribute covers text, suppress inline text
      } else if (trimmedText.includes(attrVal)) {
        delete attributesToInclude[key]; // text covers attribute, remove attribute
      }
    }
  }

  if (Object.keys(attributesToInclude).length === 0)
    return { attrsStr: '', text: suppressText ? '' : text };

  const attrsStr = Object.entries(attributesToInclude)
    .map(([key, value]) => `${key}='${value}'`)
    .join(' ');
  return { attrsStr, text: suppressText ? '' : text };
}

const MAX_OFFSCREEN_TEXT = 50;

/** Shared mutable state for zone boundary tracking during tree traversal */
interface RenderState {
  currentZone: 'above' | 'below' | 'left' | 'right' | undefined;
  lines: string[];
  /** backendNodeId → interaction records for annotating previously interacted elements */
  interactionMap?: Map<number, InteractionRecord[]>;
  /** When true, only emit nodes with diffStatus (added/removed); recurse others silently */
  incrementalDiff?: boolean;
}

/**
 * Build a human-readable annotation for interaction history on an element.
 */
function buildInteractionAnnotation(records: InteractionRecord[]): string {
  const parts: string[] = [];

  const clicks = records.filter(r => r.action === 'click');
  const selects = records.filter(r => r.action === 'select');
  const inputs = records.filter(r => r.action === 'input');

  if (clicks.length > 0) {
    parts.push(`you already clicked this element ${clicks.length} times`);
  }
  if (selects.length > 0) {
    parts.push(`you already selected this element ${selects.length} times`);
  }
  if (inputs.length > 0) {
    // Group inputs by same params (text/clear/pressEnter)
    const groups = new Map<
      string,
      { text: string; clear: string; enter: string; count: number }
    >();
    for (const inp of inputs) {
      const text = String(inp.params?.text ?? '');
      const clear = inp.params?.clear !== false ? 'clear' : 'append';
      const enter = inp.params?.pressEnter ? '+Enter' : '';
      const key = `${text}|${clear}|${enter}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
      } else {
        groups.set(key, { text, clear, enter, count: 1 });
      }
    }
    for (const { text, clear, enter, count } of groups.values()) {
      const times = count > 1 ? ` ${count} times` : '';
      parts.push(`you already input "${text}" here${times} (${clear}${enter})`);
    }
  }

  return `<!-- ${parts.join('; ')} -->`;
}

/**
 * Render DOM tree to string
 * @param options.incrementalDiff - Only emit nodes with diffStatus (added/removed); skip unchanged nodes
 */
export function renderToHtml(
  node: EnhancedDOMTreeNode | null,
  depth = 0,
  lookup?: Map<string, EnhancedDOMTreeNode>,
  interactionMap?: Map<number, InteractionRecord[]>,
  options?: { incrementalDiff?: boolean },
): string {
  const state: RenderState = {
    currentZone: undefined,
    lines: [],
    interactionMap,
    incrementalDiff: options?.incrementalDiff,
  };
  renderNode(node, depth, lookup, state);
  if (state.currentZone) state.lines.push('=== END OFF-SCREEN ===');
  return state.lines.join('\n');
}

function hasDiffDescendant(node: EnhancedDOMTreeNode): boolean {
  for (const child of getAllChildren(node)) {
    if (child.renderInfo?.diffStatus || hasDiffDescendant(child)) return true;
  }
  return false;
}

function renderNode(
  node: EnhancedDOMTreeNode | null,
  depth: number,
  lookup: Map<string, EnhancedDOMTreeNode> | undefined,
  state: RenderState,
): void {
  if (!node) return;

  const renderInfo = node.renderInfo;

  // Determine if node should be rendered
  const shouldRender =
    renderInfo &&
    (renderInfo.isTopElement ||
      renderInfo.expandedViewportPosition !== undefined ||
      renderInfo.diffStatus === 'removed' ||
      renderInfo.isVisuallyHiddenNativeControl ||
      renderInfo.isSelectOption);

  // Skip nodes without renderInfo or not in viewport/expanded viewport — pass through to children
  if (!shouldRender) {
    for (const child of getAllChildren(node)) {
      renderNode(child, depth, lookup, state);
    }
    return;
  }

  // In incremental mode, skip nodes with no diff in their subtree
  if (
    state.incrementalDiff &&
    !renderInfo.diffStatus &&
    !hasDiffDescendant(node)
  ) {
    return;
  }

  // Determine this node's viewport zone (normalize left→above, right→below for AI simplicity)
  const rawZone = renderInfo.expandedViewportPosition;
  const nodeZone =
    rawZone === 'left' ? 'above' : rawZone === 'right' ? 'below' : rawZone;

  // Emit zone boundary transitions
  if (nodeZone !== state.currentZone) {
    if (state.currentZone) state.lines.push('=== END OFF-SCREEN ===');
    if (nodeZone) {
      const scrollIdx = renderInfo.scrollContainerIndex ?? 0;
      const suffix = ` [container:${scrollIdx}]`;
      state.lines.push(
        `=== OFF-SCREEN ${nodeZone}${suffix} (scroll to reveal these elements) ===`,
      );
    }
    state.currentZone = nodeZone;
  }

  const prefix =
    renderInfo.diffStatus === 'added'
      ? '+|'
      : renderInfo.diffStatus === 'removed'
        ? '-|'
        : '';

  const depthStr = '\t'.repeat(depth);

  if (node.nodeType === NodeType.ELEMENT_NODE) {
    const tagName = node.nodeName.toLowerCase();
    const isVisualTop = isVisualTopNode(node);
    const isStructuralChild = STRUCTURAL_CHILD_TAGS.has(tagName);
    const nextDepth = depth + 1;
    let text = '';
    let attrsStr = '';

    if (renderInfo.isCandidate || isVisualTop || isStructuralChild) {
      text =
        renderInfo.cachedText !== undefined
          ? renderInfo.cachedText
          : getAllTextTillNextCandidate(node);
      ({ attrsStr, text } = buildAttributesString(node, text));
    }

    // Interaction indicator first, view indicator after — they don't conflict
    const interactionIndicator =
      renderInfo.highlightIndex !== undefined
        ? renderInfo.isFill
          ? `<${renderInfo.highlightIndex}>`
          : `[${renderInfo.highlightIndex}]`
        : '';
    const viewIndicator =
      isVisualTop && renderInfo.isTopElement
        ? `[view:${encodeViewId(node.backendNodeId)}]`
        : '';
    const indicator = `${interactionIndicator}${viewIndicator}`;

    const baselineStr = attrsStr ? ` ${attrsStr}>` : '>';
    const truncatedText =
      nodeZone && text.length > MAX_OFFSCREEN_TEXT
        ? text.slice(0, MAX_OFFSCREEN_TEXT) + '...'
        : text;
    const textStr = truncatedText ? ` ${truncatedText} ` : '';
    const closeTagStr = `</${tagName}>`;

    const line = `${depthStr}${prefix}${indicator}<${tagName}${baselineStr}${textStr}${closeTagStr}`;
    renderInfo.renderedLine = `<${tagName}${baselineStr}${textStr}${closeTagStr}`;
    const originalNode = lookup?.get(nodeKey(node));
    if (originalNode?.renderInfo) {
      originalNode.renderInfo.renderedLine = `<${tagName}${baselineStr}${textStr}${closeTagStr}`;
    }

    // Annotate elements that have been interacted with before (backendNodeId + renderedLine must both match)
    let annotation = '';
    if (renderInfo.isCandidate && state.interactionMap) {
      const allInteractions = state.interactionMap.get(node.backendNodeId);
      if (allInteractions) {
        const currentRendered = renderInfo.renderedLine;
        const matched = allInteractions.filter(
          r => !r.renderedLine || r.renderedLine === currentRendered,
        );
        if (matched.length > 0) {
          annotation = ` ${buildInteractionAnnotation(matched)}`;
        }
      }
    }

    state.lines.push(`${line}${annotation}`);

    // Offscreen candidate with content: skip children subtree
    if (
      nodeZone &&
      renderInfo.isCandidate &&
      (attrsStr || text) &&
      renderInfo.diffStatus !== 'removed'
    ) {
      if (getAllChildren(node).length > 0) {
        state.lines.push(`${depthStr}\t ...`);
      }
      return;
    }

    for (const child of getAllChildren(node)) {
      renderNode(child, nextDepth, lookup, state);
    }
  } else if (node.nodeType === NodeType.TEXT_NODE) {
    // Text nodes: skip if ancestor already consumed the text
    if (!hasCandidateOrVisualAncestor(node)) {
      let textContent = node.nodeValue?.trim() ?? '';
      if (nodeZone && textContent.length > MAX_OFFSCREEN_TEXT) {
        textContent = textContent.slice(0, MAX_OFFSCREEN_TEXT) + '...';
      }
      if (textContent) {
        state.lines.push(`${depthStr}${prefix}${textContent}`);
        renderInfo.renderedLine = textContent;
        const originalNode = lookup?.get(nodeKey(node));
        if (originalNode?.renderInfo) {
          originalNode.renderInfo.renderedLine = textContent;
        }
      }
    }
  } else if (node.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE) {
    // Shadow DOM
    for (const child of getAllChildren(node)) {
      renderNode(child, depth, lookup, state);
    }
  } else {
    // Other node types — recurse children
    for (const child of getAllChildren(node)) {
      renderNode(child, depth, lookup, state);
    }
  }
}
