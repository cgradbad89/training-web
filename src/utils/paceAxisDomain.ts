/**
 * Robust y-axis domain for the pace/GAP overlay.
 *
 * GPS-glitch segments can produce pace/GAP values that plunge to near-zero,
 * which would expand an auto-scaled (min/max) axis and crush the real signal
 * into a thin band. Instead we build the domain from the 5th–95th percentiles
 * of the finite values (outliers are kept on the chart via allowDataOverflow,
 * but do not drive the axis) and clamp it to sane absolute bounds.
 *
 * Display-only: this does NOT alter any pace/GAP computation.
 */

/** Never show a pace faster than 4:00/mi on the axis. */
export const MIN_PACE_FLOOR_SEC = 240;
/** Never show a pace slower than 20:00/mi on the axis. */
export const MAX_PACE_CEIL_SEC = 1200;

/**
 * Compute a robust [min, max] pace-axis domain (seconds/mile) from a list of
 * pace/GAP values. Non-finite values are ignored. Returns a safe fallback when
 * there are no finite values.
 */
export function computePaceAxisDomain(values: number[]): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) {
    return [MIN_PACE_FLOOR_SEC, MAX_PACE_CEIL_SEC];
  }

  const sorted = [...finite].sort((a, b) => a - b);
  const percentile = (p: number): number => {
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.floor(p * (sorted.length - 1)))
    );
    return sorted[idx];
  };

  const p5 = percentile(0.05);
  const p95 = percentile(0.95);
  const spread = p95 - p5;
  const padding = Math.max(10, 0.05 * spread);

  let domainMin = Math.max(MIN_PACE_FLOOR_SEC, p5 - padding);
  let domainMax = Math.min(MAX_PACE_CEIL_SEC, p95 + padding);

  // Guarantee a non-zero-width, correctly-ordered domain after clamping.
  if (domainMax <= domainMin) {
    domainMax = Math.min(MAX_PACE_CEIL_SEC, domainMin + 20);
    if (domainMax <= domainMin) {
      domainMin = Math.max(MIN_PACE_FLOOR_SEC, domainMax - 20);
    }
  }

  return [domainMin, domainMax];
}
