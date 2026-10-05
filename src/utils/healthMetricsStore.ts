import type { HealthMetric } from "@/services/healthMetrics";
import { toLocalIsoDate } from "@/utils/dates";
import {
  emptyHealthMetricsCache,
  getMissingOrStaleRanges,
  getUncoveredGaps,
  healthRetentionRange,
  healthRollingRange,
  intersectRanges,
  mergeCoveredRange,
  recordRangeFailure,
  retainHealthRange,
  type CoveredRange,
  type HealthMetricsCache,
} from "./healthMetricsCache";

export interface HealthMetricsSnapshot {
  /** Null until first Health use: training-only sessions allocate no metric cache. */
  cache: HealthMetricsCache | null;
  hasLoadedRolling: boolean;
  pendingRanges: CoveredRange[];
  error: string | null;
}

type RangeLoader = (uid: string, start: string, end: string) => Promise<HealthMetric[]>;
interface PendingRange { range: CoveredRange; promise: Promise<void> }

/** Health-only bounded coordinator. No listeners, timers or reads on creation. */
export class HealthMetricsStore {
  private snapshot: HealthMetricsSnapshot = { cache: null, hasLoadedRolling: false, pendingRanges: [], error: null };
  private listeners = new Set<() => void>();
  private pending = new Set<PendingRange>();
  private generation = 0;
  private alive = true;
  private active = false;

  constructor(
    private uid: string,
    private loadRange: RangeLoader,
    private sessionCurrent: () => boolean
  ) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Layout ownership setup also restores a retired Strict Mode generation. */
  activate(active: boolean) { this.alive = true; this.active = active; }
  setActive(active: boolean) { this.active = active; }

  retire() {
    this.alive = false;
    this.active = false;
    this.generation++;
    this.pending.clear();
    this.snapshot = { cache: null, hasLoadedRolling: false, pendingRanges: [], error: null };
    this.publish();
  }

  private current(generation: number) {
    return this.alive && this.generation === generation && this.sessionCurrent();
  }
  private publish() { for (const listener of this.listeners) listener(); }
  private update(cache: HealthMetricsCache) {
    // A midnight while a request was pending does not extend its coverage.
    const bounded = retainHealthRange(cache, healthRetentionRange(toLocalIsoDate(new Date())));
    this.snapshot = {
      cache: bounded,
      hasLoadedRolling: this.snapshot.hasLoadedRolling || getUncoveredGaps(bounded, healthRollingRange(toLocalIsoDate(new Date()))).length === 0,
      pendingRanges: [...this.pending].map(request => request.range),
      error: [...bounded.coverage.values()].find(value => value.error)?.error ?? null,
    };
    this.publish();
  }

  /**
   * Join the intersection with existing work and query only disjoint gaps.
   * Never widen a query into an expensive superset. Concurrent responses cannot
   * overwrite each other because their authoritative intervals do not overlap.
   */
  ensureRange = (requested: CoveredRange, force = false): Promise<void> => {
    const generation = this.generation;
    if (!this.active || !this.current(generation)) return Promise.resolve();
    const bounds = healthRetentionRange(toLocalIsoDate(new Date()));
    const range = intersectRanges(requested, bounds);
    if (!range) return Promise.resolve();
    const cache = retainHealthRange(this.snapshot.cache ?? emptyHealthMetricsCache(), bounds);
    const needed = force ? [range] : getMissingOrStaleRanges(cache, range, Date.now());
    const waiting = new Set<Promise<void>>();
    const pendingRanges = [...this.pending].map(request => request.range)
      .sort((a, b) => a.start.localeCompare(b.start));
    for (const gap of needed) {
      for (const request of this.pending) {
        if (intersectRanges(gap, request.range)) waiting.add(request.promise);
      }
      // Coverage subtraction is also useful for in-flight reservations. Only
      // the actual response can establish successful/empty coverage.
      const reservations = { ...cache, coveredRanges: pendingRanges };
      for (const missing of getUncoveredGaps(reservations, gap)) {
        const request = this.startRange(missing, generation);
        waiting.add(request.promise);
      }
    }
    this.update(this.snapshot.cache ?? cache);
    if (waiting.size === 1) return [...waiting][0];
    return Promise.all(waiting).then(() => undefined);
  };

  private startRange(range: CoveredRange, generation: number): PendingRange {
    const request = { range, promise: null as unknown as Promise<void> };
    request.promise = (async () => {
      try {
        const docs = await Promise.resolve().then(() =>
          this.active && this.current(generation)
            ? this.loadRange(this.uid, range.start, range.end)
            : null
        );
        if (!docs) return;
        if (!this.current(generation)) return;
        this.update(mergeCoveredRange(
          this.snapshot.cache ?? emptyHealthMetricsCache(), range,
          docs.map(metrics => ({ date: metrics.date, metrics }))
        ));
      } catch (error) {
        if (!this.current(generation)) return;
        const message = error instanceof Error ? error.message : String(error);
        this.update(recordRangeFailure(this.snapshot.cache ?? emptyHealthMetricsCache(), range, message));
        console.error("[health metrics range]", error);
      } finally {
        // Retired results cannot remove a replay/replacement request or metadata.
        if (this.current(generation) && this.pending.delete(request)) {
          this.update(this.snapshot.cache ?? emptyHealthMetricsCache());
        }
      }
    })();
    this.pending.add(request);
    return request;
  }
}
