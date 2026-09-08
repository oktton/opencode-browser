// ---------------------------------------------------------------------------
// Network/DOM settle-detection constants
// ---------------------------------------------------------------------------

export const DOM_MUTATION_EVENTS = new Set([
  'DOM.childNodeInserted',
  'DOM.childNodeRemoved',
  'DOM.childNodeCountUpdated',
  'DOM.attributeModified',
  'DOM.attributeRemoved',
  'DOM.characterDataModified',
]);

// Ad/tracking domains and URL patterns to ignore
const IGNORED_URL_KEYWORDS = [
  // Google ad/tracking
  'doubleclick.net',
  'googlesyndication.com',
  'googletagmanager.com',
  'google-analytics.com',
  'googleadservices.com',
  // Ad-tech identity sync / cookie matching
  'undertone.com',
  'mrtnsvr.com',
  'loopme.me',
  'pubmatic.com',
  'unrulymedia.com',
  // Facebook
  'facebook.net',
  'fbcdn.net',
  // Adobe analytics
  'demdex.net',
  'omtrdc.net',
  'adobedtm.com',
  'ensighten.com',
  // Error/performance monitoring
  'sentry.io',
  'newrelic.com',
  'nr-data.net',
  // Analytics/tracking platforms
  'hotjar',
  'clarity.ms',
  'mixpanel',
  'segment.io',
  // Social media trackers
  'platform.twitter.com',
  'platform.linkedin.com',
  'pinimg.com',
  'pinterest.com',
  'sc-static.net',
  // Analytics/monitoring
  'quantummetric.com',
  'dynatrace.com',
  'go-mpulse.net',
  'optimizely.com',
  'brcdn.com',
  // Ad/retargeting
  'criteo.com',
  'id5-sync.com',
  'creativecdn.com',
  'attn.tv',
  'wandzcdn.com',
  'wandzapi.com',
  // Third-party widgets (chat, cookie consent)
  'talkdeskapp.com',
  'talkdeskchatsdk',
  'cookielaw.org',
  // CDN image paths
  '.cloudfront.net/image/',
  '.akamaized.net/image/',
  // Generic keywords
  'analytics',
  'tracking',
  'pixel',
  'adservice',
  'ads',
  // Common tracking URL paths
  '/tracker/',
  '/collector/',
  '/beacon/',
  '/telemetry/',
  '/log/',
  '/events/',
  '/eventBatch',
  '/track.',
  '/metrics/',
  '/sync',
  '/csync',
  'usersync',
  'pixel/sync',
];

export const NON_CRITICAL_RESOURCE_TYPES = new Set([
  'Image',
  'Media',
  'Font',
  'Preflight',
  'Ping',
  'CSPViolationReport',
  'Prefetch',
]);

export const STUCK_REQUEST_MS = 10000;
export const NON_CRITICAL_MAX_MS = 3000;
/** Single remaining inflight: if it's been pending this long alone, stop blocking settle. */
export const LONE_REQUEST_MAX_MS = 5000;
export const IMAGE_URL_RE = /\.(jpg|jpeg|png|gif|webp|svg|ico)(\?|$)/i;

export function isIgnoredUrl(url: string): boolean {
  if (!url || url.length > 500) return true;
  const lower = url.toLowerCase();
  // Only real network traffic says anything about whether the page is still
  // loading. Everything else here is machinery: an extension that blocks a
  // request makes Chrome report it as chrome-extension://invalid/, so a page
  // whose telemetry is being blocked looks perpetually busy — enough of them
  // and the quiet window never elapses.
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return true;
  return IGNORED_URL_KEYWORDS.some(kw => lower.includes(kw));
}

// ---------------------------------------------------------------------------
// PageSettleMonitor
// ---------------------------------------------------------------------------

type InflightRequest = { url: string; type: string; startTime: number };

// Duck-typed to avoid hard electron import dependency
type CdpDebugger = {
  on(event: 'message', listener: (...args: any[]) => void): void;
  off(event: 'message', listener: (...args: any[]) => void): void;
};

export interface PageSettleMonitorOptions {
  quietWindow?: number;
  /** Already-known OOPIF session IDs — Network/DOM will be enabled on them immediately. */
  oopifSessionIds?: string[];
  /** Called to enable Network + DOM events on a session (initial and newly attached OOPIFs). */
  enableOOPIFSession?: (sessionId: string) => Promise<void>;
}

/**
 * Background page settle monitor.
 *
 * Listens to CDP Network/DOM events and maintains dirty/clean state via a
 * single quiet window shared by both network and DOM activity.
 *
 * - Starts dirty and begins settling immediately on construction.
 * - Any network request or DOM mutation resets the quiet timer.
 * - Once the quiet window passes with no critical inflight requests, transitions to clean.
 * - OOPIF: enables events on known sessions at start; handles Target.attachedToTarget
 *   to catch dynamically attached cross-origin iframes.
 *
 * Caller enables Network/DOM on the main frame before constructing.
 * CDP cleanup (detach) is handled externally — no disable needed in stop().
 */
export class PageSettleMonitor {
  private dirty = true;
  private inflightRequests = new Map<string, InflightRequest>();
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanWaiters: Array<() => void> = [];
  private readonly onMessageBound: (...args: any[]) => void;
  private readonly quietWindow: number;
  private readonly enableOOPIFSession?: (sessionId: string) => Promise<void>;
  /** Depth of suspend() calls; DOM mutations are ignored while above zero */
  private suspended = 0;

