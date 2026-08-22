"use client";

/**
 * AppDataContext — single shared source for the cross-page domain data that
 * every auth-guarded route previously fetched independently on mount
 * (workouts, plans, races, workout overrides, and user settings / HR anchors).
 *
 * Before this context, dashboard, personal-insights, plan-insights, runs, and
 * shoes each opened their own Firestore reads for the same collections, with
 * no shared cache — five workout reads, four plans reads, and so on per app
 * session. The provider consolidates those into one read per collection,
 * mounted once at the (app) route-group layout.
 *
 * Design constraints (do not regress):
 *  - Workouts use a full getDocs read (limit 1000) on mount and manual refresh.
 *    Same-local-day focus refreshes use a seven-day overlap delta; the first
 *    eligible focus on a later local day performs another full reconciliation.
 *    Every consumer (dashboard, runs, personal-insights, plan-insights, shoes,
 *    workouts) reads the same array.
 *  - Overrides are exposed as the raw Record keyed by workoutId (matching how
 *    every page consumes them: `overrides[workout.workoutId]`). Pages apply
 *    overrides themselves via applyOverride — the context does not pre-apply.
 *  - `patchOverrides` preserves the optimistic-update UX that dashboard/runs
 *    relied on (they mutated a local override map immediately after a write).
 *  - `userSettings` is exposed raw (not only maxHr/restingHr) because runs and
 *    workouts feed the whole object to useEnrichTrainingLoads.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  fetchHealthWorkouts,
  fetchHealthWorkoutsInRange,
} from "@/services/healthWorkouts";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import {
  markClientPerformance,
  useClientPerformanceMark,
} from "@/hooks/useClientPerformanceMark";
import { fetchPlans } from "@/services/plans";
import { fetchRaces } from "@/services/races";
import { fetchAllOverrides } from "@/services/workoutOverrides";
import { fetchUserSettings } from "@/services/userSettings";
import { resolveMaxHr, resolveRestingHr } from "@/utils/trainingLoad";
import { toLocalIsoDate } from "@/utils/dates";
import {
  type HealthWorkout,
  type TrainingLoadFields,
} from "@/types/healthWorkout";
import { type Plan } from "@/types/plan";
import { type Race } from "@/types/race";
import { type WorkoutOverride } from "@/types/workoutOverride";
import { type UserSettings } from "@/types/userSettings";

/** Shared workouts read limit. Raised from 500 to 1000 when workouts/page.tsx
 *  moved from its own server-filtered (isRunLike==false, limit 500) query to
 *  filtering this shared array client-side — without the higher cap, a
 *  heavy-run user's non-run history could fall outside the shared top-N
 *  window that used to be reserved for non-runs alone. */
export const APP_DATA_WORKOUTS_LIMIT = 1000;
export const WORKOUT_DELTA_OVERLAP_DAYS = 7;

export type AppDataResolution = "loading" | "success" | "error";
type WorkoutRefreshMode = "full" | "delta";

interface WorkoutRefreshRequest {
  mode: WorkoutRefreshMode;
  promise: Promise<void>;
}

export function workoutDeltaStartDate(latestWorkoutDate: Date): Date {
  return new Date(
    latestWorkoutDate.getTime() -
      WORKOUT_DELTA_OVERLAP_DAYS * 24 * 60 * 60 * 1000
  );
}

export function mergeWorkoutDelta(
  current: HealthWorkout[],
  incoming: HealthWorkout[],
  limitCount: number = APP_DATA_WORKOUTS_LIMIT
): HealthWorkout[] {
  const byId = new Map(current.map((workout) => [workout.workoutId, workout]));
  for (const workout of incoming) byId.set(workout.workoutId, workout);
  return [...byId.values()]
    .sort((a, b) => b.startDate.getTime() - a.startDate.getTime())
    .slice(0, limitCount);
}

