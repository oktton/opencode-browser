/**
 * CDP Call Stats
 *
 * Counts and times CDP commands by method. Used to establish a baseline for
 * round-trip-bound work: replay hides this cost entirely (responses come from
 * memory), so it can only be measured against a live browser.
 *
 * Commands are issued concurrently, so the summed latency exceeds the wall
 * clock of the stage that issued them — read it as "time spent waiting on this
 * method", not as elapsed time.
 */

export interface CDPStatRow {
  method: string;
  count: number;
  ms: number;
}

export class CDPStats {
  private byMethod = new Map<string, { count: number; ms: number }>();

  record(method: string, ms: number): void {
    const entry = this.byMethod.get(method);
    if (entry) {
      entry.count++;
      entry.ms += ms;
    } else {
      this.byMethod.set(method, { count: 1, ms });
    }
  }

  reset(): void {
    this.byMethod.clear();
  }

  get totalCalls(): number {
    let n = 0;
    for (const entry of this.byMethod.values()) n += entry.count;
    return n;
  }

  get totalMs(): number {
    let n = 0;
    for (const entry of this.byMethod.values()) n += entry.ms;
    return n;
  }

  /** Rows sorted by time spent, descending. */
  rows(): CDPStatRow[] {
    return [...this.byMethod]
      .map(([method, e]) => ({ method, count: e.count, ms: e.ms }))
      .sort((a, b) => b.ms - a.ms);
  }
}
