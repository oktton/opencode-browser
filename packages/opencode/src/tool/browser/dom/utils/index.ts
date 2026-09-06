/**
 * Utils Module - Unified Exports
 *
 * Utility functions for DOM processing.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { EnhancedDOMTreeNode } from '../types/dom-node';

const DEBUG_FOLDER = path.join(os.homedir(), 'Desktop', 'dom_debug');

/** Encode backendNodeId to alpha string: 841 → "ife" */
export function encodeViewId(id: number): string {
  return id
    .toString()
    .split('')
    .map(d => String.fromCharCode(97 + +d))
    .join('');
}

/** Top-level visual/structural elements: kept when isTopElement */
export const VISUAL_TOP_TAGS = new Set([
  'svg',
  'img',
  'table',
  'dl',
  'pre',
  'figure',
  'details',
  'math',
  'canvas',
  'video',
  'audio',
  'picture',
  'object',
  'embed',
  'meter',
  'progress',
]);

/** Visual ARIA roles: elements with these roles are preserved from pruning */
const VISUAL_ROLES = new Set([
  'img',
  'graphics-document',
  'graphics-symbol',
  'meter',
  'progressbar',
  'figure',
  'math',
]);

/** Check if node is a visual top element by tag name, ARIA role, or CSS background-image */
export function isVisualTopNode(node: EnhancedDOMTreeNode): boolean {
  const tagName = node.nodeName.toLowerCase();
  if (VISUAL_TOP_TAGS.has(tagName)) return true;
  const role = node.attributes?.role;
  if (role && VISUAL_ROLES.has(role)) return true;
  // Empty interactive elements with background-image are icon buttons
  const bgImage = node.snapshotNode?.computedStyles?.['background-image'];
  if (bgImage && bgImage !== 'none' && node.renderInfo?.isTopElement)
    return true;
  return false;
}

/** Check if node is a visual element that renders separately (requires isTopElement) */
export function isVisualElement(node: EnhancedDOMTreeNode): boolean {
  if (!node.renderInfo?.isTopElement) return false;
  return (
    isVisualTopNode(node) ||
    STRUCTURAL_CHILD_TAGS.has(node.nodeName.toLowerCase())
  );
}
/** Child structural tags: always kept (only exist inside their parent visual element) */
export const STRUCTURAL_CHILD_TAGS = new Set([
  // table
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
  // definition list
  'dt',
  'dd',
  // figure
  'figcaption',
  // details
  'summary',
  // pre/code
  'code',
]);

/**
 * Save debug JSON (removes circular references)
 */
export function saveDebugJson(filename: string, data: unknown): void {
  if (!process.env.DOM_DEBUG_SAVE) return;
  try {
    if (!fs.existsSync(DEBUG_FOLDER)) {
      fs.mkdirSync(DEBUG_FOLDER, { recursive: true });
    }
    const filepath = path.join(DEBUG_FOLDER, filename);

    // Handle circular references
    const seen = new WeakSet();
    const json = JSON.stringify(
      data,
      (key, value) => {
        if (key === 'parentNode' || key === 'originalNode') {
          return undefined;
        }
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) {
            return '[Circular]';
          }
          seen.add(value);
        }
        return value;
      },
      2,
    );

    fs.writeFileSync(filepath, json, 'utf-8');
  } catch (error) {
    // silently ignore debug save failures
  }
}

/**
 * Generate UUID v4
 */
export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Deep clone an object
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (obj instanceof Date) {
    return new Date(obj.getTime()) as T;
  }

  if (obj instanceof Array) {
    return obj.map(item => deepClone(item)) as T;
  }

  if (obj instanceof Map) {
    return new Map(
      Array.from(obj.entries()).map(([k, v]) => [deepClone(k), deepClone(v)]),
    ) as T;
  }

  if (obj instanceof Set) {
    return new Set(Array.from(obj).map(item => deepClone(item))) as T;
  }

  const clonedObj = {} as T;
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      (clonedObj as Record<string, unknown>)[key] = deepClone(
        (obj as Record<string, unknown>)[key],
      );
    }
  }

  return clonedObj;
}

