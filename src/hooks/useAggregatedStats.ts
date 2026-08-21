import { useState, useEffect, useMemo } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { type HealthWorkout } from "@/types/healthWorkout";
import {
  AGGREGATED_STATS_VERSION,
  type AggregatedStatsDoc,
  type AggregatedStatsFreshnessFingerprint,
  buildAggregatedStats,
  computeWorkoutAggregationRevision,
  computeFreshnessFingerprint,
  computeVo2FreshnessKey,
  isFingerprintStale,
  isVo2Stale,
  reviveAggregatedStatsDates,
} from "@/utils/aggregatedStats";
import { getMileSplits } from "@/utils/mileSplitsCache";
import { buildVo2History, vo2HistoryCutoffISO } from "@/utils/vo2History";
import { collection, query, where, orderBy, getDocs } from "firebase/firestore";

function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

export interface UseAggregatedStatsResult {
  data: AggregatedStatsDoc | null;
  loading: boolean;
  error: Error | null;
}

export interface AggregationLoadingState {
  workoutsLoading: boolean;
  settingsLoading: boolean;
  racesLoading: boolean;
  overridesLoading: boolean;
}

export interface UseAggregatedStatsOptions {
  enabled?: boolean;
  activeRaceId?: string | null;
  activeRaceDate?: string | null;
  overrides?: unknown;
}

export type AggregationLogEvent =
  | "start"
  | "skip-in-flight"
  | "skip-not-ready"
  | "complete"
  | "error";

const aggregationInFlight = new Map<string, Promise<AggregatedStatsDoc>>();

export function getAggregationLockKey(
  uid: string,
  freshnessRevision: string
): string {
  return `${uid}:${freshnessRevision}`;
}

export function isAggregationReady(
  uid: string | null,
  loadingState: AggregationLoadingState
): uid is string {
  return (
    uid !== null &&
    !loadingState.workoutsLoading &&
    !loadingState.settingsLoading &&
    !loadingState.racesLoading &&
    !loadingState.overridesLoading
  );
}

export function logAggregationEvent(
  event: AggregationLogEvent,
  details: Record<string, unknown>
): void {
  const payload = { event, ...details };
  if (event === "error") {
    console.warn("[aggregated-stats]", payload);
    return;
  }
  console.log("[aggregated-stats]", payload);
}

async function computeAggregatedStats(
  uid: string,
  workouts: HealthWorkout[],
  maxHr: number,
  restingHr: number,
  races: { raceDate: Date | string; distanceMiles: number }[],
  currentFingerprint: AggregatedStatsFreshnessFingerprint
): Promise<AggregatedStatsDoc> {
  const statsRef = doc(db, `users/${uid}/insights/aggregatedStats`);
  const statsSnap = await getDoc(statsRef);
  const cached = statsSnap.exists()
    ? reviveAggregatedStatsDates(statsSnap.data() as AggregatedStatsDoc)
    : null;

  // The latest VO2 date is not part of AppDataContext, so derive its independent
  // key from the same bounded healthMetrics query the aggregation already used.
  // The key helpers themselves are pure and do not perform Firestore reads.
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
  const currentVo2History = buildVo2History(healthMetrics);
  const currentVo2Key = computeVo2FreshnessKey(
    currentVo2History.at(-1)?.date ?? null
  );
  const mainStale =
    !cached?.freshnessFingerprint ||
    isFingerprintStale(cached.freshnessFingerprint, currentFingerprint);
  const vo2Stale =
    !cached?.vo2FreshnessKey ||
    isVo2Stale(cached.vo2FreshnessKey, currentVo2Key);

  if (!mainStale && !vo2Stale) {
    return cached;
  }

  if (!mainStale && cached) {
    const vo2OnlyStats: AggregatedStatsDoc = {
      ...cached,
      computedAt: new Date().toISOString(),
      vo2History: currentVo2History,
      vo2FreshnessKey: currentVo2Key,
    };
    await setDoc(statsRef, stripUndefined(vo2OnlyStats));
    return vo2OnlyStats;
  }

  // Main stale path: fetch mileSplits for up to ~40 runs (unchanged;
  // HR-zone distribution only).
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

  // Compute fresh aggregated stats
  const freshStats = buildAggregatedStats({
    workouts,
    mileSplitsByWorkoutId,
    healthMetrics,
    maxHr,
    restingHr,
    now: new Date(),
    races,
    freshnessFingerprint: currentFingerprint,
    vo2FreshnessKey: currentVo2Key,
    vo2HistoryOverride: vo2Stale ? undefined : cached?.vo2History,
  });

  // The computation is not complete until the cache write is confirmed. A
  // rejected write propagates to the caller so the in-flight lock can release
  // and a later trigger can retry instead of treating an unpersisted result as
  // complete.
  await setDoc(statsRef, stripUndefined(freshStats));

  return freshStats;
}

