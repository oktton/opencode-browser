/**
 * Accessibility (AX) Tree Type Definitions
 *
 * Types for accessibility tree data from CDP Accessibility domain.
 */

/**
 * AX property names that are commonly used
 */
export type AXPropertyName =
  | 'busy'
  | 'disabled'
  | 'editable'
  | 'focusable'
  | 'focused'
  | 'hidden'
  | 'hiddenRoot'
  | 'invalid'
  | 'keyshortcuts'
  | 'settable'
  | 'roledescription'
  | 'live'
  | 'atomic'
  | 'relevant'
  | 'root'
  | 'autocomplete'
  | 'hasPopup'
  | 'level'
  | 'multiselectable'
  | 'orientation'
  | 'multiline'
  | 'readonly'
  | 'required'
  | 'valuemin'
  | 'valuemax'
  | 'valuetext'
  | 'checked'
  | 'expanded'
  | 'modal'
  | 'pressed'
  | 'selected'
  | 'activedescendant'
  | 'controls'
  | 'describedby'
  | 'details'
  | 'errormessage'
  | 'flowto'
  | 'labelledby'
  | 'owns'
  | 'url'
  | 'value';

/**
 * Enhanced AX property
 */
export interface EnhancedAXProperty {
  name: AXPropertyName;
  value: string | boolean | number | null;
}

/**
 * Enhanced AX node with extracted data
 */
export interface EnhancedAXNode {
  axNodeId: string;
  ignored: boolean;
  role?: string;
  name?: string;
  description?: string;
  properties?: EnhancedAXProperty[];
  childIds?: string[];
}

/**
 * AX tree lookup map: backendDOMNodeId -> EnhancedAXNode
 */
export type AXTreeLookup = Map<number, EnhancedAXNode>;

/**
 * Common interactive AX roles
 */
export const INTERACTIVE_AX_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'option',
  'radio',
  'checkbox',
  'tab',
  'textbox',
  'combobox',
  'slider',
  'spinbutton',
  'listbox',
  'search',
  'searchbox',
]);

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
    axNodeId: axNode.nodeId,
    ignored: axNode.ignored,
  };

  if (axNode.role?.value) {
    result.role = axNode.role.value;
  }
  if (axNode.name?.value) {
    result.name = axNode.name.value;
  }
  if (axNode.description?.value) {
    result.description = axNode.description.value;
  }
  if (axNode.childIds?.length) {
    result.childIds = axNode.childIds;
  }

  if (axNode.properties?.length) {
    const properties: EnhancedAXProperty[] = [];
    for (const prop of axNode.properties) {
      try {
        const value = prop.value?.value ?? null;
        properties.push({
          name: prop.name as AXPropertyName,
          value,
        });
      } catch {
        // Skip properties that can't be processed
      }
    }
    if (properties.length > 0) {
      result.properties = properties;
    }
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