export interface AppDataContextValue {
  workouts: HealthWorkout[];
  /** True only while the first successful workouts load is pending. */
  workoutsLoading: boolean;
  workoutsResolution: AppDataResolution;
  /** True during a later background/manual workouts refresh. */
  workoutsRefreshing: boolean;
  /** True when the latest full read returned fewer than its cap. */
  workoutsHistoryComplete: boolean;
  /** Advances after each successful full reconciliation so AutoMatch can
   *  re-evaluate due sessions after an old-dated delayed insert. */
  workoutsFullReconciliationVersion: number;
  /** Explicit user refresh: always a full top-1000 reconciliation. */
  refreshWorkouts: () => Promise<void>;
  plans: Plan[];
  plansLoading: boolean;
  plansResolution: AppDataResolution;
  races: Race[];
  racesLoading: boolean;
  racesResolution: AppDataResolution;
  /** Raw override map keyed by workoutId. Pages apply via applyOverride. */
  overrides: Record<string, WorkoutOverride>;
  overridesLoading: boolean;
  overridesResolution: AppDataResolution;
  /** Raw settings doc — needed by useEnrichTrainingLoads (runs/workouts). */
  userSettings: UserSettings | null;
  maxHr: number;
  restingHr: number;
  settingsLoading: boolean;
  settingsResolution: AppDataResolution;
  refreshPlans: () => Promise<void>;
  refreshRaces: () => Promise<void>;
  refreshOverrides: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  /** Optimistic local override mutation (post-write UX), mirrors the old
   *  per-page `setOverrides((prev) => ...)` calls. */
  patchOverrides: (
    updater: (prev: Record<string, WorkoutOverride>) => Record<string, WorkoutOverride>
  ) => void;
  /** Local-only targeted publication after the matching enrichment merge write
   *  succeeds. Raw source identity, ordering, and all unrelated fields remain. */
  patchTrainingLoad: (
    workoutId: string,
    patch: TrainingLoadFields
  ) => void;
}

const AppDataContext = createContext<AppDataContextValue | null>(null);

export function AppDataProvider({
  children,
  uid,
}: {
  children: React.ReactNode;
  uid: string;
}) {
  return (
    <AppDataProviderGeneration key={uid} uid={uid}>
      {children}
    </AppDataProviderGeneration>
  );
}

/**
 * One generation owns one UID. The outer keyed boundary makes the invariant
 * hold even when a caller forgets to key the provider itself; the app layout
 * also keys AppDataProvider explicitly as the primary lifecycle boundary.
 */
