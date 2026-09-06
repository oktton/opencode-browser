/**
 * CDP (Chrome DevTools Protocol) Client
 *
 * Wraps puppeteer-core's CDPSession for easier use.
 * Provides a unified event interface compatible with the settle-monitor.
 */

import { EventEmitter } from 'events';
import type { CDPSession } from 'puppeteer-core';
import { CDPTape, type TapeMode } from './tape';
import type { CDPStats } from './stats';

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

/**
 * Register the session a Target.attachToTarget just created, so later commands
 * on it get a tape key that survives across runs (see CDPTape.noteSession).
 */
function noteAttachedSession(
  tape: CDPTape,
  method: string,
  params: Record<string, unknown> | undefined,
  result: unknown,
): void {
  if (method !== 'Target.attachToTarget') return;
  const targetId = params?.targetId;
  const sessionId = (result as { sessionId?: string } | undefined)?.sessionId;
  if (typeof targetId === 'string' && sessionId) {
    tape.noteSession(sessionId, targetId);
  }
}

export class CDPClient {
  private session: CDPSession;
  private debug: boolean;
  private eventBridge: CDPEventBridge;
  private closed = false;
  private tape: { tape: CDPTape; mode: TapeMode } | null = null;
  private stats: CDPStats | null = null;

  constructor(session: CDPSession, options: CDPClientOptions = {}) {
    this.session = session;
    this.debug = options.debug ?? process.env.CDP_DEBUG === 'true';
    this.eventBridge = new CDPEventBridge(session);
    this.eventBridge.startForwarding();
  }

  // Playwright CDPSession is always attached — no-ops for compatibility
  async attach(): Promise<void> {}
  async detach(): Promise<void> {}

  /**
   * Attach a record/replay tape. Used by the DOM regression harness only;
   * with no tape set this client behaves exactly as before.
   */
  setTape(tape: CDPTape | null, mode: TapeMode = 'replay'): void {
    this.tape = tape ? { tape, mode } : null;
  }

  /** Attach a per-method call counter. Diagnostics only; off by default. */
  setStats(stats: CDPStats | null): void {
    this.stats = stats;
  }

  async sendCommand<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeout = 10000,
    sessionId?: string,
  ): Promise<T> {
    return this.dispatch<T>(method, params, timeout, sessionId);
  }

  /**
   * Resolve the session a command must run in.
   *
   * Out-of-process iframes are attached with flatten:true, which gives each one
   * its own session; puppeteer tracks those on the connection. Commands aimed
   * at a frame have to go through its session — sending them on the page
   * session silently answers for the main frame instead, which is worse than
   * failing, so an unknown sessionId throws.
   */
  private sessionFor(sessionId: string | undefined, method: string): CDPSession {
    if (!sessionId) return this.session;
    const child = this.session.connection()?.session(sessionId);
    if (!child) {
      throw new Error(
        `[CDP] No session ${sessionId} for ${method} (frame detached?)`,
      );
    }
    return child;
  }

  private async dispatch<T>(
    method: string,
    params: Record<string, unknown> | undefined,
    timeout: number,
    sessionId: string | undefined,
  ): Promise<T> {
    const taped = this.tape;
    const tapeKey = taped ? taped.tape.key(method, params, sessionId) : '';

    // Replay never touches the socket — the session may be a stub
    if (taped?.mode === 'replay') {
      const entry = taped.tape.replay(tapeKey);
      if (!entry.ok) throw new Error(String(entry.value));
      noteAttachedSession(taped.tape, method, params, entry.value);
      return entry.value as T;
    }

    if (this.closed) {
      throw new Error('[CDP] Session is closed');
    }

    const target = this.sessionFor(sessionId, method);

    // Cleared in the finally below — the DOM pipeline fires thousands of
    // concurrent commands, and leaked timers keep their closures alive for the
    // full timeout window.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = this.stats ? performance.now() : 0;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`[CDP] Command timeout after ${timeout}ms: ${method}`));
        }, timeout);
      });

      const result = await Promise.race([
        target.send(method as any, params as any),
        timeoutPromise,
      ]);

      if (taped) {
        taped.tape.record(tapeKey, { ok: true, value: result });
        noteAttachedSession(taped.tape, method, params, result);
      }

      return result as T;
    } catch (error) {
      if (taped) {
        taped.tape.record(tapeKey, {
          ok: false,
          value: error instanceof Error ? error.message : String(error),
        });
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('timeout')) {
        throw new Error(`[CDP] Command timed out after ${timeout}ms: ${method}`);
      }
      throw new Error(`[CDP] Command failed (${method}): ${errorMessage}`);
    } finally {
      clearTimeout(timer);
      this.stats?.record(method, performance.now() - startedAt);
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
    const {
      maxRetries = 2,
      retryDelay = 1000,
      timeout = 10000,
      sessionId,
    } = options;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.sendCommand<T>(method, params, timeout, sessionId);
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
