import type { Cache } from "./cache.ts";
import type { LoadedConfig, SourceConnection } from "./config.ts";
import { type Adapters, fetchSource, realAdapters, refreshWindow } from "./sources.ts";

export interface RefresherOptions {
  adapters?: Adapters;
  /** Override the clock for tests. */
  now?: () => number;
  /** Cap on backoff delay. */
  maxBackoffMs?: number;
  log?: (msg: string) => void;
}

interface SourceState {
  timer: ReturnType<typeof setTimeout> | null;
  consecutiveFailures: number;
}

/**
 * Per-source periodic refresh. Each source schedules its own next run; a
 * success reschedules at the base interval, a failure backs off exponentially
 * (base * 2^failures) capped at maxBackoffMs.
 */
export class Refresher {
  private readonly adapters: Adapters;
  private readonly now: () => number;
  private readonly maxBackoffMs: number;
  private readonly log: (msg: string) => void;
  private readonly states = new Map<string, SourceState>();
  private config: LoadedConfig;
  private stopped = false;

  constructor(
    private readonly cache: Cache,
    config: LoadedConfig,
    options: RefresherOptions = {},
  ) {
    this.config = config;
    this.adapters = options.adapters ?? realAdapters;
    this.now = options.now ?? Date.now;
    this.maxBackoffMs = options.maxBackoffMs ?? 6 * 60 * 60 * 1000;
    this.log = options.log ?? (() => {});
  }

  /** Replace config on hot reload; existing schedules keep running. */
  setConfig(config: LoadedConfig): void {
    this.config = config;
  }

  private get baseIntervalMs(): number {
    return this.config.settings.refreshIntervalMinutes * 60 * 1000;
  }

  /** Refresh every source once now, then schedule recurring runs. */
  async start(): Promise<void> {
    this.stopped = false;
    await Promise.all(this.config.connections.map((c) => this.runAndSchedule(c)));
  }

  stop(): void {
    this.stopped = true;
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    }
  }

  /** Refresh a single source immediately (used by start and manual triggers). */
  async refreshOnce(connection: SourceConnection): Promise<void> {
    const window = refreshWindow(new Date(this.now()));
    try {
      const events = await fetchSource(
        connection,
        window,
        this.config.personIdForSource,
        this.adapters,
      );
      this.cache.replaceSourceEvents(connection.sourceId, events, this.now());
      this.cache.markSuccess(connection.sourceId, this.now());
      this.stateFor(connection.sourceId).consecutiveFailures = 0;
      this.log(`refresh ok: ${connection.sourceId} (${events.length} events)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.cache.markError(connection.sourceId, message, this.now());
      this.stateFor(connection.sourceId).consecutiveFailures += 1;
      this.log(`refresh failed: ${connection.sourceId}: ${message}`);
      throw err;
    }
  }

  private async runAndSchedule(connection: SourceConnection): Promise<void> {
    if (this.stopped) return;
    let failed = false;
    try {
      await this.refreshOnce(connection);
    } catch {
      failed = true;
    }
    this.schedule(connection, failed);
  }

  private schedule(connection: SourceConnection, failed: boolean): void {
    if (this.stopped) return;
    const state = this.stateFor(connection.sourceId);
    const delay = failed
      ? Math.min(this.baseIntervalMs * 2 ** state.consecutiveFailures, this.maxBackoffMs)
      : this.baseIntervalMs;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void this.runAndSchedule(connection);
    }, delay);
    // Don't keep the process alive solely for the timer.
    (state.timer as { unref?: () => void }).unref?.();
  }

  private stateFor(sourceId: string): SourceState {
    let s = this.states.get(sourceId);
    if (!s) {
      s = { timer: null, consecutiveFailures: 0 };
      this.states.set(sourceId, s);
    }
    return s;
  }

  /** Source ids past max_stale_hours since last success. */
  staleSources(): string[] {
    const maxStaleMs = this.config.settings.maxStaleHours * 60 * 60 * 1000;
    const now = this.now();
    const statuses = new Map(this.cache.sourceStatuses().map((s) => [s.id, s]));
    const stale: string[] = [];
    for (const conn of this.config.connections) {
      const status = statuses.get(conn.sourceId);
      if (!status || status.lastSuccessAt === null) {
        stale.push(conn.sourceId);
        continue;
      }
      if (now - status.lastSuccessAt > maxStaleMs) stale.push(conn.sourceId);
    }
    return stale;
  }
}
