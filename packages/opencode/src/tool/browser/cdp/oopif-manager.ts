/**
 * OOPIF (Out-of-Process Iframe) Manager
 *
 * Discovers and manages CDP sessions for cross-origin iframes
 * that run in separate Chromium processes. Uses Target.getTargets()
 * to enumerate iframe targets and Target.attachToTarget() to obtain
 * CDP sessions for each.
 */

import type { CDPClient } from './client';
import type { Target, DOMSnapshot, DOM, Accessibility } from '../dom/types/cdp';
import type { OOPIFTreeData } from '../dom/types/snapshot';
import { REQUIRED_COMPUTED_STYLES } from '../dom/types/snapshot';

export interface OOPIFSession {
  sessionId: string;
  targetInfo: Target.TargetInfo;
  frameId: string;
  frameUrl: string;
  /** backendNodeId of the IFRAME element in the main DOM tree */
  ownerBackendNodeId: number;
}

export class OOPIFManager {
  private sessions: Map<string, OOPIFSession> = new Map();
  private cdpClient: CDPClient | null = null;
  /** Maps old sessionId → current sessionId (rebuilt on re-discovery via ownerBackendNodeId) */
  private sessionIdRemap: Map<string, string> = new Map();

  /**
   * Discover and attach to all OOPIF child targets.
   * Uses Target.getTargets() + Target.attachToTarget() for reliable discovery
   * (event-based Target.setAutoAttach doesn't fire reliably in Electron).
   *
   * @param mode - 'tag': first discovery during buildTree, tags iframe elements with sessionId.
   *               'remap': re-discovery for interactions, reads tags to build old→new sessionId remap.
   */
  async discoverOOPIFs(
    cdpClient: CDPClient,
    mode: 'tag' | 'remap' = 'tag',
  ): Promise<OOPIFSession[]> {
    this.cdpClient = cdpClient;
    this.sessions.clear();

    try {
      // Enumerate all targets and filter for iframe types
      const { targetInfos } = await cdpClient.sendCommand<{
        targetInfos: Target.TargetInfo[];
      }>('Target.getTargets');

      const iframeTargets = targetInfos.filter(t => t.type === 'iframe');
      if (iframeTargets.length === 0) return [];


      // Attach to each iframe target to get a CDP session
      for (const targetInfo of iframeTargets) {
        try {
          const { sessionId } = await cdpClient.sendCommand<{
            sessionId: string;
          }>('Target.attachToTarget', {
            targetId: targetInfo.targetId,
            flatten: true,
          });

          const session = await this.resolveSession(
            cdpClient,
            sessionId,
            targetInfo,
            mode,
          );
          if (session) {
            this.sessions.set(session.sessionId, session);
          }
        } catch (error) {
          console.warn(
            `[OOPIF] Failed to attach to ${targetInfo.url}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }


      return [...this.sessions.values()];
    } catch (error) {
      console.warn(
        '[OOPIF] Failed to discover OOPIFs:',
        error instanceof Error ? error.message : String(error),
      );
      return [];
    }
  }

  private static readonly SESSION_ATTR = 'data-oopif-session';

  /**
   * Resolve a pending session: find the frameId and owner IFRAME element.
   * In 'tag' mode: writes sessionId to iframe element attribute.
   * In 'remap' mode: reads old tag and builds old→new sessionId mapping.
   */
  private async resolveSession(
    cdpClient: CDPClient,
    sessionId: string,
    targetInfo: Target.TargetInfo,
    mode: 'tag' | 'remap',
  ): Promise<OOPIFSession | null> {
    let frameId: string;
    try {
      const frameTree = await cdpClient.sendCommand<{
        frameTree: { frame: { id: string; url: string } };
      }>('Page.getFrameTree', {}, 5000, sessionId);
      frameId = frameTree.frameTree.frame.id;
    } catch {
      console.warn(
        `[OOPIF] Cannot get frame tree for session, skipping: ${targetInfo.url}`,
      );
      return null;
    }

    let ownerBackendNodeId: number;
    try {
      const owner = await cdpClient.sendCommand<{
        backendNodeId: number;
        nodeId?: number;
      }>('DOM.getFrameOwner', { frameId });
      ownerBackendNodeId = owner.backendNodeId;
    } catch {
      console.warn(`[OOPIF] Cannot find owner for frame ${frameId}, skipping`);
      return null;
    }

    try {
      const { object } = (await cdpClient.sendCommand('DOM.resolveNode', {
        backendNodeId: ownerBackendNodeId,
      })) as { object: { objectId: string } };

      if (mode === 'tag') {
        // First discovery: stamp the iframe with the sessionId
        await cdpClient.sendCommand('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: `function(attr, id) { this.setAttribute(attr, id); }`,
          arguments: [
            { value: OOPIFManager.SESSION_ATTR },
            { value: sessionId },
          ],
          returnByValue: true,
        });
      } else {
        // Re-discovery: read the old tag and build remap
        const readResult = await cdpClient.sendCommand<{
          result?: { value?: string };
        }>('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: `function(attr) { return this.getAttribute(attr); }`,
          arguments: [{ value: OOPIFManager.SESSION_ATTR }],
          returnByValue: true,
        });
        const oldSessionId = readResult.result?.value;
        if (oldSessionId && oldSessionId !== sessionId) {
          this.sessionIdRemap.set(oldSessionId, sessionId);
        }
      }

      await cdpClient
        .sendCommand('Runtime.releaseObject', { objectId: object.objectId })
        .catch(() => {});
    } catch {
      // Non-fatal
    }

    return {
      sessionId,
      targetInfo,
      frameId,
      frameUrl: targetInfo.url,
      ownerBackendNodeId,
    };
  }

  /**
   * Capture DOM data from all discovered OOPIF sessions in parallel.
   */
  async captureAllOOPIFTrees(): Promise<OOPIFTreeData[]> {
    if (!this.cdpClient || this.sessions.size === 0) {
      return [];
    }

    const results = await Promise.all(
      [...this.sessions.values()].map(session =>
        this.captureOOPIFTree(session).catch(error => {
          console.warn(
            `[OOPIF] Failed to capture tree for ${session.frameUrl}:`,
            error instanceof Error ? error.message : String(error),
          );
          return null;
        }),
      ),
    );

    return results.filter((r): r is OOPIFTreeData => r !== null);
  }

  /**
   * Capture DOM tree, snapshot, and AX tree from a single OOPIF session.
   */
  private async captureOOPIFTree(
    session: OOPIFSession,
  ): Promise<OOPIFTreeData> {
    const cdpClient = this.cdpClient!;
    const { sessionId } = session;

    const [snapshot, domTree, axTree] = await Promise.all([
      cdpClient.sendCommandWithRetry<DOMSnapshot.CaptureSnapshotResponse>(
        'DOMSnapshot.captureSnapshot',
        {
          computedStyles: [...REQUIRED_COMPUTED_STYLES],
          includePaintOrder: true,
          includeDOMRects: true,
          includeBlendedBackgroundColors: false,
          includeTextColorOpacities: false,
        },
        { timeout: 10000, maxRetries: 1, sessionId },
      ),
      cdpClient.sendCommand<DOM.GetDocumentResponse>(
        'DOM.getDocument',
        { depth: -1, pierce: true },
        10000,
        sessionId,
      ),
      cdpClient
        .sendCommand<Accessibility.GetFullAXTreeResponse>(
          'Accessibility.getFullAXTree',
          {},
          10000,
          sessionId,
        )
        .catch(() => ({ nodes: [] }) as Accessibility.GetFullAXTreeResponse),
    ]);

    return {
      sessionId: session.sessionId,
      frameId: session.frameId,
      frameUrl: session.frameUrl,
      ownerBackendNodeId: session.ownerBackendNodeId,
      snapshot,
      domTree,
      axTree,
    };
  }

  /**
   * Send a CDP command to a specific OOPIF session.
   * Automatically resolves stale sessionIds via the remap table.
   */
  async sendCommand<T = unknown>(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
    timeout = 10000,
  ): Promise<T> {
    if (!this.cdpClient) {
      throw new Error('[OOPIF] Manager not initialized');
    }
    const resolvedId = this.resolveSessionId(sessionId);
    return this.cdpClient.sendCommand<T>(method, params, timeout, resolvedId);
  }

  /**
   * Resolve a possibly stale sessionId to the current one.
   */
  resolveSessionId(sessionId: string): string {
    return this.sessionIdRemap.get(sessionId) ?? sessionId;
  }

  /**
   * Get a session by its sessionId.
   */
  getSession(sessionId: string): OOPIFSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all discovered sessions.
   */
  getSessions(): OOPIFSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Check if any OOPIF sessions were discovered.
   */
  hasOOPIFs(): boolean {
    return this.sessions.size > 0;
  }

  /**
   * Whether the manager has an active CDP client (not cleaned up).
   */
  isConnected(): boolean {
    return this.cdpClient !== null;
  }

  /**
   * Clean up: detach from targets.
   */
  async cleanup(): Promise<void> {
    // Detach from child targets
    if (this.cdpClient) {
      for (const [sessionId] of this.sessions) {
        try {
          await this.cdpClient.sendCommand('Target.detachFromTarget', {
            sessionId,
          });
        } catch {
          // May already be detached
        }
      }
    }

    this.sessions.clear();
    // Keep sessionIdRemap alive across cleanup — stale node references need it
    this.cdpClient = null;
  }
}
