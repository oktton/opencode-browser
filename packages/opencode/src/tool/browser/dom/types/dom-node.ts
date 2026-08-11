/**
 * Enhanced DOM Tree Node Types
 *
 * Core type definitions for the enhanced DOM tree structure
 * that combines DOM, AX (accessibility), and Snapshot data.
 */

import type { EnhancedAXNode } from './ax';
import type { EnhancedSnapshotNode } from './snapshot';
import type { Target } from './cdp';

/**
 * DOM node types based on the DOM specification
 */
export enum NodeType {
  ELEMENT_NODE = 1,
  ATTRIBUTE_NODE = 2,
  TEXT_NODE = 3,
  CDATA_SECTION_NODE = 4,
  ENTITY_REFERENCE_NODE = 5,
  ENTITY_NODE = 6,
  PROCESSING_INSTRUCTION_NODE = 7,
  COMMENT_NODE = 8,
  DOCUMENT_NODE = 9,
  DOCUMENT_TYPE_NODE = 10,
  DOCUMENT_FRAGMENT_NODE = 11,
  NOTATION_NODE = 12,
}

/**
 * Shadow root type
 */
export type ShadowRootType = 'user-agent' | 'open' | 'closed';

/**
 * DOM rectangle with position and dimensions
 */
export interface DOMRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Enhanced DOM tree node combining DOM, AX, and Snapshot data
 */
export interface EnhancedDOMTreeNode {
  // Identity (required)
  nodeId: number;
  backendNodeId: number;
  nodeType: NodeType;
  nodeName: string;
  nodeValue: string;
  attributes: Record<string, string>;
  uuid: string;

  // Absolute position (accounting for frame offsets)
  absolutePosition?: DOMRect;

  // Frame context
  targetId?: string;
  frameId?: string;

  // Content document (for iframe)
  contentDocument?: EnhancedDOMTreeNode;

  // Shadow DOM
  shadowRootType?: ShadowRootType;
  shadowRoots?: EnhancedDOMTreeNode[];

  // Accessibility data (stored for future use, not used in detection)
  axNode?: EnhancedAXNode;

  // Snapshot data
  snapshotNode?: EnhancedSnapshotNode;

  // Filtered attributes (global + tag-specific whitelist)
  whitelistedAttributes?: Record<string, string>;

  // Render information (computed by DomService)
  renderInfo: RenderInfo;

  // Ancestor boundary nodes (iframe or shadow host) from root to this node
  boundaryAncestors?: BoundaryAncestor[];

  // Full XPath including [SHADOW]/[IFRAME] boundary prefixes
  xpath?: string;
  /** Temporary: stored during build, consumed by assignXPaths() */
  _xpathPrefix?: string;

  // OOPIF session (set for nodes inside cross-origin iframes)
  oopifSessionId?: string;

  // Tree navigation
  parentNode?: EnhancedDOMTreeNode;
  childrenNodes?: EnhancedDOMTreeNode[];
}

/**
 * Records an ancestor that introduces a frame or shadow boundary
 */
export interface BoundaryAncestor {
  backendNodeId: number;
  type: 'iframe' | 'shadow';
}

/**
 * Render information for DOM node
 * Contains all properties needed for rendering to HTML
 */
export interface RenderInfo {
  isVisible: boolean;
  isInteractive: boolean;
  /** Reason why isInteractive is true or false */
  interactiveReason?: string;
  isTopElement: boolean;
  isShadowHost: boolean;
  isIframeHost: boolean;
  isCandidate?: boolean;
  isFill?: boolean;
  /** Native control intentionally hidden by UI libraries (e.g. checkbox/radio skinning) */
  isVisuallyHiddenNativeControl?: boolean;
  isDuplicateListener?: boolean;
  isListenerHost?: boolean;
  /** backendNodeId of the ancestor candidate that owns the click listener */
  listenerHostId?: number;
  /** Click listener signatures: `native:scriptId:line:col` or `framework:handler` */
  clickListenerSignatures?: string[];
  highlightIndex?: number;
  /** Element position relative to viewport when in expanded range */
  expandedViewportPosition?: 'above' | 'below' | 'left' | 'right';
  /** Whether this node is a scrollable container (scrollRects > clientRects + overflow check) */
  isScrollable?: boolean;
  /** Whether this scrollable container scrolls horizontally (from child expand directions) */
  isHorizontalScroll?: boolean;
  /** backendNodeId of the nearest scrollable ancestor (propagated down from isScrollable nodes) */
  scrollableContainerId?: number;
  /** Whether this node is a <select> element */
  isSelect?: boolean;
  /** Whether this node is an option under a candidate select */
  isSelectOption?: boolean;
  /** Whether this node is the detected overlay element */
  isOverlay?: boolean;
  /** Expanded element is blocked by an overlay (modal/dialog) */
  isBlockedByOverlay?: boolean;
  // Debug info for top element detection
  hitBackendNodeId?: number;
  ancestorBackendIds?: number[];
  /** Debug: reason this node was pruned (only set on the debug copy tree) */
  pruneReason?: string;
  /** Index of the scrollable container this expanded element belongs to */
  scrollContainerIndex?: number;
  /** Diff status when comparing two DOM snapshots */
  diffStatus?: 'added' | 'removed';
  /** Reason for the diff status */
  diffReason?: string;
  /** Pre-computed text for removed nodes (no children to walk at render time) */
  cachedText?: string;
  /** Rendered HTML line for this element (set during renderToHtml) */
  renderedLine?: string;
}

/**
 * Record of a click/input/select interaction on an element, stored in DOM cache.
 */
export interface InteractionRecord {
  backendNodeId: number;
  action: 'click' | 'input' | 'select';
  renderedLine?: string;
  params?: Record<string, unknown>;
  timestamp: number;
}

/**
 * Propagating bounds for bounding box filtering
 */
export interface PropagatingBounds {
  tag: string;
  bounds: DOMRect;
  nodeId: number;
  depth: number;
}

/**
 * Attributes to include when serializing DOM
 */
export const DEFAULT_INCLUDE_ATTRIBUTES = [
  'title',
  'type',
  'checked',
  'id',
  'name',
  'role',
  'value',
  'placeholder',
  'data-date-format',
  'alt',
  'aria-label',
  'aria-expanded',
  'data-state',
  'aria-checked',
  'aria-valuemin',
  'aria-valuemax',
  'aria-valuenow',
  'aria-placeholder',
  'pattern',
  'min',
  'max',
  'minlength',
  'maxlength',
  'step',
  'accept',
  'multiple',
  'inputmode',
  'autocomplete',
  'data-mask',
  'data-inputmask',
  'data-datepicker',
  'format',
  'expected_format',
  'contenteditable',
  'pseudo',
  'selected',
  'expanded',
  'pressed',
  'disabled',
  'invalid',
  'valuemin',
  'valuemax',
  'valuenow',
  'keyshortcuts',
  'haspopup',
  'multiselectable',
  'required',
  'valuetext',
  'level',
  'busy',
  'live',
  'ax_name',
] as const;

/**
 * Interactive HTML tags
 */
export const INTERACTIVE_TAGS = new Set([
  'button',
  'input',
  'select',
  'textarea',
  'a',
  'details',
  'summary',
  'option',
  'optgroup',
]);

/**
 * Interactive ARIA roles
 */
export const INTERACTIVE_ROLES = new Set([
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
  'searchbox',
  'listbox',
]);