export function fetchAndComputeAggregatedStats(
  uid: string,
  workouts: HealthWorkout[],
  maxHr: number,
  restingHr: number,
  races: { raceDate: Date | string; distanceMiles: number }[],
  currentFingerprint: AggregatedStatsFreshnessFingerprint
): Promise<AggregatedStatsDoc> {
  const latestWorkoutId = currentFingerprint.latestWorkoutId;
  const lockKey = getAggregationLockKey(uid, JSON.stringify(currentFingerprint));
  const existing = aggregationInFlight.get(lockKey);
  if (existing) {
    logAggregationEvent("skip-in-flight", {
      uid,
      latestWorkoutId,
      lockKey,
    });
    return existing;
  }

  logAggregationEvent("start", { uid, latestWorkoutId, lockKey });

  let lockedPromise!: Promise<AggregatedStatsDoc>;
  lockedPromise = computeAggregatedStats(
    uid,
    workouts,
    maxHr,
    restingHr,
    races,
    currentFingerprint
  )
    .then((result) => {
      logAggregationEvent("complete", { uid, latestWorkoutId, lockKey });
      return result;
    })
    .catch((error: unknown) => {
      logAggregationEvent("error", {
        uid,
        latestWorkoutId,
        lockKey,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    })
    .finally(() => {
      if (aggregationInFlight.get(lockKey) === lockedPromise) {
        aggregationInFlight.delete(lockKey);
      }
    });

  aggregationInFlight.set(lockKey, lockedPromise);
  return lockedPromise;
}

export function useAggregatedStats(
  uid: string | null,
  workouts: HealthWorkout[],
  maxHr: number,
  restingHr: number,
  races: { raceDate: Date | string; distanceMiles: number }[],
  loadingState: AggregationLoadingState,
  options?: UseAggregatedStatsOptions
): UseAggregatedStatsResult {
  const enabled = options?.enabled ?? true;
  const [data, setData] = useState<AggregatedStatsDoc | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<Error | null>(null);

  const latestWorkoutStartTime = enabled
    ? workouts.reduce(
        (max, w) => Math.max(max, w.startDate.getTime()),
        0
      )
    : 0;
  const latestWorkoutId =
    enabled && workouts.length > 0
      ? workouts.reduce((latest, current) =>
          current.startDate > latest.startDate ? current : latest
        ).workoutId
      : null;
  const workoutAggregationRevision = useMemo(
    () =>
      enabled ? computeWorkoutAggregationRevision(workouts) : "disabled",
    [enabled, workouts]
  );
  const baseFingerprint = computeFreshnessFingerprint({
    latestWorkoutId,
    computationVersion: AGGREGATED_STATS_VERSION,
    maxHr,
    restingHr,
    activeRaceId: options?.activeRaceId ?? null,
    activeRaceDate: options?.activeRaceDate ?? null,
    overrides: options?.overrides ?? {},
  });
  const currentFingerprint: AggregatedStatsFreshnessFingerprint = {
    ...baseFingerprint,
    // The required schema has no separate workout revision field. Preserve the
    // override revision and append a revision of already-loaded fields used by
    // aggregation so same-id best-effort/load enrichment is not missed.
    overridesRevision: `${baseFingerprint.overridesRevision}:${workoutAggregationRevision}`,
  };
  const fingerprintRevision = JSON.stringify(currentFingerprint);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!isAggregationReady(uid, loadingState)) {
      setLoading(uid !== null);
      logAggregationEvent("skip-not-ready", {
        uid,
        latestWorkoutId,
        ...loadingState,
      });
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchAndComputeAggregatedStats(
      uid,
      workouts,
      maxHr,
      restingHr,
      races,
      currentFingerprint
    )
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
  }, [
    enabled,
    uid,
    latestWorkoutStartTime,
    fingerprintRevision,
    maxHr,
    restingHr,
    JSON.stringify(races),
    loadingState.workoutsLoading,
    loadingState.settingsLoading,
    loadingState.racesLoading,
  ]);

  return {
    data,
    loading: enabled ? loading : false,
    error: enabled ? error : null,
  };
}
