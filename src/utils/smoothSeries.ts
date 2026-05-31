/**
 * Time-windowed rolling average for noisy per-point series (e.g. GPS pace).
 *
 * Display-only smoothing: per-point GPS pace swings ±~2 min/mi between
 * consecutive samples, which renders as an unreadable hairball. A centered
 * rolling mean over a short time window damps that volatility the way Strava's
 * pace chart does, without touching the underlying data.
 */

/** Centered smoothing window, in seconds. */
export const SMOOTH_WINDOW_SEC = 25;

/**
 * Centered rolling mean of `values`, windowed by TIME using `timestampsSec`
 * (seconds, ascending). null inputs are skipped in each window's average; a
 * window with no finite values yields null (so line breaks are preserved).
 *
 * When timestamps are unusable (wrong length, non-finite, or not increasing),
 * falls back to a fixed-COUNT window approximating `windowSeconds` at the run's
 * average sample rate.
 *
 * Pure: does not mutate `values` or `timestampsSec`.
 */
export function rollingAverage(
  values: (number | null)[],
  windowSeconds: number,
  timestampsSec: number[]
): (number | null)[] {
  const n = values.length;
  if (n === 0) return [];

  const tsUsable =
    timestampsSec.length === n &&
    timestampsSec.every((t) => Number.isFinite(t)) &&
    timestampsSec[n - 1] > timestampsSec[0];

  const out: (number | null)[] = new Array(n);

  if (tsUsable) {
    // Time-based window (uses real per-point timestamps).
    const half = windowSeconds / 2;
    for (let i = 0; i < n; i++) {
      const lo = timestampsSec[i] - half;
      const hi = timestampsSec[i] + half;
      let sum = 0;
      let cnt = 0;
      for (let j = 0; j < n; j++) {
        if (timestampsSec[j] < lo) continue;
        if (timestampsSec[j] > hi) break; // ascending → no later point qualifies
        const v = values[j];
        if (v != null && Number.isFinite(v)) {
          sum += v;
          cnt++;
        }
      }
      out[i] = cnt > 0 ? sum / cnt : null;
    }
    return out;
  }

  // Fallback: fixed-count window approximating windowSeconds at avg sample rate.
  let avgDt = 1;
  if (
    timestampsSec.length === n &&
    Number.isFinite(timestampsSec[0]) &&
    Number.isFinite(timestampsSec[n - 1]) &&
    timestampsSec[n - 1] > timestampsSec[0]
  ) {
    avgDt = (timestampsSec[n - 1] - timestampsSec[0]) / (n - 1);
  }
  const count = Math.max(1, Math.round(windowSeconds / (avgDt > 0 ? avgDt : 1)));
  const halfCount = Math.floor(count / 2);

  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    for (
      let j = Math.max(0, i - halfCount);
      j <= Math.min(n - 1, i + halfCount);
      j++
    ) {
      const v = values[j];
      if (v != null && Number.isFinite(v)) {
        sum += v;
        cnt++;
      }
    }
    out[i] = cnt > 0 ? sum / cnt : null;
  }
  return out;
}
