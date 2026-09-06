/**
 * Accessibility (AX) Tree Type Definitions
 *
 * Types for accessibility tree data from CDP Accessibility domain.
 */

/**
 * The subset of a CDP AXNode the pipeline actually consumes.
 *
 * getFullAXTree returns far more (properties, description, childIds, node ids),
 * but nothing reads those — and the AX tree is the largest payload we handle,
 * so materialising them costs allocation and memory for every cached snapshot.
 */
export interface EnhancedAXNode {
  ignored: boolean;
  role?: string;
  name?: string;
}

/**
 * AX tree lookup map: backendDOMNodeId -> EnhancedAXNode
 */
export type AXTreeLookup = Map<number, EnhancedAXNode>;

/** Roles that compute name from descendant text content (WAI-ARIA "Name from Content") */
export const NAME_FROM_CONTENT_ROLES = new Set([
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'gridcell',
  'heading',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'row',
  'rowheader',
  'switch',
  'tab',
  'tooltip',
  'treeitem',
]);

/**
 * AX properties that indicate interactivity
 */
export const INTERACTIVE_AX_PROPERTIES = new Set([
  'focusable',
  'editable',
  'settable',
  'checked',
  'expanded',
  'pressed',
  'selected',
  'required',
  'autocomplete',
  'keyshortcuts',
]);

/**
 * Build enhanced AX node from CDP AX node
 */
export function buildEnhancedAXNode(
  axNode: import('./cdp').Accessibility.AXNode,
): EnhancedAXNode {
  const result: EnhancedAXNode = {
    ignored: axNode.ignored,
  };

  if (axNode.role?.value) {
    result.role = axNode.role.value;
  }
  if (axNode.name?.value) {
    result.name = axNode.name.value;
  }

  return result;
}

/**
 * Build AX tree lookup from CDP AX tree response
 */
export function buildAXTreeLookup(
  axNodes: import('./cdp').Accessibility.AXNode[],
): AXTreeLookup {
  const lookup = new Map<number, EnhancedAXNode>();

  for (const axNode of axNodes) {
    if (axNode.backendDOMNodeId !== undefined) {
      lookup.set(axNode.backendDOMNodeId, buildEnhancedAXNode(axNode));
    }
  }

  return lookup;
}
