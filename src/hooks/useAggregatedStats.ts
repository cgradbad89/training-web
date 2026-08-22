import { useState, useEffect, useMemo, useRef } from "react";
import {
  doc,
  getDoc,
  getDocFromCache,
  getDocFromServer,
  setDoc,
} from "firebase/firestore";
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
  isVo2CacheInconsistent,
  isVo2Stale,
  reviveCompatibleAggregatedStats,
  reviveStoredAggregatedStats,
} from "@/utils/aggregatedStats";
import { getMileSplits } from "@/utils/mileSplitsCache";
import { buildVo2History, vo2HistoryCutoffISO } from "@/utils/vo2History";
import { collection, query, where, orderBy, getDocs } from "firebase/firestore";
import { fetchLatestVo2SampleDate } from "@/services/healthMetrics";
import {
  markClientPerformance,
  measureClientPerformance,
} from "@/hooks/useClientPerformanceMark";

function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

export interface UseAggregatedStatsResult {
  data: AggregatedStatsDoc | null;
  loading: boolean;
  error: Error | null;
}

export type AggregationPrerequisiteResolution =
  | "loading"
  | "success"
  | "error";

export interface AggregationPrerequisiteState {
  workouts: AggregationPrerequisiteResolution;
  settings: AggregationPrerequisiteResolution;
  races: AggregationPrerequisiteResolution;
  overrides: AggregationPrerequisiteResolution;
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
  prerequisiteState: AggregationPrerequisiteState
): uid is string {
  return (
    uid !== null &&
    prerequisiteState.workouts === "success" &&
    prerequisiteState.settings === "success" &&
    prerequisiteState.races === "success" &&
    prerequisiteState.overrides === "success"
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
  currentFingerprint: AggregatedStatsFreshnessFingerprint,
  cachedStatsPromise?: Promise<AggregatedStatsDoc | null>
): Promise<AggregatedStatsDoc> {
  const statsRef = doc(db, `users/${uid}/insights/aggregatedStats`);
  const loadCachedStats = async (): Promise<AggregatedStatsDoc | null> => {
    const statsSnap = await getDoc(statsRef);
    return statsSnap.exists()
      ? reviveStoredAggregatedStats(statsSnap.data())
      : null;
  };
  // These reads are independent. Starting them together removes one network
  // round-trip from every cold validation without adding Firestore reads.
  const [cached, latestVo2SampleDate] = await Promise.all([
    cachedStatsPromise ?? loadCachedStats(),
    fetchLatestVo2SampleDate(uid),
  ]);
  const currentVo2Key = computeVo2FreshnessKey(latestVo2SampleDate);
  const hasStoredVo2Baseline =
    cached !== null &&
    Object.prototype.hasOwnProperty.call(cached, "latestVo2SampleDate");
  const storedVo2Key = hasStoredVo2Baseline
    ? computeVo2FreshnessKey(cached.latestVo2SampleDate ?? null)
    : cached?.vo2FreshnessKey;
  const mainStale =
    !cached?.freshnessFingerprint ||
    isFingerprintStale(cached.freshnessFingerprint, currentFingerprint);
  const vo2Stale =
    !hasStoredVo2Baseline ||
    !cached?.vo2FreshnessKey ||
    !storedVo2Key ||
    isVo2Stale(storedVo2Key, currentVo2Key) ||
    isVo2Stale(cached.vo2FreshnessKey, currentVo2Key) ||
    isVo2CacheInconsistent(cached.vo2FreshnessKey, cached.vo2History);

  let healthMetrics: {
    id: string;
    data: { date?: string; vo2_max?: number };
  }[] = [];
  let currentVo2History = cached?.vo2History ?? [];
  let observedVo2Key = currentVo2Key;

  if (vo2Stale) {
    const cutoffStr = vo2HistoryCutoffISO(new Date());
    const metricsSnap = await getDocs(
      query(
        collection(db, `users/${uid}/healthMetrics`),
        where("date", ">=", cutoffStr),
        orderBy("date")
      )
    );
    healthMetrics = metricsSnap.docs.map((d) => ({
      id: d.id,
      data: d.data() as { date?: string; vo2_max?: number },
    }));
    currentVo2History = buildVo2History(healthMetrics);
    observedVo2Key = computeVo2FreshnessKey(
      currentVo2History.at(-1)?.date ?? null
    );
  }

  if (!mainStale && !vo2Stale) {
    return cached;
  }

  if (!mainStale && cached) {
    const vo2OnlyStats: AggregatedStatsDoc = {
      ...cached,
      computedAt: new Date().toISOString(),
      vo2History: currentVo2History,
      vo2FreshnessKey: observedVo2Key,
      latestVo2SampleDate: observedVo2Key.latestVo2SampleDate,
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
    vo2FreshnessKey: observedVo2Key,
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
  currentFingerprint: AggregatedStatsFreshnessFingerprint,
  cachedStatsPromise?: Promise<AggregatedStatsDoc | null>
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

  const lockedPromise = computeAggregatedStats(
    uid,
    workouts,
    maxHr,
    restingHr,
    races,
    currentFingerprint,
    cachedStatsPromise
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
  prerequisiteState: AggregationPrerequisiteState,
  options?: UseAggregatedStatsOptions
): UseAggregatedStatsResult {
  const enabled = options?.enabled ?? true;
  const [dataState, setDataState] = useState<{
    uid: string;
    data: AggregatedStatsDoc;
  } | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<Error | null>(null);
  const [cacheResolvedUid, setCacheResolvedUid] = useState<string | null>(null);
  const data = dataState?.uid === uid ? dataState.data : null;
  const serverStatsRef = useRef<{
    uid: string;
    promise: Promise<AggregatedStatsDoc | null>;
  } | null>(null);
  const cachePresentedRef = useRef<{ uid: string; presented: boolean } | null>(
    null
  );

  // Hydrate from IndexedDB as soon as auth is available, then replace it with
  // the server document in the background. Validation still waits for
  // workouts/settings/races/overrides and reuses that same server promise, so
  // the cache-first presentation path adds no billable Firestore read.
  useEffect(() => {
    if (!enabled || !uid) {
      serverStatsRef.current = null;
      return;
    }

    let cancelled = false;
    let serverSettled = false;
    cachePresentedRef.current = { uid, presented: false };
    queueMicrotask(() => {
      if (!cancelled) {
        setLoading(true);
        setError(null);
      }
    });

    const statsRef = doc(db, `users/${uid}/insights/aggregatedStats`);
    const serverPromise = getDocFromServer(statsRef).then((statsSnap) =>
      statsSnap.exists()
        ? reviveStoredAggregatedStats(statsSnap.data())
        : null
    );
    serverStatsRef.current = { uid, promise: serverPromise };

    getDocFromCache(statsRef)
      .then((cached) => {
        if (cancelled || serverSettled || !cached.exists()) return;
        const cachedData = reviveCompatibleAggregatedStats(cached.data());
        if (!cachedData) return;
        cachePresentedRef.current = { uid, presented: true };
        markClientPerformance("training:personal-insights:cache-visible", {
          cacheSource: "local-cache",
        });
        setCacheResolvedUid(uid);
        setDataState({ uid, data: cachedData });
        setLoading(false);
      })
      .catch(() => {
        // Cache misses, unsupported IndexedDB, and corrupt local documents are
        // presentation misses only. The authoritative server path below still
        // handles first-time and recovery loads.
      });

    serverPromise
      .then((serverData) => {
        serverSettled = true;
        if (cancelled) return;
        setCacheResolvedUid(uid);
        const compatibleServerData =
          serverData?.computationVersion === AGGREGATED_STATS_VERSION
            ? serverData
            : null;
        if (compatibleServerData) {
          setDataState({ uid, data: compatibleServerData });
          setLoading(false);
        } else if (!cachePresentedRef.current?.presented) {
          setLoading(true);
        }
      })
      .catch((err) => {
        serverSettled = true;
        if (!cancelled) {
          setCacheResolvedUid(uid);
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, uid]);

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

    if (!isAggregationReady(uid, prerequisiteState)) {
      logAggregationEvent("skip-not-ready", {
        uid,
        latestWorkoutId,
        ...prerequisiteState,
      });
      return;
    }

    let cancelled = false;

    const cachedStatsPromise =
      serverStatsRef.current?.uid === uid
        ? serverStatsRef.current.promise
        : undefined;
    const validationStartMark = "training:insights-aggregate:start";
    const validationEndMark = "training:insights-aggregate:ready";
    markClientPerformance(validationStartMark);

    fetchAndComputeAggregatedStats(
      uid,
      workouts,
      maxHr,
      restingHr,
      races,
      currentFingerprint,
      cachedStatsPromise
    )
      .then((result) => {
        markClientPerformance(validationEndMark, { status: "success" });
        measureClientPerformance(
          "training:insights-aggregate:duration",
          validationStartMark,
          validationEndMark,
          { status: "success" }
        );
        if (!cancelled) {
          markClientPerformance("training:personal-insights:data-ready", {
            cacheSource:
              cachePresentedRef.current?.uid === uid &&
              cachePresentedRef.current.presented
                ? "local-cache"
                : "server",
          });
          setDataState({ uid, data: result });
          setError(null);
          setLoading(false);
        }
      })
      .catch((err) => {
        markClientPerformance(validationEndMark, { status: "error" });
        measureClientPerformance(
          "training:insights-aggregate:duration",
          validationStartMark,
          validationEndMark,
          { status: "error" }
        );
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
    prerequisiteState.workouts,
    prerequisiteState.settings,
    prerequisiteState.races,
    prerequisiteState.overrides,
  ]);

  return {
    data,
    loading:
      enabled && uid !== null
        ? cacheResolvedUid !== uid || loading
        : false,
    error: enabled ? error : null,
  };
}
