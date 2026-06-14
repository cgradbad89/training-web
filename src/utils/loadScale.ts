/**
 * Single-scale Load-chip intensity (pure, in-memory).
 *
 * Maps a training-load score to a 0–1 intensity against a single shared cap —
 * the highest run load observed across ALL of the user's runs, supplied by the
 * caller (NEVER hardcoded here). Intensity drives only the Load chip's
 * background opacity; hue, text, and border are unchanged.
 */

/**
 * @param load the activity's load score (null/zero/negative → 0).
 * @param cap  the max run load across the user's data (0/negative → 0, no
 *             division error).
 * @returns 0 for null/zero load, 1.0 when load ≥ cap, else load/cap clamped to
 *          [0, 1].
 */
export function computeLoadIntensity(load: number | null, cap: number): number {
  if (load == null || !Number.isFinite(load) || load <= 0) return 0;
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  return Math.min(load / cap, 1);
}
