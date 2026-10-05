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
 * owned lazily for one authenticated session at the (app) layout.
 *
 * Design constraints (do not regress):
 *  - Workouts use a full getDocs read (limit 1000) on first training activation
 *    and manual refresh.
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
export const WORKOUT_AUTO_REFRESH_INTERVAL_MS = 30000;
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

interface AppDataRefreshOptions {
  afterMutation?: boolean;
}

export interface AppDataContextValue {
  /** Health-only sessions never activate the canonical training loaders. */
  trainingActivated: boolean;
  trainingActive: boolean;
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
  plansRefreshing: boolean;
  races: Race[];
  racesLoading: boolean;
  racesResolution: AppDataResolution;
  racesRefreshing: boolean;
  /** Raw override map keyed by workoutId. Pages apply via applyOverride. */
  overrides: Record<string, WorkoutOverride>;
  overridesLoading: boolean;
  overridesResolution: AppDataResolution;
  overridesRefreshing: boolean;
  /** Raw settings doc — needed by useEnrichTrainingLoads (runs/workouts). */
  userSettings: UserSettings | null;
  maxHr: number;
  restingHr: number;
  settingsLoading: boolean;
  settingsResolution: AppDataResolution;
  settingsRefreshing: boolean;
  refreshPlans: (options?: AppDataRefreshOptions) => Promise<void>;
  /** Persistence-first targeted publication of a saved plan. */
  patchPlan: (plan: Plan) => void;
  refreshRaces: (options?: AppDataRefreshOptions) => Promise<void>;
  refreshOverrides: (options?: AppDataRefreshOptions) => Promise<void>;
  refreshSettings: (options?: AppDataRefreshOptions) => Promise<void>;
  /** Persistence-first shared race mutation. Failed writes must never call it. */
  patchRaces: (updater: (prev: Race[]) => Race[]) => void;
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

interface AppDataProviderProps {
  children: React.ReactNode;
  uid: string;
  trainingActive?: boolean;
  sessionEpoch?: number;
  /** Invalidates async work synchronously in the existing auth observer. */
  isSessionCurrent?: (epoch: number) => boolean;
}

export function AppDataProvider({
  children,
  uid,
  trainingActive = true,
  sessionEpoch = 0,
  isSessionCurrent,
}: AppDataProviderProps) {
  return (
    <AppDataProviderGeneration
      key={`${uid}:${sessionEpoch}`}
      uid={uid}
      trainingActive={trainingActive}
      sessionEpoch={sessionEpoch}
      isSessionCurrent={isSessionCurrent}
    >
      {children}
    </AppDataProviderGeneration>
  );
}

/** One keyed owner per authenticated session; route activity never resets it. */
function AppDataProviderGeneration({
  children,
  uid,
  trainingActive,
  sessionEpoch,
  isSessionCurrent,
}: Required<Pick<AppDataProviderProps, "trainingActive" | "sessionEpoch">> & AppDataProviderProps) {
  const [activationVersion, setActivationVersion] = useState(0);
  const trainingActivated = activationVersion > 0;
  const activatedRef = useRef(false);
  const wasTrainingActiveRef = useRef(false);
  const lastAutomaticWorkoutRefreshRef = useRef<number | null>(null);
  const [workouts, setWorkouts] = useState<HealthWorkout[]>([]);
  const [workoutsLoading, setWorkoutsLoading] = useState(trainingActive);
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
  const workoutsPendingPatchesRef = useRef(new Map<string, TrainingLoadFields>());
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(trainingActive);
  const [plansResolution, setPlansResolution] =
    useState<AppDataResolution>("loading");
  const [plansRefreshing, setPlansRefreshing] = useState(false);
  const plansLoadedRef = useRef(false);
  const plansInFlightRef = useRef<Promise<void> | null>(null);
  const plansMutationVersionRef = useRef(0);
  const plansQueuedRefreshRef = useRef<Promise<void> | null>(null);
  const [races, setRaces] = useState<Race[]>([]);
  const [racesLoading, setRacesLoading] = useState(trainingActive);
  const [racesResolution, setRacesResolution] =
    useState<AppDataResolution>("loading");
  const [racesRefreshing, setRacesRefreshing] = useState(false);
  const racesLoadedRef = useRef(false);
  const racesInFlightRef = useRef<Promise<void> | null>(null);
  const racesMutationVersionRef = useRef(0);
  const racesQueuedRefreshRef = useRef<Promise<void> | null>(null);
  const [overrides, setOverrides] = useState<Record<string, WorkoutOverride>>({});
  const [overridesLoading, setOverridesLoading] = useState(trainingActive);
  const [overridesResolution, setOverridesResolution] =
    useState<AppDataResolution>("loading");
  const [overridesRefreshing, setOverridesRefreshing] = useState(false);
  const overridesLoadedRef = useRef(false);
  const overridesInFlightRef = useRef<Promise<void> | null>(null);
  const overridesMutationVersionRef = useRef(0);
  const overridesQueuedRefreshRef = useRef<Promise<void> | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(trainingActive);
  const [settingsResolution, setSettingsResolution] =
    useState<AppDataResolution>("loading");
  const [settingsRefreshing, setSettingsRefreshing] = useState(false);
  const settingsLoadedRef = useRef(false);
  const settingsInFlightRef = useRef<Promise<void> | null>(null);
  const settingsMutationVersionRef = useRef(0);
  const settingsQueuedRefreshRef = useRef<Promise<void> | null>(null);
  const requestGenerationRef = useRef(0);
  const activeUidRef = useRef<string | null>(uid);

  const isCurrentRequest = useCallback(
    (requestUid: string, generation: number): boolean =>
      activeUidRef.current === requestUid &&
      requestGenerationRef.current === generation &&
      (!isSessionCurrent || isSessionCurrent(sessionEpoch)),
    [isSessionCurrent, sessionEpoch]
  );

  // Return/consumer reads reuse pending sources. A refresh requested after a
  // persisted mutation must observe that write, so it queues one newer read.
  const requestSourceRefresh = useCallback((
    start: () => Promise<void>,
    inFlight: React.RefObject<Promise<void> | null>,
    queuedRef: React.RefObject<Promise<void> | null>,
    mutationVersion: React.RefObject<number>,
    afterMutation: boolean = false
  ): Promise<void> => {
    const generation = requestGenerationRef.current;
    if (!isCurrentRequest(uid, generation)) return Promise.resolve();
    if (afterMutation) mutationVersion.current += 1;
    if (!afterMutation || !inFlight.current) return start();
    if (queuedRef.current) return queuedRef.current;
    const queued = inFlight.current.then(() => {
      if (queuedRef.current === queued) queuedRef.current = null;
      if (!isCurrentRequest(uid, generation)) return;
      return start();
    });
    queuedRef.current = queued;
    return queued;
  }, [isCurrentRequest, uid]);

  useEffect(() => {
    // Every setup owns this keyed UID, including Strict Mode's second setup.
    // Cleanup still invalidates all earlier requests; replay must restore
    // ownership before the data effects start their new generation's reads.
    activeUidRef.current = uid;
    const pendingWorkoutPatches = workoutsPendingPatchesRef.current;
    return () => {
      activeUidRef.current = null;
      activatedRef.current = false;
      wasTrainingActiveRef.current = false;
      lastAutomaticWorkoutRefreshRef.current = null;
      plansInFlightRef.current = null;
      plansQueuedRefreshRef.current = null;
      racesInFlightRef.current = null;
      racesQueuedRefreshRef.current = null;
      overridesInFlightRef.current = null;
      overridesQueuedRefreshRef.current = null;
      settingsInFlightRef.current = null;
      settingsQueuedRefreshRef.current = null;
      requestGenerationRef.current += 1;
      workoutsInFlightRef.current = null;
      workoutsQueuedFullRef.current = null;
      lastSuccessfulFullDateRef.current = null;
      workoutsRef.current = [];
      pendingWorkoutPatches.clear();
    };
  }, [uid]);
  const appDataReady =
    workoutsResolution === "success" &&
    plansResolution === "success" &&
    racesResolution === "success" &&
    overridesResolution === "success" &&
    settingsResolution === "success";

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

      lastAutomaticWorkoutRefreshRef.current = Date.now();
      workoutsPendingPatchesRef.current.clear();
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
            setWorkouts(loaded.map(workout => {
              const patch = workoutsPendingPatchesRef.current.get(workout.workoutId);
              return patch ? { ...workout, ...patch } : workout;
            }));
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
            const patchedDelta = delta.map(workout => {
              const patch = workoutsPendingPatchesRef.current.get(workout.workoutId);
              return patch ? { ...workout, ...patch } : workout;
            });
            setWorkouts((current) => mergeWorkoutDelta(current, patchedDelta));
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
          workoutsPendingPatchesRef.current.clear();
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

  // Same-day focus stays on the seven-day overlap delta. The first eligible
  // focus after the local date rolls over performs one full reconciliation;
  // only a successful full advances the provider-lifetime in-memory marker.
  const refreshWorkoutsOnFocus = useCallback((): Promise<void> => {
    if (!trainingActive || !activatedRef.current) return Promise.resolve();
    const today = toLocalIsoDate(new Date());
    const mode: WorkoutRefreshMode =
      lastSuccessfulFullDateRef.current === today ? "delta" : "full";
    // Return and visibility share one floor and one request coordinator. Later
    // local-day full reconciliation is never downgraded to a same-day delta.
    if (mode === "delta" && !workoutsInFlightRef.current &&
        lastAutomaticWorkoutRefreshRef.current !== null &&
        Date.now() - lastAutomaticWorkoutRefreshRef.current < WORKOUT_AUTO_REFRESH_INTERVAL_MS) {
      return Promise.resolve();
    }
    return requestWorkoutRefresh(mode);
  }, [requestWorkoutRefresh, trainingActive]);

  useRefetchOnFocus(refreshWorkoutsOnFocus, WORKOUT_AUTO_REFRESH_INTERVAL_MS, trainingActive);

  const loadPlans = useCallback((): Promise<void> => {
    const requestUid = uid;
    const generation = requestGenerationRef.current;
    if (!isCurrentRequest(requestUid, generation)) return Promise.resolve();
    if (plansInFlightRef.current) return plansInFlightRef.current;
    const mutationVersion = plansMutationVersionRef.current;
    const isInitialLoad = !plansLoadedRef.current;
    if (isInitialLoad) setPlansLoading(true);
    else setPlansRefreshing(true);
    setPlansResolution("loading");
    const promise = (async () => {
      try {
        const loaded = uid ? await fetchPlans(requestUid) : [];
        if (!isCurrentRequest(requestUid, generation)) return;
        if (plansMutationVersionRef.current !== mutationVersion) return;
        setPlans(loaded);
        plansLoadedRef.current = true;
        setPlansResolution("success");
      } catch (err) {
        if (!isCurrentRequest(requestUid, generation)) return;
        setPlansResolution("error");
        console.error("[AppData] fetchPlans", err);
      } finally {
        if (!isCurrentRequest(requestUid, generation)) return;
        setPlansLoading(false);
        setPlansRefreshing(false);
      }
    })();
    plansInFlightRef.current = promise;
    const clearRequest = () => {
      if (plansInFlightRef.current === promise) plansInFlightRef.current = null;
    };
    void promise.then(clearRequest, clearRequest);
    return promise;
  }, [isCurrentRequest, uid]);

  const refreshPlans = useCallback((options?: AppDataRefreshOptions) =>
    requestSourceRefresh(loadPlans, plansInFlightRef, plansQueuedRefreshRef, plansMutationVersionRef, options?.afterMutation),
    [loadPlans, requestSourceRefresh]);

  const loadRaces = useCallback((): Promise<void> => {
    const requestUid = uid;
    const generation = requestGenerationRef.current;
    if (!isCurrentRequest(requestUid, generation)) return Promise.resolve();
    if (racesInFlightRef.current) return racesInFlightRef.current;
    const mutationVersion = racesMutationVersionRef.current;
    const isInitialLoad = !racesLoadedRef.current;
    if (isInitialLoad) setRacesLoading(true);
    else setRacesRefreshing(true);
    setRacesResolution("loading");
    const promise = (async () => {
      try {
        const loaded = uid ? await fetchRaces(requestUid) : [];
        if (!isCurrentRequest(requestUid, generation)) return;
        if (racesMutationVersionRef.current !== mutationVersion) return;
        setRaces(loaded);
        racesLoadedRef.current = true;
        setRacesResolution("success");
      } catch (err) {
        if (!isCurrentRequest(requestUid, generation)) return;
        setRacesResolution("error");
        console.error("[AppData] fetchRaces", err);
      } finally {
        if (!isCurrentRequest(requestUid, generation)) return;
        setRacesLoading(false);
        setRacesRefreshing(false);
      }
    })();
    racesInFlightRef.current = promise;
    const clearRequest = () => {
      if (racesInFlightRef.current === promise) racesInFlightRef.current = null;
    };
    void promise.then(clearRequest, clearRequest);
    return promise;
  }, [isCurrentRequest, uid]);

  const refreshRaces = useCallback((options?: AppDataRefreshOptions) =>
    requestSourceRefresh(loadRaces, racesInFlightRef, racesQueuedRefreshRef, racesMutationVersionRef, options?.afterMutation),
    [loadRaces, requestSourceRefresh]);

  const loadOverrides = useCallback((): Promise<void> => {
    const requestUid = uid;
    const generation = requestGenerationRef.current;
    if (!isCurrentRequest(requestUid, generation)) return Promise.resolve();
    if (overridesInFlightRef.current) return overridesInFlightRef.current;
    const mutationVersion = overridesMutationVersionRef.current;
    const isInitialLoad = !overridesLoadedRef.current;
    if (isInitialLoad) setOverridesLoading(true);
    else setOverridesRefreshing(true);
    setOverridesResolution("loading");
    const promise = (async () => {
      try {
        const loaded = uid ? await fetchAllOverrides(requestUid) : {};
        if (!isCurrentRequest(requestUid, generation)) return;
        if (overridesMutationVersionRef.current !== mutationVersion) return;
        setOverrides(loaded);
        overridesLoadedRef.current = true;
        setOverridesResolution("success");
      } catch (err) {
        if (!isCurrentRequest(requestUid, generation)) return;
        setOverridesResolution("error");
        console.error("[AppData] fetchAllOverrides", err);
      } finally {
        if (!isCurrentRequest(requestUid, generation)) return;
        setOverridesLoading(false);
        setOverridesRefreshing(false);
      }
    })();
    overridesInFlightRef.current = promise;
    const clearRequest = () => {
      if (overridesInFlightRef.current === promise) overridesInFlightRef.current = null;
    };
    void promise.then(clearRequest, clearRequest);
    return promise;
  }, [isCurrentRequest, uid]);

  const refreshOverrides = useCallback((options?: AppDataRefreshOptions) =>
    requestSourceRefresh(loadOverrides, overridesInFlightRef, overridesQueuedRefreshRef, overridesMutationVersionRef, options?.afterMutation),
    [loadOverrides, requestSourceRefresh]);

  const loadSettings = useCallback((): Promise<void> => {
    const requestUid = uid;
    const generation = requestGenerationRef.current;
    if (!isCurrentRequest(requestUid, generation)) return Promise.resolve();
    if (settingsInFlightRef.current) return settingsInFlightRef.current;
    const mutationVersion = settingsMutationVersionRef.current;
    const isInitialLoad = !settingsLoadedRef.current;
    if (isInitialLoad) setSettingsLoading(true);
    else setSettingsRefreshing(true);
    setSettingsResolution("loading");
    const promise = (async () => {
      try {
        const loaded = uid ? await fetchUserSettings(requestUid) : null;
        if (!isCurrentRequest(requestUid, generation)) return;
        if (settingsMutationVersionRef.current !== mutationVersion) return;
        setUserSettings(loaded ?? null);
        settingsLoadedRef.current = true;
        setSettingsResolution("success");
      } catch (err) {
        if (!isCurrentRequest(requestUid, generation)) return;
        setSettingsResolution("error");
        console.error("[AppData] fetchUserSettings", err);
      } finally {
        if (!isCurrentRequest(requestUid, generation)) return;
        setSettingsLoading(false);
        setSettingsRefreshing(false);
      }
    })();
    settingsInFlightRef.current = promise;
    const clearRequest = () => {
      if (settingsInFlightRef.current === promise) settingsInFlightRef.current = null;
    };
    void promise.then(clearRequest, clearRequest);
    return promise;
  }, [isCurrentRequest, uid]);

  const refreshSettings = useCallback((options?: AppDataRefreshOptions) =>
    requestSourceRefresh(loadSettings, settingsInFlightRef, settingsQueuedRefreshRef, settingsMutationVersionRef, options?.afterMutation),
    [loadSettings, requestSourceRefresh]);

  useEffect(() => {
    const wasActive = wasTrainingActiveRef.current;
    wasTrainingActiveRef.current = trainingActive;
    if (!trainingActive) return;
    if (!activatedRef.current) {
      activatedRef.current = true;
      setActivationVersion(current => current + 1);
      markClientPerformance("training:app-data:start");
      void refreshWorkouts();
    } else if (!wasActive) {
      setActivationVersion(current => current + 1);
      markClientPerformance("training:app-data:resume");
      void refreshWorkoutsOnFocus();
    } else {
      return;
    }
    // All canonical sources retain their existing initialization parallelism.
    // Returning from Health revalidates P/R/O/H without a cold loading flag.
    void refreshPlans();
    void refreshRaces();
    void refreshOverrides();
    void refreshSettings();
  }, [trainingActive, refreshWorkouts, refreshWorkoutsOnFocus, refreshPlans,
      refreshRaces, refreshOverrides, refreshSettings]);

  const patchOverrides = useCallback(
    (
      updater: (
        prev: Record<string, WorkoutOverride>
      ) => Record<string, WorkoutOverride>
    ) => {
      const generation = requestGenerationRef.current;
      if (!isCurrentRequest(uid, generation)) return;
      if (overridesInFlightRef.current) void refreshOverrides({ afterMutation: true });
      setOverrides(updater);
    },
    [isCurrentRequest, refreshOverrides, uid]
  );

  const patchRaces = useCallback(
    (updater: (prev: Race[]) => Race[]) => {
      const generation = requestGenerationRef.current;
      if (!isCurrentRequest(uid, generation)) return;
      if (racesInFlightRef.current) void refreshRaces({ afterMutation: true });
      setRaces(updater);
    },
    [isCurrentRequest, refreshRaces, uid]
  );

  const patchPlan = useCallback(
    (savedPlan: Plan) => {
      const generation = requestGenerationRef.current;
      if (!isCurrentRequest(uid, generation)) return;
      if (plansInFlightRef.current) void refreshPlans({ afterMutation: true });
      setPlans((current) => {
        const exists = current.some((plan) => plan.id === savedPlan.id);
        if (!exists) return [...current, savedPlan];
        return current.map((plan) =>
          plan.id === savedPlan.id ? savedPlan : plan
        );
      });
    },
    [isCurrentRequest, refreshPlans, uid]
  );

  const patchTrainingLoad = useCallback(
    (workoutId: string, patch: TrainingLoadFields) => {
      const generation = requestGenerationRef.current;
      if (!isCurrentRequest(uid, generation)) return;
      // A source snapshot requested before the persisted enrichment must not
      // overwrite that successful local publication when it arrives later.
      if (workoutsInFlightRef.current && workoutsRef.current.some(w => w.workoutId === workoutId)) {
        workoutsPendingPatchesRef.current.set(workoutId, {
          ...workoutsPendingPatchesRef.current.get(workoutId), ...patch,
        });
      }
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

  // The first training render from a dormant Health owner is still cold.
  const awaitingActivation = trainingActive && !trainingActivated;
  // Wait for the explicit plan return read before recreating AutoMatch; arrays
  // remain usable, and activationVersion commits this barrier even if reads
  // resolve to the exact same resident objects.
  const resuming = trainingActive && activatedRef.current && !wasTrainingActiveRef.current;
  const effectivePlansResolution = resuming ? "loading" : plansResolution;
  const value = useMemo<AppDataContextValue>(
    () => ({
      trainingActivated,
      trainingActive,
      workouts,
      workoutsLoading: workoutsLoading || awaitingActivation,
      workoutsResolution,
      workoutsRefreshing,
      workoutsHistoryComplete,
      workoutsFullReconciliationVersion,
      refreshWorkouts,
      plans,
      plansLoading: plansLoading || awaitingActivation,
      plansResolution: effectivePlansResolution,
      plansRefreshing,
      races,
      racesLoading: racesLoading || awaitingActivation,
      racesResolution,
      racesRefreshing,
      overrides,
      overridesLoading: overridesLoading || awaitingActivation,
      overridesResolution,
      overridesRefreshing,
      userSettings,
      maxHr,
      restingHr,
      settingsLoading: settingsLoading || awaitingActivation,
      settingsResolution,
      settingsRefreshing,
      refreshPlans,
      patchPlan,
      refreshRaces,
      refreshOverrides,
      refreshSettings,
      patchRaces,
      patchOverrides,
      patchTrainingLoad,
    }),
    [
      awaitingActivation,
      trainingActivated,
      trainingActive,
      workouts,
      workoutsLoading,
      workoutsResolution,
      workoutsRefreshing,
      workoutsHistoryComplete,
      workoutsFullReconciliationVersion,
      refreshWorkouts,
      plans,
      plansLoading,
      effectivePlansResolution,
      plansRefreshing,
      races,
      racesLoading,
      racesResolution,
      racesRefreshing,
      overrides,
      overridesLoading,
      overridesResolution,
      overridesRefreshing,
      userSettings,
      maxHr,
      restingHr,
      settingsLoading,
      settingsResolution,
      settingsRefreshing,
      refreshPlans,
      patchPlan,
      refreshRaces,
      refreshOverrides,
      refreshSettings,
      patchRaces,
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
