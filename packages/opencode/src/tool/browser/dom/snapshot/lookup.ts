/**
 * Snapshot Lookup Builder
 *
 * Builds lookup tables from CDP DOMSnapshot data for efficient
 * node data access during DOM tree construction.
 */

import type { DOMSnapshot } from '../types/cdp';
import type {
  EnhancedSnapshotNode,
  SnapshotLookup,
  SnapshotLookupResult,
  DocumentSnapshotInfo,
} from '../types/snapshot';
import { REQUIRED_COMPUTED_STYLES } from '../types/snapshot';
import type { DOMRect } from '../types/dom-node';

/**
 * Parse rare boolean data from snapshot
 * Returns true if index is in the rare data array, false otherwise
 */
function parseRareBooleanData(
  rareData: DOMSnapshot.RareBooleanData | undefined,
  index: number,
): boolean {
  if (!rareData?.index) {
    return false;
  }
  return rareData.index.includes(index);
}

/**
 * Parse computed styles from layout tree using string indices
 */
function parseComputedStyles(
  strings: string[],
  styleIndices: number[],
): Record<string, string> {
  const styles: Record<string, string> = {};

  for (let i = 0; i < styleIndices.length; i++) {
    const styleIndex = styleIndices[i];
    if (
      i < REQUIRED_COMPUTED_STYLES.length &&
      styleIndex >= 0 &&
      styleIndex < strings.length
    ) {
      styles[REQUIRED_COMPUTED_STYLES[i]] = strings[styleIndex];
    }
  }

  return styles;
}

/**
 * Parse bounds array to DOMRect, applying device pixel ratio scaling
 */
function parseBounds(
  bounds: number[],
  devicePixelRatio: number,
): DOMRect | null {
  if (!bounds || bounds.length < 4) {
    return null;
  }

  // CDP coordinates are in device pixels, convert to CSS pixels
  return {
    x: bounds[0] / devicePixelRatio,
    y: bounds[1] / devicePixelRatio,
    width: bounds[2] / devicePixelRatio,
    height: bounds[3] / devicePixelRatio,
  };
}

/**
 * Parse rect data (client/scroll rects) - these don't need device pixel ratio scaling
 */
function parseRects(rectData: number[] | undefined): DOMRect | null {
  if (!rectData || rectData.length < 4) {
    return null;
  }

  return {
    x: rectData[0],
    y: rectData[1],
    width: rectData[2],
    height: rectData[3],
  };
}

/**
 * Build snapshot lookup from CDP snapshot response
 *
 * Creates a map from backendNodeId to EnhancedSnapshotNode with all
 * layout, style, and interactivity data pre-calculated.
 */
export function buildSnapshotLookup(
  snapshot: DOMSnapshot.CaptureSnapshotResponse,
  devicePixelRatio = 1.0,
): SnapshotLookup {
  const snapshotLookup: SnapshotLookup = new Map();

  if (!snapshot.documents || snapshot.documents.length === 0) {
    return snapshotLookup;
  }

  const strings = snapshot.strings;

  for (const document of snapshot.documents) {
    const nodes = document.nodes;
    const layout = document.layout;

    // Build backend node ID to snapshot index lookup
    const backendNodeToSnapshotIndex = new Map<number, number>();
    if (nodes.backendNodeId) {
      for (let i = 0; i < nodes.backendNodeId.length; i++) {
        backendNodeToSnapshotIndex.set(nodes.backendNodeId[i], i);
      }
    }

    // Build layout index map (use first occurrence for duplicates)
    const layoutIndexMap = new Map<number, number>();
    if (layout?.nodeIndex) {
      for (
        let layoutIdx = 0;
        layoutIdx < layout.nodeIndex.length;
        layoutIdx++
      ) {
        const nodeIndex = layout.nodeIndex[layoutIdx];
        if (!layoutIndexMap.has(nodeIndex)) {
          layoutIndexMap.set(nodeIndex, layoutIdx);
        }
      }
    }

    // Build snapshot lookup for each backend node ID
    for (const [backendNodeId, snapshotIndex] of backendNodeToSnapshotIndex) {
      // Create enhanced snapshot node with required fields
      const enhancedNode: EnhancedSnapshotNode = {
        isClickable: parseRareBooleanData(nodes.isClickable, snapshotIndex),
      };

      // Get layout data if available
      const layoutIdx = layoutIndexMap.get(snapshotIndex);
      if (layoutIdx !== undefined && layout) {
        // Parse bounding box
        if (layout.bounds && layoutIdx < layout.bounds.length) {
          const bounds = parseBounds(
            layout.bounds[layoutIdx],
            devicePixelRatio,
          );
          if (bounds) enhancedNode.bounds = bounds;
        }

        // Parse computed styles
        if (layout.styles && layoutIdx < layout.styles.length) {
          const styleIndices = layout.styles[layoutIdx];
          const computedStyles = parseComputedStyles(strings, styleIndices);
          if (Object.keys(computedStyles).length > 0) {
            enhancedNode.computedStyles = computedStyles;
            if (computedStyles.cursor) {
              enhancedNode.cursorStyle = computedStyles.cursor;
            }
          }
        }

        // Extract paint order
        if (layout.paintOrders && layoutIdx < layout.paintOrders.length) {
          enhancedNode.paintOrder = layout.paintOrders[layoutIdx];
        }

        // Extract client rects
        if (layout.clientRects && layoutIdx < layout.clientRects.length) {
          const clientRects = parseRects(layout.clientRects[layoutIdx]);
          if (clientRects) enhancedNode.clientRects = clientRects;
        }

        // Extract scroll rects
        if (layout.scrollRects && layoutIdx < layout.scrollRects.length) {
          const scrollRects = parseRects(layout.scrollRects[layoutIdx]);
          if (scrollRects) enhancedNode.scrollRects = scrollRects;
        }

        // Extract stacking contexts
        if (
          layout.stackingContexts?.index &&
          layoutIdx < layout.stackingContexts.index.length
        ) {
          enhancedNode.stackingContexts =
            layout.stackingContexts.index[layoutIdx];
        }
      }

      snapshotLookup.set(backendNodeId, enhancedNode);
    }
  }

  return snapshotLookup;
}

