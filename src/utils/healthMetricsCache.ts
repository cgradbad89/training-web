import { shiftDate } from "@/lib/ringMath";
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
  newEntries: HealthMetricsCacheEntry[]
): HealthMetricsCache {
  const entries = new Map(cache.entries);
  for (const entry of newEntries) entries.set(entry.date, entry);

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

  return { entries, coveredRanges };
}
