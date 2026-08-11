/**
 * Markdown Renderer
 *
 * Renders a pruned EnhancedDOMTreeNode tree into AI-optimized markdown text.
 */

import type { EnhancedDOMTreeNode } from '../types/dom-node';
import { NodeType } from '../types/dom-node';
import { convertNodeToAiText } from './ai-text';
import { nodeKey } from '../utils/index';

/**
 * Render the DOM tree to AI-optimized markdown text.
 * Prunes the tree first, then converts each node to text.
 */
export function renderToMarkdown(
  root: EnhancedDOMTreeNode,
  lookup?: Map<string, EnhancedDOMTreeNode>,
): string {
  const lines: string[] = [];
  renderNode(root, 0, lines, lookup);
  return lines.join('\n');
}

function renderNode(
  node: EnhancedDOMTreeNode,
  depth: number,
  lines: string[],
  lookup?: Map<string, EnhancedDOMTreeNode>,
): void {
  if (
    node.nodeType === NodeType.ELEMENT_NODE ||
    node.nodeType === NodeType.DOCUMENT_NODE ||
    node.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE
  ) {
    const { text } = convertNodeToAiText(node);
    const line = indent(depth) + text;
    lines.push(line);

    // Write renderedLine back to original tree via lookup
    node.renderInfo.renderedLine = line;
    const originalNode = lookup?.get(nodeKey(node));
    if (originalNode?.renderInfo) {
      originalNode.renderInfo.renderedLine = line;
    }
  }

  for (const child of node.childrenNodes ?? []) {
    renderNode(child, depth + 1, lines, lookup);
  }
}

function indent(depth: number): string {
  return '\t'.repeat(depth);
}
