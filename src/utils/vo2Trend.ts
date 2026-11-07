/**
 * Phase 3L — descriptive VO₂ max trend (Apple Health device estimate).
 *
 * DESCRIPTIVE ONLY. These are Apple Watch estimates in ml·kg⁻¹·min⁻¹, not
 * laboratory measurements, and nothing here is converted to a race time, split
 * across individual runs, or fed to any predictor.
 *
 * Rules (each covered by tests):
 *  - No future leakage: a point's median uses only readings dated ≤ that point;
 *    `asOf` drops later readings entirely.
 *  - No invented readings and no extrapolation: a point's median is null when
 *    fewer than VO2_TREND_MIN_READINGS readings fall in its trailing window.
 *  - Extended gaps are surfaced (`gapBefore`), never bridged by a value.
 *  - Steps ≥ VO2_DISCONTINUITY_ML between consecutive readings are flagged — the
 *    cause (device/model change, wrist-fit, gap) is unknown, so they are only marked.
 *  - Duplicate dates collapse to their median; non-finite, non-positive or
 *    physiologically implausible values (outside 10–100) are excluded and counted.
 *
 * Evidence for the 28-day window (2026-09-22 export, last 12 months, 124 readings):
 * coverage 98 % at ≥3 readings; successive-difference SD 0.49 raw → 0.46 median —
 * a modest smoothing, so the median is an honest summary, not a noise filter. The
 * Theil–Sen slope changed sign across 60/90/120-day windows (−2.0/−1.0/+0.03 per
 * 28 d), so no slope is shown to users; `theilSenSlopePer28d` is research-only.
 */
import type { Vo2Entry } from "@/utils/vo2History";

export const VO2_TREND_WINDOW_DAYS = 28;
export const VO2_TREND_MIN_READINGS = 3;
export const VO2_EXTENDED_GAP_DAYS = 21;
export const VO2_DISCONTINUITY_ML = 2.0;
export const VO2_STALE_DAYS = 30;
export const VO2_PLAUSIBLE_RANGE = { min: 10, max: 100 } as const;

export interface Vo2TrendPoint {
  date: string;
  value: number;
  /** Median of readings in the trailing window ending on `date`; null if too few. */
  median28: number | null;
  readingsInWindow: number;
  /** True when this reading follows a gap longer than VO2_EXTENDED_GAP_DAYS. */
  gapBefore: boolean;
  /** True when |value − previous reading| ≥ VO2_DISCONTINUITY_ML. */
  discontinuity: boolean;
}

export interface Vo2TrendSeries {
  points: Vo2TrendPoint[];
  excluded: { invalid: number; afterAsOf: number; duplicateDatesMerged: number };
}

const DAY_MS = 86_400_000;

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** Strict calendar date: rejects roll-overs such as 2026-13-40 by round-tripping. */
function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function buildVo2TrendSeries(
  entries: readonly Vo2Entry[],
  options: { asOf?: string } = {}
): Vo2TrendSeries {
  const excluded = { invalid: 0, afterAsOf: 0, duplicateDatesMerged: 0 };
  const byDate = new Map<string, number[]>();
  for (const entry of entries) {
    if (
      !isIsoDate(entry?.date) || typeof entry.value !== "number" || !Number.isFinite(entry.value) ||
      entry.value < VO2_PLAUSIBLE_RANGE.min || entry.value > VO2_PLAUSIBLE_RANGE.max
    ) { excluded.invalid += 1; continue; }
    if (options.asOf !== undefined && entry.date > options.asOf) { excluded.afterAsOf += 1; continue; }
    const list = byDate.get(entry.date) ?? [];
    if (list.length > 0) excluded.duplicateDatesMerged += 1;
    list.push(entry.value);
    byDate.set(entry.date, list);
  }
  const days = [...byDate.keys()].sort();
  const daily = days.map((date) => ({ date, day: dayNumber(date), value: median(byDate.get(date)!)! }));
  const points: Vo2TrendPoint[] = daily.map((reading, i) => {
    const window = daily
      .slice(0, i + 1)
      .filter((r) => reading.day - r.day < VO2_TREND_WINDOW_DAYS)
      .map((r) => r.value);
    const previous = i > 0 ? daily[i - 1] : null;
    return {
      date: reading.date,
      value: reading.value,
      median28: window.length >= VO2_TREND_MIN_READINGS ? median(window) : null,
      readingsInWindow: window.length,
      gapBefore: previous !== null && reading.day - previous.day > VO2_EXTENDED_GAP_DAYS,
      discontinuity: previous !== null && Math.abs(reading.value - previous.value) >= VO2_DISCONTINUITY_ML,
    };
  });
  return { points, excluded };
}

export interface Vo2TrendSummary {
  latestDate: string | null;
  latestValue: number | null;
  latestMedian28: number | null;
  /** Whole days between the latest reading and `asOf`; null with no readings. */
  daysSinceLatest: number | null;
  stale: boolean;
  /** Median of the supplied points' values (a real reference level, not a constant). */
  referenceMedian: number | null;
  discontinuities: number;
  extendedGaps: number;
}

export function summarizeVo2Trend(series: Vo2TrendSeries, asOf: string): Vo2TrendSummary {
  const latest = series.points[series.points.length - 1] ?? null;
  const daysSince = latest && isIsoDate(asOf) ? dayNumber(asOf) - dayNumber(latest.date) : null;
  return {
    latestDate: latest?.date ?? null,
    latestValue: latest?.value ?? null,
    latestMedian28: latest?.median28 ?? null,
    daysSinceLatest: daysSince,
    stale: daysSince === null ? false : daysSince > VO2_STALE_DAYS,
    referenceMedian: median(series.points.map((p) => p.value)),
    discontinuities: series.points.filter((p) => p.discontinuity).length,
    extendedGaps: series.points.filter((p) => p.gapBefore).length,
  };
}

/**
 * RESEARCH ONLY (never rendered). Theil–Sen slope over the trailing window ending
 * at `asOf`, per 28 days. Null unless there are ≥ minReadings readings spanning
 * ≥ minSpanDays and no extended gap inside the window — so it cannot extrapolate
 * across missing periods.
 */
export function theilSenSlopePer28d(
  entries: readonly Vo2Entry[],
  asOf: string,
  options: { windowDays?: number; minReadings?: number; minSpanDays?: number } = {}
): number | null {
  const windowDays = options.windowDays ?? 90;
  const minReadings = options.minReadings ?? 8;
  const minSpan = options.minSpanDays ?? 42;
  const series = buildVo2TrendSeries(entries, { asOf });
  const end = dayNumber(asOf);
  const inWindow = series.points.filter((p) => end - dayNumber(p.date) < windowDays);
  if (inWindow.length < minReadings) return null;
  const span = dayNumber(inWindow[inWindow.length - 1].date) - dayNumber(inWindow[0].date);
  if (span < minSpan) return null;
  if (inWindow.slice(1).some((p) => p.gapBefore)) return null;
  const slopes: number[] = [];
  for (let i = 0; i < inWindow.length; i++) {
    for (let j = i + 1; j < inWindow.length; j++) {
      const dx = dayNumber(inWindow[j].date) - dayNumber(inWindow[i].date);
      if (dx > 0) slopes.push((inWindow[j].value - inWindow[i].value) / dx);
    }
  }
  const m = median(slopes);
  return m === null ? null : m * 28;
}
