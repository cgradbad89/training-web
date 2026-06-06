/**
 * Pure data shaping for the workout HR chart (WorkoutHRChart).
 *
 * Extracted so the filter / elapsed-time / downsample logic is unit-testable
 * without rendering Recharts. Mirrors RunOverlayChart's conventions:
 *   - HR anomaly filter: drop samples outside [MIN_HR, MAX_HR].
 *   - Elapsed-time X axis: timeSec = (t − t0)/1000 (no distance; non-route).
 *   - Downsample dense streams to ≤ MAX_CHART_POINTS via stride decimation,
 *     always keeping the LAST point.
 *   - RAW HR — no smoothing (HIIT interval spikes are signal).
 */

/** HR anomaly bounds, matching RunOverlayChart (MIN_HR / MAX_HR). */
export const HR_CHART_MIN_HR = 40;
export const HR_CHART_MAX_HR = 220;
/** Stride-downsample threshold, matching RunOverlayChart's MAX_CHART_POINTS. */
export const HR_CHART_MAX_POINTS = 300;

export interface HRChartDatum {
  /** Seconds since the first valid sample (X axis). */
  timeSec: number;
  hr: number;
}

/**
 * Filter → elapsed-time → downsample. Returns [] when fewer than 2 valid
 * samples remain (the component renders nothing in that case).
 *
 * Pure: does not mutate `samples`.
 */
export function buildHRChartData(
  samples: { timestamp: string; hr: number }[]
): HRChartDatum[] {
  // Parse + anomaly filter. Drop unparseable timestamps and out-of-range HR.
  const valid = samples
    .map((s) => ({ tMs: Date.parse(s.timestamp), hr: s.hr }))
    .filter(
      (s) =>
        Number.isFinite(s.tMs) &&
        Number.isFinite(s.hr) &&
        s.hr >= HR_CHART_MIN_HR &&
        s.hr <= HR_CHART_MAX_HR
    )
    .sort((a, b) => a.tMs - b.tMs);

  if (valid.length < 2) return [];

  const baseMs = valid[0].tMs;
  const full: HRChartDatum[] = valid.map((s) => ({
    timeSec: (s.tMs - baseMs) / 1000,
    hr: s.hr,
  }));

  // Downsample very dense streams for chart responsiveness (keep the last
  // point so the line reaches the true end of the workout).
  if (full.length > HR_CHART_MAX_POINTS) {
    const stride = Math.ceil(full.length / HR_CHART_MAX_POINTS);
    return full.filter((_, i) => i % stride === 0 || i === full.length - 1);
  }
  return full;
}

/** Format elapsed seconds as m:ss for axis ticks / tooltip. */
export function formatElapsedMMSS(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
