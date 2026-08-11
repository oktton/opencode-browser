/**
 * DOM Tree Builder
 *
 * Builds enhanced DOM tree from CDP data, combining DOM, AX, and Snapshot information.
 * This is the TypeScript port of Python's get_dom_tree and _construct_enhanced_node.
 */

import type { DOM } from '../types/cdp';
import { generateUUID } from '../utils/index';
import { generateXPath } from './xpath';
import { getWhitelistedAttributes } from './attributes';
import type {
  EnhancedDOMTreeNode,
  DOMRect,
  ShadowRootType,
  BoundaryAncestor,
} from '../types/dom-node';
import { NodeType } from '../types/dom-node';
import type { AXTreeLookup } from '../types/ax';
import { buildAXTreeLookup } from '../types/ax';
import type {
  SnapshotLookup,
  TargetAllTrees,
  OOPIFTreeData,
} from '../types/snapshot';
import { buildSnapshotLookup } from '../snapshot/lookup';

/**
 * Result from building the DOM tree
 */
export interface TreeBuildResult {
  root: EnhancedDOMTreeNode;
}

/**
 * DOM Tree Builder
 *
 * Constructs enhanced DOM tree nodes by combining data from
 * DOM tree, accessibility tree, and DOM snapshot.
 */
export class DOMTreeBuilder {
  private snapshotLookup: SnapshotLookup;
  private axTreeLookup: AXTreeLookup;
  private enhancedNodeLookup = new Map<number, EnhancedDOMTreeNode>();
  private devicePixelRatio: number;
  /** OOPIF data keyed by the owner IFRAME element's backendNodeId */
  private oopifByOwner = new Map<number, OOPIFTreeData>();

  constructor(private trees: TargetAllTrees) {
    this.devicePixelRatio = trees.devicePixelRatio;

    // Build lookups
    this.snapshotLookup = buildSnapshotLookup(
      trees.snapshot,
      this.devicePixelRatio,
    );
    this.axTreeLookup = buildAXTreeLookup(trees.axTree.nodes);

    // Build OOPIF lookup by owner backendNodeId
    if (trees.oopifTrees) {
      for (const oopif of trees.oopifTrees) {
        this.oopifByOwner.set(oopif.ownerBackendNodeId, oopif);
      }
    }
  }

  /**
   * Build the enhanced DOM tree
   *
   * @param initialFrameOffset - Starting offset for coordinate calculation.
   *   For OOPIF sub-trees, this is the accumulated offset from the parent iframe.
   */
  async build(
    initialFrameOffset?: DOMRect,
    xpathPrefix?: string,
  ): Promise<TreeBuildResult> {
    const root = await this.constructEnhancedNode(
      this.trees.domTree.root,
      initialFrameOffset ?? { x: 0, y: 0, width: 0, height: 0 },
      0,
      xpathPrefix ?? '',
    );

    assignXPaths(root);

    return { root };
  }

