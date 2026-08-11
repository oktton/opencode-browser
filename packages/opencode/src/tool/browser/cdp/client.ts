/**
 * CDP (Chrome DevTools Protocol) Client
 *
 * Wraps puppeteer-core's CDPSession for easier use.
 * Provides a unified event interface compatible with the settle-monitor.
 */

import { EventEmitter } from 'events';
import type { CDPSession } from 'puppeteer-core';

export interface CDPClientOptions {
  debug?: boolean;
}

// CDP events we need to listen to for settle-monitor and OOPIF tracking
const CDP_EVENTS_TO_FORWARD = [
  'Network.requestWillBeSent',
  'Network.loadingFinished',
  'Network.loadingFailed',
  'Network.responseReceived',
  'DOM.childNodeInserted',
  'DOM.childNodeRemoved',
  'DOM.childNodeCountUpdated',
  'DOM.attributeModified',
  'DOM.attributeRemoved',
  'DOM.characterDataModified',
  'Target.attachedToTarget',
];

/**
 * Adapter that converts Playwright CDPSession per-method events
 * into Electron-style unified 'message' events.
 * Used by PageSettleMonitor which expects `on('message', (event, method, params) => ...)`.
 */
class CDPEventBridge extends EventEmitter {
  private session: CDPSession;
  private handlers = new Map<string, (params: any) => void>();

  constructor(session: CDPSession) {
    super();
    this.session = session;
  }

  startForwarding(): void {
    for (const method of CDP_EVENTS_TO_FORWARD) {
      const handler = (params: any) => {
        this.emit('message', null, method, params ?? {});
      };
      this.handlers.set(method, handler);
      this.session.on(method as any, handler);
    }
  }

  stopForwarding(): void {
    for (const [method, handler] of this.handlers) {
      this.session.off(method as any, handler);
    }
    this.handlers.clear();
  }
}

export class CDPClient {
  private session: CDPSession;
  private debug: boolean;
  private eventBridge: CDPEventBridge;
  private closed = false;

  constructor(session: CDPSession, options: CDPClientOptions = {}) {
    this.session = session;
    this.debug = options.debug ?? process.env.CDP_DEBUG === 'true';
    this.eventBridge = new CDPEventBridge(session);
    this.eventBridge.startForwarding();
  }

  // Playwright CDPSession is always attached — no-ops for compatibility
  async attach(): Promise<void> {}
  async detach(): Promise<void> {}

  async sendCommand<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeout = 10000,
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) {
      throw new Error('[CDP] Session is closed');
    }

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`[CDP] Command timeout after ${timeout}ms: ${method}`));
        }, timeout);
      });

      const result = await Promise.race([
        this.session.send(method as any, params as any),
        timeoutPromise,
      ]);

      return result as T;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('timeout')) {
        throw new Error(`[CDP] Command timed out after ${timeout}ms: ${method}`);
      }
      throw new Error(`[CDP] Command failed (${method}): ${errorMessage}`);
    }
  }

  async sendCommandWithRetry<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options: {
      maxRetries?: number;
      retryDelay?: number;
      timeout?: number;
      sessionId?: string;
    } = {},
  ): Promise<T> {
    const { maxRetries = 2, retryDelay = 1000, timeout = 10000 } = options;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.sendCommand<T>(method, params, timeout);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError.message.includes('closed')) throw lastError;
        if (attempt === maxRetries) break;
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }

    throw lastError || new Error('[CDP] Command failed after all retries');
  }

  isDebuggerAttached(): boolean {
    return !this.closed;
  }

  /**
   * Returns the event bridge that emits unified 'message' events.
   * Compatible with settle-monitor's CdpDebugger interface.
   */
  getDebugger(): CDPEventBridge {
    return this.eventBridge;
  }

  getSession(): CDPSession {
    return this.session;
  }

  async cleanup(): Promise<void> {
    this.eventBridge.stopForwarding();
    this.closed = true;
    await this.session.detach().catch(() => {});
  }
}
