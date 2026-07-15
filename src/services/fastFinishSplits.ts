/**
 * Fast-finish hydration — attaches the transient `mileSplits` (route-derived
 * per-mile pace + per-mile avgBpm) that {@link bestFastFinishSegment} and the
 * fixed-window continuous path need, for EVERY run in the best-effort recency
 * window (not just the single viewed run). Read-only; no Firestore writes.
 *
 * PERFORMANCE — the expensive part is the GPS `route` read (hundreds of points
 * per run). To avoid paying it for runs that could never earn fast-finish
 * credit, each run is first pre-filtered on the CHEAP `mileSplits` subcollection
 * (a handful of tiny {mile, avgBpm, sampleCount} docs, no route fetch): the
 * route is fetched ONLY when at least one mile already clears the HRR gate by
 * `avgBpm` alone. A run whose every mile is below the gate can never produce a
 * qualifying per-mile segment, so its route read is skipped entirely.
 *
 * Route reads go through {@link getRoutePoints} (module-level cache + in-flight
 * dedup), so a run whose route was already read elsewhere on the page is free.
 */

import { collection, getDocs, orderBy, query } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { getRoutePoints } from "@/utils/routeCache";
import { getMileSplits } from "@/utils/mileSplitsCache";
import { computeMileSplits, type MileSplit } from "@/utils/mileSplits";
import {
  BEST_EFFORT_RECENCY_DAYS,
  HRR_GATE_THRESHOLD,
} from "@/utils/bestEffortExtraction";
import { type HealthWorkout } from "@/types/healthWorkout";

/** Per-mile HR row from the iOS-synced `mileSplits` subcollection. */
interface MileSplitHR {
  mile: number;
  avgBpm: number;
}

/**
 * Read the lightweight per-mile HR rows (no route fetch). Mirrors the same
 * `sampleCount >= 2` reliability gate the run-detail page uses so a mile with
 * one stray sample can't spuriously pass the pre-filter.
 */
async function fetchMileSplitHR(
  uid: string,
  workoutId: string
): Promise<MileSplitHR[]> {
  const splits = await getMileSplits(uid, workoutId);
  const out: MileSplitHR[] = [];
  splits.forEach((data) => {
    if (data.avgBpm && (data.sampleCount as number) >= 2) {
      out.push({ mile: data.mile as number, avgBpm: data.avgBpm as number });
    }
  });
  return out;
}

/** avgBpm at exactly the HRR gate, given the athlete's HR anchors. */
export function fastFinishPrefilterBpm(maxHr: number, restingHr: number): number {
  return restingHr + HRR_GATE_THRESHOLD * (maxHr - restingHr);
}

export interface HydrateFastFinishResult {
  /** Input runs with `mileSplits` attached where hydration applied. */
  runs: HealthWorkout[];
  /** How many runs passed the cheap pre-filter and incurred a GPS route read
   *  (0 if all reads were cache hits or every run was below the gate). */
  routeFetches: number;
}

/**
 * Hydrate `mileSplits` for the runs that could earn fast-finish credit.
 *
 * For each run inside the best-effort recency window that is run-like, has a
 * positive distance, and is not already hydrated:
 *   1. read the cheap per-mile HR rows;
 *   2. skip (no route read) unless at least one mile clears the HRR gate by
 *      avgBpm alone — the pre-filter;
 *   3. otherwise read the GPS route, derive per-mile pace with the SAME
 *      haversine calculation the run-detail mile-splits table uses
 *      ({@link computeMileSplits}), and merge in the per-mile avgBpm.
 *
 * Runs outside the window, non-runs, or runs that fail the pre-filter are
 * returned unchanged. Pure w.r.t. the input array (returns a new array).
 */
export async function hydrateFastFinishSplits(
  uid: string,
  runs: HealthWorkout[],
  opts: { maxHr: number; restingHr: number; asOf?: Date }
): Promise<HydrateFastFinishResult> {
  const { maxHr, restingHr, asOf = new Date() } = opts;
  const cutoffMs = asOf.getTime() - BEST_EFFORT_RECENCY_DAYS * 86400000;
  const prefilterBpm = fastFinishPrefilterBpm(maxHr, restingHr);

  let routeFetches = 0;

  const hydrated = await Promise.all(
    runs.map(async (w) => {
      const inWindow = w.startDate.getTime() >= cutoffMs;
      if (
        !inWindow ||
        !w.isRunLike ||
        !(w.distanceMiles > 0) ||
        (w.mileSplits && w.mileSplits.length > 0)
      ) {
        return w;
      }

      try {
        const hrRows = await fetchMileSplitHR(uid, w.workoutId);
        if (hrRows.length === 0) return w;

        // Pre-filter: at least one mile already at/above the gate by avgBpm.
        const hasHardMile = hrRows.some((r) => r.avgBpm >= prefilterBpm);
        if (!hasHardMile) return w;

        const points = await getRoutePoints(uid, w.workoutId);
        routeFetches++;
        if (points.length < 2) return w;

        const hrByMile = new Map(hrRows.map((r) => [r.mile, r.avgBpm]));
        const splits: MileSplit[] = computeMileSplits(
          points,
          w.avgHeartRate,
          w.distanceMiles
        ).map((s) => ({ ...s, avgBpm: hrByMile.get(s.mile) }));

        return { ...w, mileSplits: splits };
      } catch (err) {
        console.error("[hydrateFastFinishSplits]", w.workoutId, err);
        return w;
      }
    })
  );

  return { runs: hydrated, routeFetches };
}
