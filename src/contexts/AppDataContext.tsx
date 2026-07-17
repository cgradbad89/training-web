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
 *  - Workouts are fetched ONCE per mount (getDocs, limit 1000) rather than via
 *    a live onSnapshot listener — historical data doesn't need continuous
 *    push. Freshness comes from useRefetchOnFocus (tab-focus refetch, 30s
 *    floor) plus each consumer's own manual refresh control. Every consumer
 *    (dashboard, runs, personal-insights, plan-insights, shoes, workouts)
 *    reads the same array.
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
  useState,
} from "react";
import { useAuth } from "@/hooks/useAuth";
import { fetchHealthWorkouts } from "@/services/healthWorkouts";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { fetchPlans } from "@/services/plans";
import { fetchRaces } from "@/services/races";
import { fetchAllOverrides } from "@/services/workoutOverrides";
import { fetchUserSettings } from "@/services/userSettings";
import { resolveMaxHr, resolveRestingHr } from "@/utils/trainingLoad";
import { type HealthWorkout } from "@/types/healthWorkout";
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

export interface AppDataContextValue {
  workouts: HealthWorkout[];
  workoutsLoading: boolean;
  refreshWorkouts: () => Promise<void>;
  plans: Plan[];
  plansLoading: boolean;
  races: Race[];
  racesLoading: boolean;
  /** Raw override map keyed by workoutId. Pages apply via applyOverride. */
  overrides: Record<string, WorkoutOverride>;
  overridesLoading: boolean;
  /** Raw settings doc — needed by useEnrichTrainingLoads (runs/workouts). */
  userSettings: UserSettings | null;
  maxHr: number;
  restingHr: number;
  settingsLoading: boolean;
  refreshPlans: () => Promise<void>;
  refreshOverrides: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  /** Optimistic local override mutation (post-write UX), mirrors the old
   *  per-page `setOverrides((prev) => ...)` calls. */
  patchOverrides: (
    updater: (prev: Record<string, WorkoutOverride>) => Record<string, WorkoutOverride>
  ) => void;
}

const AppDataContext = createContext<AppDataContextValue | null>(null);

export function AppDataProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [workouts, setWorkouts] = useState<HealthWorkout[]>([]);
  const [workoutsLoading, setWorkoutsLoading] = useState(true);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [races, setRaces] = useState<Race[]>([]);
  const [racesLoading, setRacesLoading] = useState(true);
  const [overrides, setOverrides] = useState<Record<string, WorkoutOverride>>({});
  const [overridesLoading, setOverridesLoading] = useState(true);
  const [userSettings, setUserSettings] = useState<UserSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);

  // One-time workouts fetch — the single shared workouts source for every
  // consumer (dashboard, runs, personal-insights, plan-insights, shoes,
  // workouts). Freshness comes from useRefetchOnFocus below plus each
  // consumer's manual refresh control, not a live subscription.
  const refreshWorkouts = useCallback(async () => {
    if (!uid) {
      setWorkouts([]);
      setWorkoutsLoading(false);
      return;
    }
    setWorkoutsLoading(true);
    try {
      setWorkouts(
        await fetchHealthWorkouts(uid, { limitCount: APP_DATA_WORKOUTS_LIMIT })
      );
    } catch (err) {
      console.error("[AppData] fetchHealthWorkouts", err);
    } finally {
      setWorkoutsLoading(false);
    }
  }, [uid]);

  useEffect(() => {
    void refreshWorkouts();
  }, [refreshWorkouts]);

  useRefetchOnFocus(refreshWorkouts);

  const refreshPlans = useCallback(async () => {
    if (!uid) {
      setPlans([]);
      setPlansLoading(false);
      return;
    }
    setPlansLoading(true);
    try {
      setPlans(await fetchPlans(uid));
    } catch (err) {
      console.error("[AppData] fetchPlans", err);
    } finally {
      setPlansLoading(false);
    }
  }, [uid]);

  const refreshRaces = useCallback(async () => {
    if (!uid) {
      setRaces([]);
      setRacesLoading(false);
      return;
    }
    setRacesLoading(true);
    try {
      setRaces(await fetchRaces(uid));
    } catch (err) {
      console.error("[AppData] fetchRaces", err);
    } finally {
      setRacesLoading(false);
    }
  }, [uid]);

  const refreshOverrides = useCallback(async () => {
    if (!uid) {
      setOverrides({});
      setOverridesLoading(false);
      return;
    }
    setOverridesLoading(true);
    try {
      setOverrides(await fetchAllOverrides(uid));
    } catch (err) {
      console.error("[AppData] fetchAllOverrides", err);
    } finally {
      setOverridesLoading(false);
    }
  }, [uid]);

  const refreshSettings = useCallback(async () => {
    if (!uid) {
      setUserSettings(null);
      setSettingsLoading(false);
      return;
    }
    setSettingsLoading(true);
    try {
      setUserSettings((await fetchUserSettings(uid)) ?? null);
    } catch (err) {
      console.error("[AppData] fetchUserSettings", err);
    } finally {
      setSettingsLoading(false);
    }
  }, [uid]);

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
    ) => setOverrides(updater),
    []
  );

  const maxHr = resolveMaxHr(userSettings);
  const restingHr = resolveRestingHr(userSettings);

  const value = useMemo<AppDataContextValue>(
    () => ({
      workouts,
      workoutsLoading,
      refreshWorkouts,
      plans,
      plansLoading,
      races,
      racesLoading,
      overrides,
      overridesLoading,
      userSettings,
      maxHr,
      restingHr,
      settingsLoading,
      refreshPlans,
      refreshOverrides,
      refreshSettings,
      patchOverrides,
    }),
    [
      workouts,
      workoutsLoading,
      refreshWorkouts,
      plans,
      plansLoading,
      races,
      racesLoading,
      overrides,
      overridesLoading,
      userSettings,
      maxHr,
      restingHr,
      settingsLoading,
      refreshPlans,
      refreshOverrides,
      refreshSettings,
      patchOverrides,
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
