/**
 * CDP Tape
 *
 * Records every CDP request/response pair during a live extraction, then
 * replays them offline so the DOM pipeline runs deterministically without a
 * browser. Used by the DOM regression harness (script/dom-regression.ts) to
 * prove that refactors do not change the extracted DOM.
 *
 * Entries are keyed by (sessionId, method, params) rather than by call order,
 * because the pipeline issues most CDP commands concurrently and the
 * completion order is not stable between runs.
 */

import * as fs from 'fs';
import * as zlib from 'zlib';

export type TapeMode = 'record' | 'replay';

export interface TapeResult {
  ok: boolean;
  /** Response payload when ok, error message otherwise */
  value: unknown;
}

interface TapeFile {
  version: 1;
  url: string;
  capturedAt: string;
  entries: [string, TapeResult[]][];
}

/** Stable stringify: object keys sorted so the same params always hash alike. */
function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

export class CDPTapeMiss extends Error {
  constructor(public readonly key: string) {
    super(`[CDPTape] no recorded response for ${key}`);
  }
}

export class CDPTape {
  private data = new Map<string, TapeResult[]>();
  private cursor = new Map<string, number>();
  private missed: string[] = [];
  /** sessionId → targetId, rebuilt from Target.attachToTarget on every run */
  private sessionAlias = new Map<string, string>();
  url = '';
  capturedAt = '';

  /**
   * Chrome hands out a fresh sessionId every time a target is attached, so a
   * raw sessionId in the key would make the tape usable by exactly the run that
   * produced it. Keys use the target the session belongs to instead, which is
   * stable for as long as the page is loaded.
   */
  noteSession(sessionId: string, targetId: string): void {
    this.sessionAlias.set(sessionId, targetId);
  }

  key(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): string {
    const scope = sessionId
      ? (this.sessionAlias.get(sessionId) ?? sessionId)
      : '';
    return `${scope}|${method}|${stable(params)}`;
  }

  record(key: string, result: TapeResult): void {
    const list = this.data.get(key);
    if (list) list.push(result);
    else this.data.set(key, [result]);
  }

  /**
   * Return the next recorded response for a key. Repeated calls past the end of
   * the recorded list reuse the last response — CDP reads here are idempotent,
   * and concurrency can change how often a given key is hit.
   */
  replay(key: string): TapeResult {
    const list = this.data.get(key);
    if (!list || list.length === 0) {
      this.missed.push(key);
      throw new CDPTapeMiss(key);
    }
    const at = this.cursor.get(key) ?? 0;
    this.cursor.set(key, at + 1);
    return list[Math.min(at, list.length - 1)]!;
  }

  /** Keys that were requested during replay but never recorded. */
  misses(): string[] {
    return this.missed;
  }

  /** Rewind so the tape can be replayed again from the start. */
  reset(): void {
    this.cursor.clear();
    this.missed = [];
    this.sessionAlias.clear();
  }

  /**
   * Rewrite every recorded response for one CDP method in place.
   *
   * Used by ablation experiments: strip a field out of a recorded payload to
   * see what the pipeline would produce had the browser never sent it.
   */
  mapResults(
    method: string,
    fn: (value: unknown, key: string) => unknown,
  ): void {
    const marker = `|${method}|`;
    for (const [key, results] of this.data) {
      if (!key.includes(marker)) continue;
      for (const entry of results) {
        if (entry.ok) entry.value = fn(entry.value, key);
      }
    }
  }

  get size(): number {
    return this.data.size;
  }

  save(filepath: string): void {
    const file: TapeFile = {
      version: 1,
      url: this.url,
      capturedAt: this.capturedAt,
      entries: [...this.data.entries()],
    };
    fs.writeFileSync(filepath, zlib.gzipSync(JSON.stringify(file)));
  }

  static load(filepath: string): CDPTape {
    const file = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(filepath)).toString('utf8'),
    ) as TapeFile;
    const tape = new CDPTape();
    tape.url = file.url;
    tape.capturedAt = file.capturedAt;
    for (const [key, results] of file.entries) tape.data.set(key, results);
    return tape;
  }
}