/**
 * Deep-copy a DOM tree for prune debugging.
 * Skips parentNode to avoid circular refs, rebuilds parent links on the copy.
 * Returns the copied root and a backendNodeId → copied node lookup map.
 */
export function copyDomTree(root: EnhancedDOMTreeNode): EnhancedDOMTreeNode {
  function clone(
    node: EnhancedDOMTreeNode,
    parent?: EnhancedDOMTreeNode,
  ): EnhancedDOMTreeNode {
    const copy: EnhancedDOMTreeNode = {
      ...node,
      renderInfo: { ...node.renderInfo },
      parentNode: parent,
      childrenNodes: [],
      shadowRoots: undefined,
      contentDocument: undefined,
    };

    if (node.axNode) copy.axNode = { ...node.axNode };
    if (node.whitelistedAttributes)
      copy.whitelistedAttributes = { ...node.whitelistedAttributes };
    if (node.attributes) copy.attributes = { ...node.attributes };

    copy.childrenNodes = (node.childrenNodes ?? []).map(c => clone(c, copy));

    if (node.shadowRoots) {
      copy.shadowRoots = node.shadowRoots.map(sr => clone(sr, copy));
    }
    if (node.contentDocument) {
      copy.contentDocument = clone(node.contentDocument, copy);
    }

    return copy;
  }

  return clone(root);
}

/**
 * Mark a node in the debug copy tree with a prune reason.
 */
export function markPruneReason(
  lookup: Map<string, EnhancedDOMTreeNode>,
  node: EnhancedDOMTreeNode,
  reason: string,
): void {
  const record = lookup.get(nodeKey(node));
  if (record) {
    record.renderInfo.pruneReason = record.renderInfo.pruneReason
      ? `${record.renderInfo.pruneReason} | ${reason}`
      : reason;
  }
}

/**
 * Composite key for cross-OOPIF unique identity.
 * backendNodeId is only unique within a CDP session; different OOPIFs can overlap.
 * Uses frameId (stable across CDP re-attachments) instead of oopifSessionId.
 */
export function nodeKey(node: EnhancedDOMTreeNode): string {
  return `${node.frameId ?? ''}:${node.backendNodeId}`;
}

/**
 * Build a lookup map from composite nodeKey to node (OOPIF-safe).
 */
export function buildNodeKeyLookup(
  root: EnhancedDOMTreeNode,
): Map<string, EnhancedDOMTreeNode> {
  const lookup = new Map<string, EnhancedDOMTreeNode>();

  const visit = (node: EnhancedDOMTreeNode) => {
    lookup.set(nodeKey(node), node);
    for (const child of node.childrenNodes ?? []) {
      visit(child);
    }
    for (const shadow of node.shadowRoots ?? []) {
      visit(shadow);
    }
    if (node.contentDocument) {
      visit(node.contentDocument);
    }
  };

  visit(root);
  return lookup;
}

/**
 * Boundary crossing record in ancestor chain
 */
export interface AncestorBoundary {
  type: 'shadowRoot' | 'contentDocument';
  /** backendNodeId of the host/iframe element that owns this boundary */
  hostBackendNodeId: number;
}

/**
 * Flatten nested DOM tree into a flat array.
 * Each node includes ancestorBackendNodeIds, childrenBackendNodeIds (direct only),
 * ancestorBoundaries tracking shadow/iframe crossings, and full xpath from the node.
 */