/**
 * Build complete snapshot lookup with frame information
 */
export function buildSnapshotLookupWithFrames(
  snapshot: DOMSnapshot.CaptureSnapshotResponse,
  devicePixelRatio = 1.0,
): SnapshotLookupResult {
  const backendIdToSnapshot: SnapshotLookup = new Map();
  const frameIdToDocument = new Map<string, DocumentSnapshotInfo>();

  if (!snapshot.documents || snapshot.documents.length === 0) {
    return { backendIdToSnapshot, frameIdToDocument };
  }

  const strings = snapshot.strings;

  for (const document of snapshot.documents) {
    const nodes = document.nodes;
    const layout = document.layout;

    // Get frame ID
    const frameId =
      document.frameId !== undefined && document.frameId < strings.length
        ? strings[document.frameId]
        : '';

    // Get document URL
    const documentURL =
      document.documentURL !== undefined &&
      document.documentURL < strings.length
        ? strings[document.documentURL]
        : '';

    // Build backend node ID to snapshot index lookup
    const backendNodeToSnapshotIndex = new Map<number, number>();
    if (nodes.backendNodeId) {
      for (let i = 0; i < nodes.backendNodeId.length; i++) {
        backendNodeToSnapshotIndex.set(nodes.backendNodeId[i], i);
      }
    }

    // Build layout index map
    const layoutIndexMap = new Map<number, number>();
    if (layout?.nodeIndex) {
      for (
        let layoutIdx = 0;
        layoutIdx < layout.nodeIndex.length;
        layoutIdx++
      ) {
        const nodeIndex = layout.nodeIndex[layoutIdx];
        if (!layoutIndexMap.has(nodeIndex)) {
          layoutIndexMap.set(nodeIndex, layoutIdx);
        }
      }
    }

    // Per-document node map
    const documentNodes = new Map<number, EnhancedSnapshotNode>();

    // Build snapshot lookup for each backend node ID
    for (const [backendNodeId, snapshotIndex] of backendNodeToSnapshotIndex) {
      const enhancedNode: EnhancedSnapshotNode = {
        isClickable: parseRareBooleanData(nodes.isClickable, snapshotIndex),
      };

      const layoutIdx = layoutIndexMap.get(snapshotIndex);
      if (layoutIdx !== undefined && layout) {
        if (layout.bounds && layoutIdx < layout.bounds.length) {
          const bounds = parseBounds(
            layout.bounds[layoutIdx],
            devicePixelRatio,
          );
          if (bounds) enhancedNode.bounds = bounds;
        }

        if (layout.styles && layoutIdx < layout.styles.length) {
          const styleIndices = layout.styles[layoutIdx];
          const computedStyles = parseComputedStyles(strings, styleIndices);
          if (Object.keys(computedStyles).length > 0) {
            enhancedNode.computedStyles = computedStyles;
            if (computedStyles.cursor) {
              enhancedNode.cursorStyle = computedStyles.cursor;
            }
          }
        }

        if (layout.paintOrders && layoutIdx < layout.paintOrders.length) {
          enhancedNode.paintOrder = layout.paintOrders[layoutIdx];
        }

        if (layout.clientRects && layoutIdx < layout.clientRects.length) {
          const clientRects = parseRects(layout.clientRects[layoutIdx]);
          if (clientRects) enhancedNode.clientRects = clientRects;
        }

        if (layout.scrollRects && layoutIdx < layout.scrollRects.length) {
          const scrollRects = parseRects(layout.scrollRects[layoutIdx]);
          if (scrollRects) enhancedNode.scrollRects = scrollRects;
        }

        if (
          layout.stackingContexts?.index &&
          layoutIdx < layout.stackingContexts.index.length
        ) {
          enhancedNode.stackingContexts =
            layout.stackingContexts.index[layoutIdx];
        }
      }

      backendIdToSnapshot.set(backendNodeId, enhancedNode);
      documentNodes.set(backendNodeId, enhancedNode);
    }

    // Store frame document info
    if (frameId) {
      frameIdToDocument.set(frameId, {
        frameId,
        documentURL,
        nodes: documentNodes,
      });
    }
  }

  return { backendIdToSnapshot, frameIdToDocument };
}
