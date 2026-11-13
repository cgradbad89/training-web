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
import { toLocalIsoDate } from "@/utils/dates";
import { distanceInPrBand, type PrBandId } from "@/utils/personalRecords";

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

/** The 1 Mile band exists only on the run-list badges (Personal Insights has
 *  no such row; its "1 Mile" comes from `bestEfforts`). Inclusive lower /
 *  exclusive upper mile bounds. Every other band comes from the single shared
 *  definition in personalRecords.ts (`PR_BAND_RANGES`): `7–10 mi` ends at 10.0
 *  inclusive and `10+ mi` is strictly > 10.0. */
const ONE_MILE_BAND: [number, number] = [0.9, 1.1];

function inBand(categoryId: string, miles: number): boolean {
  if (categoryId === "band_1mi") {
    return miles >= ONE_MILE_BAND[0] && miles < ONE_MILE_BAND[1];
  }
  return distanceInPrBand(categoryId as PrBandId, miles);
}

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
 *
 * Eligibility filter (`pace > 180 && pace < 1200`) matches Personal Insights
 * exactly so the same runs win on both pages.
 */
export function computeAllPRs(runs: HealthWorkout[]): PRResult[] {
  const eligible = runs.filter((r) => {
    if (!r.isRunLike) return false;
    if (r.distanceMiles <= 0) return false;
    if (r.durationSeconds <= 0) return false;
    const pace = paceFor(r);
    if (pace == null || !isFinite(pace)) return false;
    // Match Personal Insights: 3:00–20:00 per mile (180s–1200s).
    return pace > 180 && pace < 1200;
  });

  const results: PRResult[] = [];

  // Distance bands
  for (const category of DISTANCE_BAND_CATEGORIES) {
    const candidates = eligible.filter((r) => inBand(category.id, r.distanceMiles));
    if (candidates.length === 0) continue;
    const best = candidates.reduce((a, b) =>
      (paceFor(a) ?? Infinity) < (paceFor(b) ?? Infinity) ? a : b
    );
    const pace = paceFor(best);
    if (pace == null) continue;
    console.log(`[prComputation] ${category.id} winner:`, {
      workoutId: best.workoutId,
      distanceMiles: best.distanceMiles,
      durationSeconds: best.durationSeconds,
      derivedPace: pace,
      date: toLocalIsoDate(best.startDate),
    });
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
    console.log(`[prComputation] ${category.id} winner:`, {
      workoutId: best.workoutId,
      distanceMiles: best.distanceMiles,
      durationSeconds: best.durationSeconds,
      derivedPace: pace,
      date: toLocalIsoDate(best.startDate),
    });
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