  /**
   * Recursively construct enhanced DOM tree nodes
   *
   * This is the TypeScript port of Python's _construct_enhanced_node.
   */
  private async constructEnhancedNode(
    node: DOM.Node,
    totalFrameOffset: DOMRect,
    iframeDepth: number,
    xpathPrefix: string,
  ): Promise<EnhancedDOMTreeNode> {
    // Clone offset to avoid reference issues
    const frameOffset = { ...totalFrameOffset };

    // Check for memoized node
    if (this.enhancedNodeLookup.has(node.nodeId)) {
      return this.enhancedNodeLookup.get(node.nodeId)!;
    }

    // Get AX node (stored for future use)
    const axNode = this.axTreeLookup.get(node.backendNodeId) ?? null;

    // Parse attributes to readable format
    const attributes: Record<string, string> = {};
    if (node.attributes) {
      for (let i = 0; i < node.attributes.length; i += 2) {
        attributes[node.attributes[i]] = node.attributes[i + 1];
      }
    }

    // Parse shadow root type
    let shadowRootType: ShadowRootType | null = null;
    if (node.shadowRootType) {
      shadowRootType = node.shadowRootType;
    }

    // Get snapshot data
    const snapshotData = this.snapshotLookup.get(node.backendNodeId) ?? null;

    // Calculate absolute position
    let absolutePosition: DOMRect | null = null;
    if (snapshotData?.bounds) {
      absolutePosition = {
        x: snapshotData.bounds.x + frameOffset.x,
        y: snapshotData.bounds.y + frameOffset.y,
        width: snapshotData.bounds.width,
        height: snapshotData.bounds.height,
      };
    }

    // Create the enhanced node (only set properties with actual values)
    const whitelistedAttributes = getWhitelistedAttributes(
      node.nodeName,
      attributes,
    );

    const enhancedNode: EnhancedDOMTreeNode = {
      nodeId: node.nodeId,
      backendNodeId: node.backendNodeId,
      nodeType: node.nodeType as NodeType,
      nodeName: node.nodeName,
      nodeValue: node.nodeValue ?? '',
      attributes,
      whitelistedAttributes:
        Object.keys(whitelistedAttributes).length > 0
          ? whitelistedAttributes
          : undefined,
      uuid: generateUUID(),
      renderInfo: {
        isVisible: false,
        isInteractive: false,
        isIframeHost: false,
        isTopElement: false,
        isShadowHost: false,
        isCandidate: false,
        isDuplicateListener: false,
      },
    };

    // Only set optional properties when they have values
    if (absolutePosition) {
      enhancedNode.absolutePosition = absolutePosition;
    }
    if (node.frameId) {
      enhancedNode.frameId = node.frameId;
    }
    if (shadowRootType) {
      enhancedNode.shadowRootType = shadowRootType;
    }
    if (axNode) {
      enhancedNode.axNode = axNode;
    }
    if (snapshotData) {
      enhancedNode.snapshotNode = snapshotData;
    }

    // Store in lookup for memoization and parent reference
    this.enhancedNodeLookup.set(node.nodeId, enhancedNode);

    // Set parent reference
    if (
      node.parentId !== undefined &&
      this.enhancedNodeLookup.has(node.parentId)
    ) {
      enhancedNode.parentNode = this.enhancedNodeLookup.get(node.parentId)!;
    }

    // xpath prefix stored for post-build assignment (siblings not in parent.childrenNodes yet)
    enhancedNode._xpathPrefix = xpathPrefix;

    // Check if this is an HTML frame node — adjust offset by scroll
    if (
      node.nodeType === NodeType.ELEMENT_NODE &&
      node.nodeName === 'HTML' &&
      node.frameId
    ) {
      if (snapshotData?.scrollRects) {
        frameOffset.x -= snapshotData.scrollRects.x;
        frameOffset.y -= snapshotData.scrollRects.y;
      }
    }

    // Handle IFRAME/FRAME elements — adjust offset by iframe position
    const tagName = node.nodeName.toUpperCase();
    if ((tagName === 'IFRAME' || tagName === 'FRAME') && snapshotData?.bounds) {
      frameOffset.x += snapshotData.bounds.x;
      frameOffset.y += snapshotData.bounds.y;
    }

    // Process content document (for iframes)
    if (node.contentDocument) {
      // Same-origin iframe: CDP provides contentDocument directly
      const iframePrefix = `${enhancedNode.xpath} [IFRAME] `;
      enhancedNode.contentDocument = await this.constructEnhancedNode(
        node.contentDocument,
        frameOffset,
        iframeDepth + 1,
        iframePrefix,
      );
      enhancedNode.contentDocument.parentNode = enhancedNode;
    } else if (
      (tagName === 'IFRAME' || tagName === 'FRAME') &&
      this.oopifByOwner.has(node.backendNodeId)
    ) {
      // OOPIF: cross-origin iframe captured via separate CDP session
      // Pass the accumulated frameOffset so OOPIF nodes get correct absolute positions
      const oopifData = this.oopifByOwner.get(node.backendNodeId)!;
      try {
        const iframePrefix = `${enhancedNode.xpath} [IFRAME] `;
        const subBuilder = new DOMTreeBuilder({
          snapshot: oopifData.snapshot,
          domTree: oopifData.domTree,
          axTree: oopifData.axTree,
          devicePixelRatio: this.devicePixelRatio,
        });
        const { root: oopifRoot } = await subBuilder.build(
          frameOffset,
          iframePrefix,
        );
        tagOOPIFNodes(oopifRoot, oopifData.sessionId);
        enhancedNode.contentDocument = oopifRoot;
        enhancedNode.contentDocument.parentNode = enhancedNode;
      } catch (error) {
        // silently ignore OOPIF tree build failures
      }
    }

    // Process shadow roots
    if (node.shadowRoots && node.shadowRoots.length > 0) {
      enhancedNode.shadowRoots = [];
      const shadowPrefix = `${enhancedNode.xpath} [SHADOW] `;
      for (const shadowRoot of node.shadowRoots) {
        const shadowRootNode = await this.constructEnhancedNode(
          shadowRoot,
          frameOffset,
          iframeDepth,
          shadowPrefix,
        );
        shadowRootNode.parentNode = enhancedNode;
        enhancedNode.shadowRoots.push(shadowRootNode);
      }
    }

    // Process children
    if (node.children && node.children.length > 0) {
      enhancedNode.childrenNodes = [];

      // Build set of shadow root node IDs to filter them out
      const shadowRootNodeIds = new Set<number>();
      if (node.shadowRoots) {
        for (const sr of node.shadowRoots) {
          shadowRootNodeIds.add(sr.nodeId);
        }
      }

      for (const child of node.children) {
        // Skip shadow roots (they're in shadowRoots list)
        if (shadowRootNodeIds.has(child.nodeId)) {
          continue;
        }

        const childNode = await this.constructEnhancedNode(
          child,
          frameOffset,
          iframeDepth,
          xpathPrefix,
        );
        enhancedNode.childrenNodes.push(childNode);
      }
    }

    return enhancedNode;
  }

