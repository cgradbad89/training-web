import { eachDate, shiftDate } from "@/lib/ringMath";
import type { HealthMetric as HealthMetricsDoc } from "@/services/healthMetrics";

export interface HealthMetricsCacheEntry {
  date: string;
  metrics: HealthMetricsDoc;
}

export interface CoveredRange {
  start: string;
  end: string;
}

export interface HealthMetricsCache {
  entries: Map<string, HealthMetricsCacheEntry>;
  coveredRanges: CoveredRange[];
  /** Failure never erases a previous successful coverage timestamp. */
  coverage: Map<string, { lastSuccessAt: number | null; error: string | null }>;
}

export const HEALTH_METRICS_ROLLING_DAYS = 90;
export const HEALTH_DATE_NAVIGATION_DAYS = 30;
export const HEALTH_METRICS_FRESHNESS_MS = 30000;

export function emptyHealthMetricsCache(): HealthMetricsCache {
  return { entries: new Map(), coveredRanges: [], coverage: new Map() };
}

export function healthRollingRange(today: string): CoveredRange {
  return { start: shiftDate(today, -HEALTH_METRICS_ROLLING_DAYS), end: today };
}

/** Rolling + YTD, including the earliest year reachable by the day navigator. */
export function healthRetentionRange(today: string): CoveredRange {
  const earliestAnchor = shiftDate(today, -HEALTH_DATE_NAVIGATION_DAYS);
  return {
    start: [healthRollingRange(today).start, `${earliestAnchor.slice(0, 4)}-01-01`].sort()[0],
    end: today,
  };
}

export function intersectRanges(a: CoveredRange, b: CoveredRange): CoveredRange | null {
  const start = a.start > b.start ? a.start : b.start;
  const end = a.end < b.end ? a.end : b.end;
  return start <= end ? { start, end } : null;
}

export function metricsInCacheRange(
  cache: HealthMetricsCache | null,
  range: CoveredRange
): HealthMetricsDoc[] {
  return [...(cache?.entries.values() ?? [])]
    .filter(entry => entry.date >= range.start && entry.date <= range.end)
    .map(entry => entry.metrics)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Empty means successful coverage without a dated row, never an unloaded date. */
export function healthDateStatus(cache: HealthMetricsCache, date: string, now: number) {
  const coverage = cache.coverage.get(date);
  if (coverage?.error) return "error";
  if (coverage?.lastSuccessAt == null) return "never-requested";
  if (now - coverage.lastSuccessAt >= HEALTH_METRICS_FRESHNESS_MS) return "stale";
  return cache.entries.has(date) ? "covered" : "covered-empty";
}

export function getMissingOrStaleRanges(
  cache: HealthMetricsCache,
  requested: CoveredRange,
  now: number
): CoveredRange[] {
  const ranges: CoveredRange[] = [];
  for (const date of eachDate(requested.start, requested.end)) {
    const status = healthDateStatus(cache, date, now);
    if (status === "covered" || status === "covered-empty") continue;
    const previous = ranges.at(-1);
    if (previous && shiftDate(previous.end, 1) === date) previous.end = date;
    else ranges.push({ start: date, end: date });
  }
  return ranges;
}

export function recordRangeFailure(
  cache: HealthMetricsCache,
  range: CoveredRange,
  error: string
): HealthMetricsCache {
  const coverage = new Map(cache.coverage);
  for (const date of eachDate(range.start, range.end)) {
    coverage.set(date, { lastSuccessAt: coverage.get(date)?.lastSuccessAt ?? null, error });
  }
  return { ...cache, coverage };
}

export function retainHealthRange(cache: HealthMetricsCache, range: CoveredRange): HealthMetricsCache {
  return {
    entries: new Map([...cache.entries].filter(([date]) => date >= range.start && date <= range.end)),
    coverage: new Map([...cache.coverage].filter(([date]) => date >= range.start && date <= range.end)),
    coveredRanges: cache.coveredRanges.flatMap(covered => {
      const intersection = intersectRanges(covered, range);
      return intersection ? [intersection] : [];
    }),
  };
}

export function getUncoveredGaps(
  cache: HealthMetricsCache,
  requested: CoveredRange
): CoveredRange[] {
  if (requested.start > requested.end) return [];

  const gaps: CoveredRange[] = [];
  let cursor = requested.start;

  for (const range of cache.coveredRanges) {
    if (range.end < cursor) continue;
    if (range.start > requested.end) break;

    if (range.start > cursor) {
      gaps.push({
        start: cursor,
        end: shiftDate(range.start, -1),
      });
    }

    if (range.end >= requested.end) return gaps;
    cursor = shiftDate(range.end, 1);
  }

  if (cursor <= requested.end) {
    gaps.push({ start: cursor, end: requested.end });
  }
  return gaps;
}

export function mergeCoveredRange(
  cache: HealthMetricsCache,
  newRange: CoveredRange,
  newEntries: HealthMetricsCacheEntry[],
  completedAt = Date.now()
): HealthMetricsCache {
  if (newRange.start > newRange.end) return cache;
  const entries = new Map(cache.entries);
  // A range response is authoritative, including omissions/deletions.
  for (const date of entries.keys()) {
    if (date >= newRange.start && date <= newRange.end) entries.delete(date);
  }
  for (const entry of newEntries) {
    if (entry.date >= newRange.start && entry.date <= newRange.end) entries.set(entry.date, entry);
  }
  const coverage = new Map(cache.coverage);
  for (const date of eachDate(newRange.start, newRange.end)) {
    coverage.set(date, { lastSuccessAt: completedAt, error: null });
  }

  const sorted = [...cache.coveredRanges, newRange]
    .filter((range) => range.start <= range.end)
    .sort((a, b) => a.start.localeCompare(b.start));
  const coveredRanges: CoveredRange[] = [];

  for (const range of sorted) {
    const previous = coveredRanges[coveredRanges.length - 1];
    if (!previous || range.start > shiftDate(previous.end, 1)) {
      coveredRanges.push({ ...range });
      continue;
    }
    if (range.end > previous.end) previous.end = range.end;
  }

  return { entries, coveredRanges, coverage };
}
