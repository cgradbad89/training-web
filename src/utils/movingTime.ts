/**
 * Shared moving-vs-stopped thresholds.
 *
 * Pace/effort metrics must reflect ACTUAL running, not elapsed-including-stops:
 * a stopped segment (traffic light, pause, cool-down stroll) adds real seconds
 * to a pace numerator while contributing ~no distance to its denominator, which
 * inflates the pace slower than truth. A segment counts as MOVING only if it
 * covers real ground (≥ MIN_MOVING_DIST_M) at a real speed
 * (≥ MIN_MOVING_SPEED_MS); otherwise its time/distance are excluded.
 *
 * These constants originated in src/utils/gradeAdjustedPace.ts and were lifted
 * here so the per-mile split partial (src/utils/mileSplits.ts) can reuse the
 * IDENTICAL thresholds without duplicating magic numbers.
 */

/** m/s (~1.1 mph) — below this a segment is treated as stopped. */
export const MIN_MOVING_SPEED_MS = 0.5;
/** Minimum segment distance (m) for a segment to count as moving. */
export const MIN_MOVING_DIST_M = 1.0;