  /**
   * Get the snapshot lookup (for external use)
   */
  getSnapshotLookup(): SnapshotLookup {
    return this.snapshotLookup;
  }

  /**
   * Get the AX tree lookup (for external use)
   */
  getAXTreeLookup(): AXTreeLookup {
    return this.axTreeLookup;
  }

  /**
   * Get device pixel ratio
   */
  getDevicePixelRatio(): number {
    return this.devicePixelRatio;
  }
}

/**
 * Assign xpaths to all nodes after tree is fully built
 * (siblings are in parent.childrenNodes so position calculation works)
 */
function assignXPaths(node: EnhancedDOMTreeNode): void {
  const prefix = node._xpathPrefix ?? '';
  const localXpath = generateXPath(node);
  node.xpath = prefix ? `${prefix}${localXpath}` : localXpath;
  delete node._xpathPrefix;

  for (const child of node.childrenNodes ?? []) {
    assignXPaths(child);
  }
  for (const sr of node.shadowRoots ?? []) {
    assignXPaths(sr);
  }
  if (node.contentDocument) {
    assignXPaths(node.contentDocument);
  }
}

/**
 * Tag all nodes in an OOPIF sub-tree with the session ID
 * so downstream code can route CDP commands to the correct session.
 */
function tagOOPIFNodes(node: EnhancedDOMTreeNode, sessionId: string): void {
  node.oopifSessionId = sessionId;
  for (const child of node.childrenNodes ?? []) {
    tagOOPIFNodes(child, sessionId);
  }
  for (const sr of node.shadowRoots ?? []) {
    tagOOPIFNodes(sr, sessionId);
  }
  if (node.contentDocument) {
    tagOOPIFNodes(node.contentDocument, sessionId);
  }
}
