/**
 * Clickable Element Detector
 *
 * Detects interactive elements using enhanced scoring based on
 * HTML attributes, ARIA roles, accessibility properties, and CSS.
 */

import type { EnhancedDOMTreeNode } from '../types/dom-node';
import {
  NodeType,
  INTERACTIVE_TAGS,
  INTERACTIVE_ROLES,
} from '../types/dom-node';

/**
 * Input types that require direct value setting via JS (not keyboard text input).
 * These elements are fillable but use `.value = str` + event dispatch instead of insertText.
 */
export const VALUE_SETTABLE_INPUT_TYPES = new Set([
  'range',
  'color',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
]);

/**
 * Interactive HTML attributes that indicate clickability
 */
const INTERACTIVE_ATTRIBUTES = new Set([
  'onclick',
  'onmousedown',
  'onmouseup',
  'onkeydown',
  'onkeyup',
]);

/**
 * Check if any non-text descendant has the given cursor style.
 * Text nodes (TEXT_NODE) with the cursor style are ignored.
 */
function hasNonTextDescendantWithCursor(
  node: EnhancedDOMTreeNode,
  cursor: string,
): boolean {
  for (const child of node.childrenNodes ?? []) {
    if (
      child.nodeType !== NodeType.TEXT_NODE &&
      child.snapshotNode?.cursorStyle === cursor
    )
      return true;
    if (hasNonTextDescendantWithCursor(child, cursor)) return true;
  }
  for (const shadow of node.shadowRoots ?? []) {
    if (
      shadow.nodeType !== NodeType.TEXT_NODE &&
      shadow.snapshotNode?.cursorStyle === cursor
    )
      return true;
    if (hasNonTextDescendantWithCursor(shadow, cursor)) return true;
  }
  if (node.contentDocument) {
    if (
      node.contentDocument.nodeType !== NodeType.TEXT_NODE &&
      node.contentDocument.snapshotNode?.cursorStyle === cursor
    )
      return true;
    if (hasNonTextDescendantWithCursor(node.contentDocument, cursor))
      return true;
  }
  return false;
}

/**
 * Check if any descendant node has renderInfo.isInteractive set.
 * Relies on initRenderInfo processing children before parents.
 */
function hasClickableDescendant(node: EnhancedDOMTreeNode): boolean {
  for (const child of node.childrenNodes ?? []) {
    if (child.snapshotNode?.isClickable) return true;
    if (hasClickableDescendant(child)) return true;
  }
  for (const shadow of node.shadowRoots ?? []) {
    if (shadow.snapshotNode?.isClickable) return true;
    if (hasClickableDescendant(shadow)) return true;
  }
  if (node.contentDocument) {
    if (node.contentDocument.snapshotNode?.isClickable) return true;
    if (hasClickableDescendant(node.contentDocument)) return true;
  }
  return false;
}

/**
 * Clickable Element Detector class
 */
export class ClickableElementDetector {
  /**
   * Check if a node is interactive/clickable
   */
  static isInteractive(node: EnhancedDOMTreeNode): boolean {
    const setReason = (reason: string) => {
      if (node.renderInfo) {
        node.renderInfo.interactiveReason = reason;
      }
    };

    // Skip non-element nodes
    if (node.nodeType !== NodeType.ELEMENT_NODE) {
      setReason('not element node');
      return false;
    }

    const tagName = node.nodeName.toLowerCase();

    // Skip html and body nodes
    if (tagName === 'html' || tagName === 'body') {
      setReason(`skip ${tagName} tag`);
      return false;
    }

    // Check disabled/hidden via HTML attributes
    if (node.attributes) {
      if (
        node.attributes.disabled !== undefined ||
        node.attributes['aria-disabled'] === 'true'
      ) {
        setReason('disabled');
        return false;
      }

      if (node.attributes['aria-hidden'] === 'true') {
        setReason('aria-hidden');
        return false;
      }
    }

    // Check interactive HTML tags
    if (INTERACTIVE_TAGS.has(tagName)) {
      setReason(`interactive tag: ${tagName}`);
      return true;
    }

    // Check for interactive attributes
    if (node.attributes) {
      const matchedAttr = Array.from(INTERACTIVE_ATTRIBUTES).find(
        attr => attr in node.attributes,
      );
      if (matchedAttr) {
        setReason(`interactive attribute: ${matchedAttr}`);
        return true;
      }

      // Check for interactive ARIA roles
      const role = node.attributes.role;
      if (role && INTERACTIVE_ROLES.has(role)) {
        setReason(`interactive role: ${role}`);
        return true;
      }
    }

    // Cursor style indicates interactivity
    if (node.snapshotNode?.cursorStyle === 'pointer') {
      setReason('cursor: pointer');
      return true;
    }

    // Only treat as text-cursor interactive if no child already has cursor: text,
    // otherwise this is a container wrapping the real input element.
    if (node.snapshotNode?.cursorStyle === 'text') {
      if (!hasNonTextDescendantWithCursor(node, 'text')) {
        setReason('cursor: text');
        return true;
      }
    }

    if (node.snapshotNode?.isClickable) {
      // Only treat as clickable if no descendant is already interactive,
      // otherwise this is likely a container element wrapping real interactive children.
      if (!hasClickableDescendant(node)) {
        setReason('isClickable');
        return true;
      }
    }

    setReason('no interactive indicators');
    return false;
  }

  /**
   * Check if element is fillable (can receive text input)
   */
  static isFillable(node: EnhancedDOMTreeNode): boolean {
    if (node.nodeType !== NodeType.ELEMENT_NODE) {
      return false;
    }

    const tagName = node.nodeName.toLowerCase();

    // Textarea is always fillable
    if (tagName === 'textarea') {
      return true;
    }

    // Input elements (except certain types)
    if (tagName === 'input') {
      const inputType = (node.attributes?.type ?? 'text').toLowerCase();
      const nonFillableTypes = new Set([
        'button',
        'submit',
        'reset',
        'image',
        'checkbox',
        'radio',
        'file',
        'hidden',
      ]);
      return !nonFillableTypes.has(inputType);
    }

    // ARIA slider elements
    if (node.attributes?.role === 'slider') {
      return true;
    }

    // Contenteditable elements
    if (node.attributes?.contenteditable === 'true') {
      return true;
    }

    // Elements with textbox role
    if (node.attributes?.role === 'textbox') {
      return true;
    }

    // Cursor text style indicates fillable input area
    if (node.snapshotNode?.cursorStyle === 'text') {
      if (!hasNonTextDescendantWithCursor(node, 'text')) {
        return true;
      }
    }

    return false;
  }
}
