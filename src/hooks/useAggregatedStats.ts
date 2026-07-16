import { useState, useEffect } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { type HealthWorkout } from "@/types/healthWorkout";
import {
  type AggregatedStatsDoc,
  buildAggregatedStats,
  isAggregatedStatsStale,
} from "@/utils/aggregatedStats";
import { getRoutePoints } from "@/utils/routeCache";
import { getMileSplits } from "@/utils/mileSplitsCache";
import { vo2HistoryCutoffISO } from "@/utils/vo2History";
import { collection, query, where, orderBy, getDocs } from "firebase/firestore";

function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

export interface UseAggregatedStatsResult {
  data: AggregatedStatsDoc | null;
  loading: boolean;
  error: Error | null;
}

export async function fetchAndComputeAggregatedStats(
  uid: string,
  workouts: HealthWorkout[],
  maxHr: number,
  restingHr: number,
  races: { raceDate: Date | string; distanceMiles: number }[],
  latestWorkoutId: string
): Promise<AggregatedStatsDoc> {
  const statsRef = doc(db, `users/${uid}/insights/aggregatedStats`);
  const statsSnap = await getDoc(statsRef);
  const cached = statsSnap.exists()
    ? (statsSnap.data() as AggregatedStatsDoc)
    : null;

  if (!isAggregatedStatsStale(cached, latestWorkoutId)) {
    return cached as AggregatedStatsDoc;
  }

  // --- Stale path: fetch missing data ---
  
  // 1. routePoints for up to ~50 runs
  const yearRunsWithRoute = workouts
    .filter((r) => r.isRunLike && r.hasRoute && r.distanceMiles >= 1.0)
    .sort((a, b) => b.startDate.getTime() - a.startDate.getTime())
    .slice(0, 50);

  const routePointsByWorkoutId: Record<string, any[]> = {};
  await Promise.all(
    yearRunsWithRoute.map(async (run) => {
      try {
        const points = await getRoutePoints(uid, run.workoutId);
        routePointsByWorkoutId[run.workoutId] = points;
      } catch {
        // Ignore failure for a single run's route points
      }
    })
  );

  // 2. mileSplits for up to ~40 runs
  const eightWeeksAgo = new Date();
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 8 * 7);

  const candidateRuns = workouts
    .filter(
      (r) =>
        r.isRunLike &&
        r.hasRoute &&
        r.startDate >= eightWeeksAgo &&
        r.distanceMiles > 0
    )
    .sort((a, b) => b.startDate.getTime() - a.startDate.getTime())
    .slice(0, 40);

  const mileSplitsByWorkoutId: Record<string, any[]> = {};
  const batchSize = 10;
  for (let i = 0; i < candidateRuns.length; i += batchSize) {
    const batch = candidateRuns.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (run) => {
        try {
          const splits = await getMileSplits(uid, run.workoutId);
          mileSplitsByWorkoutId[run.workoutId] = splits;
        } catch {
          // Ignore failure
        }
      })
    );
  }

  // 3. healthMetrics for VO2
  const cutoffStr = vo2HistoryCutoffISO(new Date());
  const metricsSnap = await getDocs(
    query(
      collection(db, `users/${uid}/healthMetrics`),
      where("date", ">=", cutoffStr),
      orderBy("date")
    )
  );
  const healthMetrics = metricsSnap.docs.map((d) => ({
    id: d.id,
    data: d.data() as { date?: string; vo2_max?: number },
  }));

  // Compute fresh aggregated stats
  const freshStats = buildAggregatedStats({
    workouts,
    routePointsByWorkoutId,
    mileSplitsByWorkoutId,
    healthMetrics,
    maxHr,
    restingHr,
    now: new Date(),
    races,
  });

  // Fire-and-forget write
  setDoc(statsRef, stripUndefined(freshStats)).catch((err) => {
    console.warn("Failed to write aggregatedStats to Firestore:", err);
  });

  return freshStats;
}

export function useAggregatedStats(
  uid: string | null,
  workouts: HealthWorkout[],
  maxHr: number,
  restingHr: number,
  races: { raceDate: Date | string; distanceMiles: number }[]
): UseAggregatedStatsResult {
  const [data, setData] = useState<AggregatedStatsDoc | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  const latestWorkoutStartTime = workouts.reduce(
    (max, w) => Math.max(max, w.startDate.getTime()),
    0
  );

  useEffect(() => {
    if (!uid) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const latestWorkoutId =
      workouts.length > 0
        ? workouts.reduce((latest, current) =>
            current.startDate > latest.startDate ? current : latest
          ).workoutId
        : "";

    fetchAndComputeAggregatedStats(uid, workouts, maxHr, restingHr, races, latestWorkoutId)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [uid, latestWorkoutStartTime, maxHr, restingHr, JSON.stringify(races)]);

  return { data, loading, error };
}
