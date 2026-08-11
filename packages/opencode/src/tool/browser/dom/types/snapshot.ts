/**
 * Snapshot-related Type Definitions
 *
 * Types for DOM snapshot data extracted from CDP DOMSnapshot.
 */

import type { DOMRect } from './dom-node';

/**
 * Enhanced snapshot node with extracted layout/style data
 */
export interface EnhancedSnapshotNode {
  // Boolean defaults to false
  isClickable: boolean;

  // Optional properties (only set when have values)
  cursorStyle?: string;
  bounds?: DOMRect;
  clientRects?: DOMRect;
  scrollRects?: DOMRect;
  computedStyles?: Record<string, string>;
  paintOrder?: number;
  stackingContexts?: number;
  inputValue?: string;
}

/**
 * Required computed styles for interactivity and visibility detection
 */
export const REQUIRED_COMPUTED_STYLES = [
  'display',
  'visibility',
  'opacity',
  'overflow',
  'overflow-x',
  'overflow-y',
  'cursor',
  'pointer-events',
  'position',
  'background-color',
  'background-image',
] as const;

/**
 * Snapshot lookup map: backendNodeId -> EnhancedSnapshotNode
 */
export type SnapshotLookup = Map<number, EnhancedSnapshotNode>;

/**
 * Frame document snapshot
 */
export interface DocumentSnapshotInfo {
  frameId: string;
  documentURL: string;
  nodes: Map<number, EnhancedSnapshotNode>;
}

/**
 * Complete snapshot lookup with frame mapping
 */
export interface SnapshotLookupResult {
  backendIdToSnapshot: SnapshotLookup;
  frameIdToDocument: Map<string, DocumentSnapshotInfo>;
}

/**
 * Data captured from a single OOPIF (cross-origin iframe) session
 */
export interface OOPIFTreeData {
  sessionId: string;
  frameId: string;
  frameUrl: string;
  /** backendNodeId of the IFRAME element in the main DOM tree */
  ownerBackendNodeId: number;
  snapshot: import('./cdp').DOMSnapshot.CaptureSnapshotResponse;
  domTree: import('./cdp').DOM.GetDocumentResponse;
  axTree: import('./cdp').Accessibility.GetFullAXTreeResponse;
}

/**
 * All trees fetched from CDP for a target
 */
export interface TargetAllTrees {
  snapshot: import('./cdp').DOMSnapshot.CaptureSnapshotResponse;
  domTree: import('./cdp').DOM.GetDocumentResponse;
  axTree: import('./cdp').Accessibility.GetFullAXTreeResponse;
  devicePixelRatio: number;
  /** DOM data from cross-origin iframe sessions */
  oopifTrees?: OOPIFTreeData[];
}

/**
 * Options for capturing DOM snapshot
 */
export interface SnapshotOptions {
  /**
   * Whether to highlight elements (for debugging)
   */
  doHighlightElements?: boolean;

  /**
   * Focus on specific highlight index (for debugging)
   */
  focusHighlightIndex?: number;
}

/**
 * Complete DOM snapshot with all required data
 */
export interface CompleteSnapshot {
  domSnapshot: import('./cdp').DOMSnapshot.CaptureSnapshotResponse;
  axTree: import('./cdp').Accessibility.GetFullAXTreeResponse;
  viewport: import('./cdp').Page.GetLayoutMetricsResponse;
  devicePixelRatio: number;
  options: SnapshotOptions;
}