export function flattenDomTree(
  root: EnhancedDOMTreeNode,
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];

  const visit = (
    node: EnhancedDOMTreeNode,
    ancestors: number[],
    boundaries: AncestorBoundary[],
  ) => {
    const childrenBackendNodeIds: number[] = [];
    for (const child of node.childrenNodes ?? []) {
      childrenBackendNodeIds.push(child.backendNodeId);
    }

    const shadowRootBackendNodeIds: number[] = [];
    for (const shadow of node.shadowRoots ?? []) {
      shadowRootBackendNodeIds.push(shadow.backendNodeId);
    }

    const contentDocumentBackendNodeId =
      node.contentDocument?.backendNodeId ?? null;

    // Exclude tree navigation fields (circular refs), then deep clone the rest
    const {
      parentNode,
      childrenNodes,
      shadowRoots,
      contentDocument,
      ...serializable
    } = node;
    const flatNode: Record<string, unknown> = {
      ...deepClone(serializable),
      ancestorBackendNodeIds: [...ancestors],
      childrenBackendNodeIds,
      shadowRootBackendNodeIds,
      contentDocumentBackendNodeId,
      ancestorBoundaries: boundaries.map(b => ({ ...b })),
    };
    result.push(flatNode);

    const nextAncestors = [...ancestors, node.backendNodeId];

    for (const child of node.childrenNodes ?? []) {
      visit(child, nextAncestors, boundaries);
    }
    for (const shadow of node.shadowRoots ?? []) {
      visit(shadow, nextAncestors, [
        ...boundaries,
        { type: 'shadowRoot', hostBackendNodeId: node.backendNodeId },
      ]);
    }
    if (node.contentDocument) {
      visit(node.contentDocument, nextAncestors, [
        ...boundaries,
        { type: 'contentDocument', hostBackendNodeId: node.backendNodeId },
      ]);
    }
  };

  visit(root, [], []);
  return result;
}

/**
 * Render enhanced DOM tree as a minimal debug HTML string.
 * Each element shows [backendNodeId]<tag>, text nodes show their nodeValue.
 */
export function renderDebugHtml(root: EnhancedDOMTreeNode): string {
  const INDENT = '  ';

  const render = (node: EnhancedDOMTreeNode, depth: number): string => {
    const pad = INDENT.repeat(depth);
    const lines: string[] = [];

    if (node.nodeType === 3) {
      const text = node.nodeValue.trim();
      if (text) {
        const display = node.snapshotNode?.computedStyles?.display;
        const inlineTag = display === 'inline' ? ' [inline]' : '';
        lines.push(`${pad}[${node.backendNodeId}] "${text}"${inlineTag}`);
      }
      return lines.join('\n');
    }

    const tag = node.nodeName.toLowerCase();
    const display = node.snapshotNode?.computedStyles?.display;
    const inlineTag = display === 'inline' ? ' [inline]' : '';
    const childLines: string[] = [];

    for (const child of node.childrenNodes ?? []) {
      const s = render(child, depth + 1);
      if (s) childLines.push(s);
    }

    for (const shadow of node.shadowRoots ?? []) {
      childLines.push(`${INDENT.repeat(depth + 1)}#shadow-root`);
      const s = render(shadow, depth + 2);
      if (s) childLines.push(s);
    }

    if (node.contentDocument) {
      childLines.push(`${INDENT.repeat(depth + 1)}#document (iframe)`);
      const s = render(node.contentDocument, depth + 2);
      if (s) childLines.push(s);
    }

    if (childLines.length > 0) {
      lines.push(`${pad}[${node.backendNodeId}] <${tag}>${inlineTag}`);
      lines.push(...childLines);
      lines.push(`${pad}</${tag}>`);
    } else {
      lines.push(`${pad}[${node.backendNodeId}] <${tag} />${inlineTag}`);
    }

    return lines.join('\n');
  };

  return render(root, 0);
}

/**
 * Save debug HTML structure to dom_debug folder
 */
export function saveDebugHtml(
  filename: string,
  root: EnhancedDOMTreeNode,
): void {
  if (!process.env.DOM_DEBUG_SAVE) return;
  try {
    if (!fs.existsSync(DEBUG_FOLDER)) {
      fs.mkdirSync(DEBUG_FOLDER, { recursive: true });
    }
    const filepath = path.join(DEBUG_FOLDER, filename);
    fs.writeFileSync(filepath, renderDebugHtml(root), 'utf-8');
  } catch (error) {
    // silently ignore debug save failures
  }
}
