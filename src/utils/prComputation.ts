/**
 * Personal Record (PR) computation for runs.
 *
 * Mirrors the Personal Insights PR table — the same run wins the PR on
 * both pages. Tolerances and band boundaries are taken from Personal
 * Insights so the displayed badges agree with that table.
 *
 * Pace is derived as `durationSeconds / distanceMiles` (same as Personal
 * Insights) rather than the stored `avgPaceSecPerMile`, which can be null
 * on older sync rows.
 */

import { type HealthWorkout } from "@/types/healthWorkout";

export interface PRCategory {
  id: string;
  label: string;
  type: "band" | "specific";
}

/** Distance-band PRs — best pace within a mileage range. */
export const DISTANCE_BAND_CATEGORIES: PRCategory[] = [
  { id: "band_1mi",  label: "1 Mile PR",   type: "band" },
  { id: "band_1_3",  label: "1–3 mi PR",   type: "band" },
  { id: "band_3_6",  label: "3–6 mi PR",   type: "band" },
  { id: "band_6_7",  label: "6–7 mi PR",   type: "band" },
  { id: "band_7_10", label: "7–10 mi PR",  type: "band" },
  { id: "band_10p",  label: "10+ mi PR",   type: "band" },
];

/** Specific-distance PRs — best pace among runs within tolerance of the target. */
export const SPECIFIC_DISTANCE_CATEGORIES: PRCategory[] = [
  { id: "dist_5k",   label: "5K PR",            type: "specific" },
  { id: "dist_5mi",  label: "5 Mile PR",         type: "specific" },
  { id: "dist_10k",  label: "10K PR",            type: "specific" },
  { id: "dist_15k",  label: "15K PR",            type: "specific" },
  { id: "dist_10mi", label: "10 Mile PR",        type: "specific" },
  { id: "dist_hm",   label: "Half Marathon PR",  type: "specific" },
];

export const ALL_PR_CATEGORIES: PRCategory[] = [
  ...DISTANCE_BAND_CATEGORIES,
  ...SPECIFIC_DISTANCE_CATEGORIES,
];

/** Inclusive lower / exclusive upper mile bounds. */
export const BAND_RANGES: Record<string, [number, number]> = {
  band_1mi:  [0.9,  1.1],
  band_1_3:  [1.0,  3.0],
  band_3_6:  [3.0,  6.0],
  band_6_7:  [6.0,  7.0],
  band_7_10: [7.0,  10.0],
  band_10p:  [10.0, Infinity],
};

/** Tolerances chosen to match Personal Insights so both pages agree. */
export const SPECIFIC_TARGETS: Record<string, { miles: number; tol: number }> = {
  dist_5k:   { miles: 3.107,  tol: 0.3  },
  dist_5mi:  { miles: 5.0,    tol: 0.5  },
  dist_10k:  { miles: 6.214,  tol: 0.5  },
  dist_15k:  { miles: 9.321,  tol: 0.75 },
  dist_10mi: { miles: 10.0,   tol: 0.75 },
  dist_hm:   { miles: 13.109, tol: 1.0  },
};

export interface PRResult {
  categoryId: string;
  label: string;
  workoutId: string;
  paceSecondsPerMile: number;
}

/** Pace derived consistently with Personal Insights: duration / distance. */
function paceFor(r: HealthWorkout): number | null {
  if (r.distanceMiles <= 0 || r.durationSeconds <= 0) return null;
  return r.durationSeconds / r.distanceMiles;
}

/**
 * Compute the current PR holders across all categories. For each category
 * the run with the lowest pace wins. Returns one PRResult per category
 * that has at least one qualifying run.
 */
export function computeAllPRs(runs: HealthWorkout[]): PRResult[] {
  const eligible = runs.filter((r) => {
    if (!r.isRunLike) return false;
    if (r.distanceMiles <= 0) return false;
    const pace = paceFor(r);
    if (pace == null) return false;
    if (pace <= 0 || pace >= 1800) return false; // sanity: under 30 min/mi
    return true;
  });

  const results: PRResult[] = [];

  // Distance bands
  for (const category of DISTANCE_BAND_CATEGORIES) {
    const [min, max] = BAND_RANGES[category.id];
    const candidates = eligible.filter(
      (r) => r.distanceMiles >= min && r.distanceMiles < max
    );
    if (candidates.length === 0) continue;
    const best = candidates.reduce((a, b) =>
      (paceFor(a) ?? Infinity) < (paceFor(b) ?? Infinity) ? a : b
    );
    const pace = paceFor(best);
    if (pace == null) continue;
    results.push({
      categoryId: category.id,
      label: category.label,
      workoutId: best.workoutId,
      paceSecondsPerMile: pace,
    });
  }

  // Specific distances
  for (const category of SPECIFIC_DISTANCE_CATEGORIES) {
    const target = SPECIFIC_TARGETS[category.id];
    const candidates = eligible.filter(
      (r) => Math.abs(r.distanceMiles - target.miles) <= target.tol
    );
    if (candidates.length === 0) continue;
    const best = candidates.reduce((a, b) =>
      (paceFor(a) ?? Infinity) < (paceFor(b) ?? Infinity) ? a : b
    );
    const pace = paceFor(best);
    if (pace == null) continue;
    results.push({
      categoryId: category.id,
      label: category.label,
      workoutId: best.workoutId,
      paceSecondsPerMile: pace,
    });
  }

  return results;
}

/** Map workoutId → array of PR labels held by that run. */
export function buildPRBadgeMap(prResults: PRResult[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const pr of prResults) {
    const existing = map.get(pr.workoutId) ?? [];
    existing.push(pr.label);
    map.set(pr.workoutId, existing);
  }
  return map;
}