function AppDataProviderGeneration({
  children,
  uid,
}: {
  children: React.ReactNode;
  uid: string;
}) {
  const [workouts, setWorkouts] = useState<HealthWorkout[]>([]);
  const [workoutsLoading, setWorkoutsLoading] = useState(true);
  const [workoutsResolution, setWorkoutsResolution] =
    useState<AppDataResolution>("loading");
  const [workoutsRefreshing, setWorkoutsRefreshing] = useState(false);
  const [workoutsHistoryComplete, setWorkoutsHistoryComplete] = useState(false);
  const [
    workoutsFullReconciliationVersion,
    setWorkoutsFullReconciliationVersion,
  ] = useState(0);
  const workoutsLoadedRef = useRef(false);
  const workoutsInFlightRef = useRef<WorkoutRefreshRequest | null>(null);
  const workoutsQueuedFullRef = useRef<Promise<void> | null>(null);
  const lastSuccessfulFullDateRef = useRef<string | null>(null);
  const workoutsRef = useRef<HealthWorkout[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansResolution, setPlansResolution] =
    useState<AppDataResolution>("loading");
  const [races, setRaces] = useState<Race[]>([]);
  const [racesLoading, setRacesLoading] = useState(true);
  const [racesResolution, setRacesResolution] =
    useState<AppDataResolution>("loading");
  const [overrides, setOverrides] = useState<Record<string, WorkoutOverride>>({});
  const [overridesLoading, setOverridesLoading] = useState(true);
  const [overridesResolution, setOverridesResolution] =
    useState<AppDataResolution>("loading");
  const [userSettings, setUserSettings] = useState<UserSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsResolution, setSettingsResolution] =
    useState<AppDataResolution>("loading");
  const requestGenerationRef = useRef(0);
  const activeUidRef = useRef<string | null>(uid);

  const isCurrentRequest = useCallback(
    (requestUid: string, generation: number): boolean =>
      activeUidRef.current === requestUid &&
      requestGenerationRef.current === generation,
    []
  );

  useEffect(() => {
    return () => {
      activeUidRef.current = null;
      requestGenerationRef.current += 1;
      workoutsInFlightRef.current = null;
      workoutsQueuedFullRef.current = null;
      lastSuccessfulFullDateRef.current = null;
      workoutsRef.current = [];
    };
  }, []);
  const appDataReady =
    workoutsResolution === "success" &&
    plansResolution === "success" &&
    racesResolution === "success" &&
    overridesResolution === "success" &&
    settingsResolution === "success";

  useEffect(() => {
    markClientPerformance("training:app-data:start");
  }, [uid]);
  useClientPerformanceMark("training:app-data:ready", appDataReady, {
    measureFrom: "training:app-data:start",
    measureName: "training:app-data:duration",
  });

  workoutsRef.current = workouts;

  const startWorkoutRefresh = useCallback(
    (mode: WorkoutRefreshMode): Promise<void> => {
      const requestUid = uid;
      const generation = requestGenerationRef.current;
      if (!isCurrentRequest(requestUid, generation)) return Promise.resolve();

      if (!uid) {
        setWorkouts([]);
        setWorkoutsLoading(false);
        setWorkoutsRefreshing(false);
        setWorkoutsHistoryComplete(true);
        setWorkoutsResolution("success");
        workoutsLoadedRef.current = true;
        return Promise.resolve();
      }

      const isInitialLoad = !workoutsLoadedRef.current;
      if (isInitialLoad) setWorkoutsLoading(true);
      else setWorkoutsRefreshing(true);
      setWorkoutsResolution("loading");

      const promise = (async () => {
        try {
          if (mode === "full") {
            const loaded = await fetchHealthWorkouts(requestUid, {
              limitCount: APP_DATA_WORKOUTS_LIMIT,
            });
            if (!isCurrentRequest(requestUid, generation)) return;
            setWorkouts(loaded);
            setWorkoutsHistoryComplete(
              loaded.length < APP_DATA_WORKOUTS_LIMIT
            );
            lastSuccessfulFullDateRef.current = toLocalIsoDate(new Date());
            setWorkoutsFullReconciliationVersion((current) => current + 1);
            workoutsLoadedRef.current = true;
          } else {
            const latestWorkout = workoutsRef.current[0];
            const delta = await fetchHealthWorkoutsInRange(
              requestUid,
              workoutDeltaStartDate(latestWorkout?.startDate ?? new Date())
            );
            if (!isCurrentRequest(requestUid, generation)) return;
            setWorkouts((current) => mergeWorkoutDelta(current, delta));
          }
          setWorkoutsResolution("success");
        } catch (err) {
          if (!isCurrentRequest(requestUid, generation)) return;
          setWorkoutsResolution("error");
          console.error(
            mode === "full"
              ? "[AppData] fetchHealthWorkouts"
              : "[AppData] refreshRecentWorkouts",
            err
          );
        } finally {
          if (!isCurrentRequest(requestUid, generation)) return;
          if (isInitialLoad) setWorkoutsLoading(false);
          else setWorkoutsRefreshing(false);
        }
      })();

      const request = { mode, promise };
      workoutsInFlightRef.current = request;
      const clearRequest = () => {
        if (workoutsInFlightRef.current === request) {
          workoutsInFlightRef.current = null;
        }
      };
      void promise.then(clearRequest, clearRequest);
      return promise;
    },
    [isCurrentRequest, uid]
  );

  const requestWorkoutRefresh = useCallback(
    (mode: WorkoutRefreshMode): Promise<void> => {
      const active = workoutsInFlightRef.current;
      if (!active) return startWorkoutRefresh(mode);

      // A full request already satisfies either caller. A delta caller can
      // reuse any active read. Only full-behind-delta needs queued promotion.
      if (active.mode === "full" || mode === "delta") {
        return active.promise;
      }
      if (workoutsQueuedFullRef.current) {
        return workoutsQueuedFullRef.current;
      }

      const requestUid = uid;
      const generation = requestGenerationRef.current;
      const queued = active.promise.then(() => {
        if (!isCurrentRequest(requestUid, generation)) return;
        return startWorkoutRefresh("full");
      });
      workoutsQueuedFullRef.current = queued;
      const clearQueued = () => {
        if (workoutsQueuedFullRef.current === queued) {
          workoutsQueuedFullRef.current = null;
        }
      };
      void queued.then(clearQueued, clearQueued);
      return queued;
    },
    [isCurrentRequest, startWorkoutRefresh, uid]
  );

  // Public/manual action: always reconcile the authoritative shared top 1000.
  const refreshWorkouts = useCallback(
    (): Promise<void> => requestWorkoutRefresh("full"),
    [requestWorkoutRefresh]
  );

  useEffect(() => {
    void refreshWorkouts();
  }, [refreshWorkouts]);

  // Same-day focus stays on the seven-day overlap delta. The first eligible
  // focus after the local date rolls over performs one full reconciliation;
  // only a successful full advances the provider-lifetime in-memory marker.
  const refreshWorkoutsOnFocus = useCallback((): Promise<void> => {
    const today = toLocalIsoDate(new Date());
    const mode: WorkoutRefreshMode =
      lastSuccessfulFullDateRef.current === today ? "delta" : "full";
    return requestWorkoutRefresh(mode);
  }, [requestWorkoutRefresh]);

  useRefetchOnFocus(refreshWorkoutsOnFocus);

  const refreshPlans = useCallback(async () => {
    const requestUid = uid;
    const generation = requestGenerationRef.current;
    if (!isCurrentRequest(requestUid, generation)) return;
    if (!uid) {
      setPlans([]);
      setPlansLoading(false);
      setPlansResolution("success");
      return;
    }
    setPlansLoading(true);
    setPlansResolution("loading");
    try {
      const loaded = await fetchPlans(requestUid);
      if (!isCurrentRequest(requestUid, generation)) return;
      setPlans(loaded);
      setPlansResolution("success");
    } catch (err) {
      if (!isCurrentRequest(requestUid, generation)) return;
      setPlansResolution("error");
      console.error("[AppData] fetchPlans", err);
    } finally {
      if (!isCurrentRequest(requestUid, generation)) return;
      setPlansLoading(false);
    }
  }, [isCurrentRequest, uid]);

  const refreshRaces = useCallback(async () => {
    const requestUid = uid;
    const generation = requestGenerationRef.current;
    if (!isCurrentRequest(requestUid, generation)) return;
    if (!uid) {
      setRaces([]);
      setRacesLoading(false);
      setRacesResolution("success");
      return;
    }
    setRacesLoading(true);
    setRacesResolution("loading");
    try {
      const loaded = await fetchRaces(requestUid);
      if (!isCurrentRequest(requestUid, generation)) return;
      setRaces(loaded);
      setRacesResolution("success");
    } catch (err) {
      if (!isCurrentRequest(requestUid, generation)) return;
      setRacesResolution("error");
      console.error("[AppData] fetchRaces", err);
    } finally {
      if (!isCurrentRequest(requestUid, generation)) return;
      setRacesLoading(false);
    }
  }, [isCurrentRequest, uid]);

  const refreshOverrides = useCallback(async () => {
    const requestUid = uid;
    const generation = requestGenerationRef.current;
    if (!isCurrentRequest(requestUid, generation)) return;
    if (!uid) {
      setOverrides({});
      setOverridesLoading(false);
      setOverridesResolution("success");
      return;
    }
    setOverridesLoading(true);
    setOverridesResolution("loading");
    try {
      const loaded = await fetchAllOverrides(requestUid);
      if (!isCurrentRequest(requestUid, generation)) return;
      setOverrides(loaded);
      setOverridesResolution("success");
    } catch (err) {
      if (!isCurrentRequest(requestUid, generation)) return;
      setOverridesResolution("error");
      console.error("[AppData] fetchAllOverrides", err);
    } finally {
      if (!isCurrentRequest(requestUid, generation)) return;
      setOverridesLoading(false);
    }
  }, [isCurrentRequest, uid]);

  const refreshSettings = useCallback(async () => {
    const requestUid = uid;
    const generation = requestGenerationRef.current;
    if (!isCurrentRequest(requestUid, generation)) return;
    if (!uid) {
      setUserSettings(null);
      setSettingsLoading(false);
      setSettingsResolution("success");
      return;
    }
    setSettingsLoading(true);
    setSettingsResolution("loading");
    try {
      const loaded = await fetchUserSettings(requestUid);
      if (!isCurrentRequest(requestUid, generation)) return;
      setUserSettings(loaded ?? null);
      setSettingsResolution("success");
    } catch (err) {
      if (!isCurrentRequest(requestUid, generation)) return;
      setSettingsResolution("error");
      console.error("[AppData] fetchUserSettings", err);
    } finally {
      if (!isCurrentRequest(requestUid, generation)) return;
      setSettingsLoading(false);
    }
  }, [isCurrentRequest, uid]);

  useEffect(() => {
    void refreshPlans();
  }, [refreshPlans]);
  useEffect(() => {
    void refreshRaces();
  }, [refreshRaces]);
  useEffect(() => {
    void refreshOverrides();
  }, [refreshOverrides]);
  useEffect(() => {
    void refreshSettings();
  }, [refreshSettings]);

  const patchOverrides = useCallback(
    (
      updater: (
        prev: Record<string, WorkoutOverride>
      ) => Record<string, WorkoutOverride>
    ) => {
      const generation = requestGenerationRef.current;
      if (isCurrentRequest(uid, generation)) setOverrides(updater);
    },
    [isCurrentRequest, uid]
  );

  const patchTrainingLoad = useCallback(
    (workoutId: string, patch: TrainingLoadFields) => {
      const generation = requestGenerationRef.current;
      if (!isCurrentRequest(uid, generation)) return;
      setWorkouts((current) => {
        const index = current.findIndex(
          (workout) => workout.workoutId === workoutId
        );
        if (index < 0) return current;
        return current.map((workout, workoutIndex) =>
          workoutIndex === index ? { ...workout, ...patch } : workout
        );
      });
    },
    [isCurrentRequest, uid]
  );

  const maxHr = resolveMaxHr(userSettings);
  const restingHr = resolveRestingHr(userSettings);

  const value = useMemo<AppDataContextValue>(
    () => ({
      workouts,
      workoutsLoading,
      workoutsResolution,
      workoutsRefreshing,
      workoutsHistoryComplete,
      workoutsFullReconciliationVersion,
      refreshWorkouts,
      plans,
      plansLoading,
      plansResolution,
      races,
      racesLoading,
      racesResolution,
      overrides,
      overridesLoading,
      overridesResolution,
      userSettings,
      maxHr,
      restingHr,
      settingsLoading,
      settingsResolution,
      refreshPlans,
      refreshRaces,
      refreshOverrides,
      refreshSettings,
      patchOverrides,
      patchTrainingLoad,
    }),
    [
      workouts,
      workoutsLoading,
      workoutsResolution,
      workoutsRefreshing,
      workoutsHistoryComplete,
      workoutsFullReconciliationVersion,
      refreshWorkouts,
      plans,
      plansLoading,
      plansResolution,
      races,
      racesLoading,
      racesResolution,
      overrides,
      overridesLoading,
      overridesResolution,
      userSettings,
      maxHr,
      restingHr,
      settingsLoading,
      settingsResolution,
      refreshPlans,
      refreshRaces,
      refreshOverrides,
      refreshSettings,
      patchOverrides,
      patchTrainingLoad,
    ]
  );

  return (
    <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>
  );
}

export function useAppData(): AppDataContextValue {
  const ctx = useContext(AppDataContext);
  if (!ctx) {
    throw new Error("useAppData must be used within an AppDataProvider");
  }
  return ctx;
}
