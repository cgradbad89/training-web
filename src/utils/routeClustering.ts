/**
 * Geographic route clustering — EXTRACTED VERBATIM from the Routes page
 * (src/app/(app)/routes/page.tsx) so the run detail page can reuse the exact
 * same grouping. This is the single route-matching algorithm in the app; do
 * not fork it. Start points come from getRouteStartPoint (module-cached, one
 * 1-doc Firestore read per uncached run).
 */

import { type HealthWorkout } from "@/types/healthWorkout";
import { getRouteStartPoint, haversineMeters } from "@/utils/routeCache";

export interface RouteCluster {
  id: string;
  representativeRun: HealthWorkout;
  allRuns: HealthWorkout[];
  distanceMiles: number;
  startLat: number;
  startLng: number;
}

/**
 * Phase 1: Group runs by distance (±0.5 miles).
 * Phase 2: Within each distance group, sub-cluster by start GPS point.
 * Two runs cluster together only if start points are within 300m.
 */
export async function clusterRoutesGeographic(
  runs: HealthWorkout[],
  uid: string
): Promise<RouteCluster[]> {
  // Fetch start points for all runs in parallel (batched)
  const startPoints = new Map<string, { lat: number; lng: number } | null>();

  for (let i = 0; i < runs.length; i += 10) {
    const batch = runs.slice(i, i + 10);
    await Promise.all(
      batch.map(async (run) => {
        const pt = await getRouteStartPoint(uid, run.workoutId);
        startPoints.set(run.workoutId, pt);
      })
    );
  }

  // Sort by pace (best pace first = representative run)
  const sorted = [...runs].sort(
    (a, b) => (a.avgPaceSecPerMile ?? 999) - (b.avgPaceSecPerMile ?? 999)
  );

  const clusters: RouteCluster[] = [];
  const assigned = new Set<string>();

  for (const run of sorted) {
    if (assigned.has(run.workoutId)) continue;

    const runStart = startPoints.get(run.workoutId);
    const cluster: RouteCluster = {
      id: run.workoutId,
      representativeRun: run,
      allRuns: [run],
      distanceMiles: run.distanceMiles ?? 0,
      startLat: runStart?.lat ?? 0,
      startLng: runStart?.lng ?? 0,
    };

    for (const other of sorted) {
      if (other.workoutId === run.workoutId) continue;
      if (assigned.has(other.workoutId)) continue;

      // Distance must be within ±0.5 miles
      const distDiff = Math.abs(
        (run.distanceMiles ?? 0) - (other.distanceMiles ?? 0)
      );
      if (distDiff > 0.5) continue;

      // If either run has no start point, fall back to distance-only
      const otherStart = startPoints.get(other.workoutId);
      if (runStart && otherStart) {
        // Start points must be within 300 meters
        const dist = haversineMeters(
          runStart.lat,
          runStart.lng,
          otherStart.lat,
          otherStart.lng
        );
        if (dist > 300) continue;
      }

      cluster.allRuns.push(other);
      assigned.add(other.workoutId);
    }

    assigned.add(run.workoutId);
    clusters.push(cluster);
  }

  return clusters;
}

/** The cluster containing `workoutId`, or null when the run is unclustered. */
export function findClusterForRun(
  clusters: RouteCluster[],
  workoutId: string
): RouteCluster | null {
  return (
    clusters.find((c) => c.allRuns.some((r) => r.workoutId === workoutId)) ??
    null
  );
}
