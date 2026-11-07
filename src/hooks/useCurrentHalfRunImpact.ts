"use client";

import { useMemo } from "react";
import { useAppData } from "@/contexts/AppDataContext";
import { computeCurrentHalfRunImpact, type CurrentHalfRunImpact } from "@/utils/currentHalfRunImpact";
import { useEstimateDay } from "@/components/insights/RacePerformancePanel";

export type CurrentImpactCard =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; impact: CurrentHalfRunImpact; notice: string | null };

const SOURCES = ["workouts", "overrides", "races"] as const;
const LABEL = { workouts: "workouts", overrides: "workout overrides", races: "race records" } as const;

/**
 * Current-estimate impact for the viewed run, derived synchronously from the
 * already-loaded shared AppData sources — the SAME raw workouts / races / overrides
 * Plan Insights feeds `RacePerformancePanel`. No Firestore access, no child reads,
 * and no async work, so a result can never outlive the run or data it was computed
 * for. The evaluation instant follows the panel's refresh rules (a fresh cutoff on
 * source publication or local-day change), so both surfaces use the same clock policy.
 */
export function useCurrentHalfRunImpact(
  runId: string,
  enabled: boolean,
  options: { asOf?: Date; timeZone?: string } = {},
): CurrentImpactCard | null {
  const { workouts, races, overrides, sourceHasLoaded, workoutsResolution, racesResolution, overridesResolution } = useAppData();
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = useEstimateDay(options.asOf !== undefined, timeZone);
  const ready = SOURCES.every(source => sourceHasLoaded[source]);
  const asOfIso = useMemo(() => options.asOf?.toISOString() ?? new Date().toISOString(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- These changes intentionally refresh the captured clock.
    [options.asOf, races, workouts, overrides, ready, day, timeZone]);

  return useMemo<CurrentImpactCard | null>(() => {
    if (!enabled) return null;
    const resolution = { workouts: workoutsResolution, overrides: overridesResolution, races: racesResolution };
    if (!ready) {
      const failed = SOURCES.filter(source => !sourceHasLoaded[source] && resolution[source] === "error");
      return failed.length
        ? { state: "error", message: `${failed.map(source => LABEL[source]).join(", ")} could not be loaded. Reload to retry.` }
        : { state: "loading" };
    }
    try {
      const impact = computeCurrentHalfRunImpact({ races, workouts, overrides, asOf: asOfIso, timeZone, runId });
      const stale = SOURCES.filter(source => resolution[source] === "error");
      return { state: "ready", impact, notice: stale.length
        ? `Showing previously loaded ${stale.map(source => LABEL[source]).join(", ")}. A refresh failed, so this may be out of date.` : null };
    } catch (error) {
      console.error("[currentHalfRunImpact]", error);
      return { state: "error", message: "The impact on the current estimate could not be calculated. Reload to retry." };
    }
  }, [enabled, ready, sourceHasLoaded, workoutsResolution, overridesResolution, racesResolution, races, workouts, overrides, asOfIso, timeZone, runId]);
}