  constructor(
    private readonly debugger_: CdpDebugger,
    options: PageSettleMonitorOptions = {},
  ) {
    this.quietWindow = options.quietWindow ?? 1000;
    this.enableOOPIFSession = options.enableOOPIFSession;

    this.onMessageBound = this.onMessage.bind(this);
    this.debugger_.on('message', this.onMessageBound);

    for (const sessionId of options.oopifSessionIds ?? []) {
      this.enableOOPIFSession?.(sessionId).catch(() => {});
    }

    this.resetTimer();
  }

  isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Ignore DOM mutations until the matching resume().
   *
   * Highlighting marks every indexed element and injects an overlay of its
   * own, then clears both on the next run — hundreds of mutations that are the
   * extraction, not the page. Counted as activity they made the tool guarantee
   * the page was dirty whenever it next looked, so every extraction after the
   * first paid a full quiet window for its own overlay.
   *
   * Network activity still counts: suspending is about our writes, and we make
   * no requests.
   */
  suspend(): void {
    this.suspended++;
  }

  resume(): void {
    if (this.suspended > 0) this.suspended--;
  }

  /** Explicitly mark dirty — use for tools that don't emit CDP events (e.g. scroll). */
  markDirty(): void {
    this.dirty = true;
    this.resetTimer();
  }

  /**
   * Resolves when clean or after timeoutMs, whichever comes first.
   * Returns immediately if already clean.
   */
  async waitForSettle(timeoutMs: number): Promise<void> {
    if (!this.dirty) {
      // already clean
      return;
    }
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        resolve();
      }, timeoutMs);
      this.cleanWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  stop(): void {
    this.debugger_.off('message', this.onMessageBound);
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.cleanWaiters = [];
  }

  private onMessage(
    _event: unknown,
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method === 'Target.attachedToTarget') {
      if ((params as any).targetInfo?.type === 'iframe') {
        const sessionId = (params as any).sessionId as string;
        const url = (params as any).targetInfo?.url ?? '';
        this.enableOOPIFSession?.(sessionId).catch(() => {});
        this.resetTimer();
      }
      return;
    }

    if (DOM_MUTATION_EVENTS.has(method)) {
      if (this.suspended > 0) return;
      this.dirty = true;
      this.resetTimer();
      return;
    }

    if (method === 'Network.requestWillBeSent') {
      const url = (params as any).request?.url ?? '';
      const type = (params as any).type ?? '';
      const requestId = (params as any).requestId as string;
      if (!isIgnoredUrl(url) && !NON_CRITICAL_RESOURCE_TYPES.has(type)) {
        this.inflightRequests.set(requestId, {
          url,
          type,
          startTime: Date.now(),
        });
        this.dirty = true;
        // console.log(`[settle] +inflight [${type}] ${url.slice(0, 80)} (total=${this.inflightRequests.size})`);
        this.resetTimer();
      }
    } else if (
      method === 'Network.loadingFinished' ||
      method === 'Network.loadingFailed'
    ) {
      this.inflightRequests.delete((params as any).requestId as string);
    } else if (method === 'Network.responseReceived') {
      const requestId = (params as any).requestId as string;
      const type = (params as any).type ?? '';
      const req = this.inflightRequests.get(requestId);
      if (req) {
        req.type = type;
        if (NON_CRITICAL_RESOURCE_TYPES.has(type)) {
          this.inflightRequests.delete(requestId);
        }
      }
    }
  }

  private hasCriticalInflight(): boolean {
    const now = Date.now();
    const remaining: [string, InflightRequest][] = [];
    for (const [reqId, req] of this.inflightRequests) {
      const age = now - req.startTime;
      if (age > STUCK_REQUEST_MS) {
        this.inflightRequests.delete(reqId);
        continue;
      }
      if (
        NON_CRITICAL_RESOURCE_TYPES.has(req.type) &&
        age > NON_CRITICAL_MAX_MS
      ) {
        this.inflightRequests.delete(reqId);
        continue;
      }
      if (IMAGE_URL_RE.test(req.url) && age > NON_CRITICAL_MAX_MS) {
        this.inflightRequests.delete(reqId);
        continue;
      }
      remaining.push([reqId, req]);
    }
    // Once every request still open has been open a while, none of them is the
    // page loading: real content arrives in bursts, so a burst would still have
    // a young member. What is left is polling, telemetry and third-party frames
    // that never resolve — a tracker iframe and two metrics beacons are enough
    // to hold a page "busy" indefinitely.
    //
    // There used to be a cap of three such requests, which only decided how
    // many of them it took to stall settling entirely; the age test already
    // carries the argument.
    const allStale = remaining.every(
      ([, req]) => now - req.startTime > LONE_REQUEST_MAX_MS,
    );
    if (allStale) {
      for (const [reqId] of remaining) {
        this.inflightRequests.delete(reqId);
      }
      return false;
    }
    return remaining.length > 0;
  }

  private resetTimer(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.onQuiet(), this.quietWindow);
  }

  private onQuiet(): void {
    this.quietTimer = null;
    if (this.hasCriticalInflight()) {
      this.resetTimer();
      return;
    }
    // console.log(`[settle] quiet → clean, notifying ${this.cleanWaiters.length} waiter(s)`);
    this.dirty = false;
    const waiters = this.cleanWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
