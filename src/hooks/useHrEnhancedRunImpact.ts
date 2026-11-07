"use client";

import { useMemo } from "react";
import { useAppData } from "@/contexts/AppDataContext";
import { computeHrEnhancedRunImpact, type HrEnhancedRunImpact } from "@/utils/hrEnhancedRunImpact";
import { useEstimateDay } from "@/components/insights/RacePerformancePanel";

export type HrImpactCard =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; impact: HrEnhancedRunImpact };

const SOURCES = ["workouts", "overrides", "races"] as const;

/**
 * HR-enhanced impact for the viewed run, derived synchronously from the same already-loaded shared
 * sources (and the same clock policy) as `useCurrentHalfRunImpact`. No Firestore access, no child reads.
 */
export function useHrEnhancedRunImpact(
  runId: string,
  enabled: boolean,
  options: { asOf?: Date; timeZone?: string } = {},
): HrImpactCard | null {
  const { workouts, races, overrides, sourceHasLoaded } = useAppData();
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = useEstimateDay(options.asOf !== undefined, timeZone);
  const ready = SOURCES.every(source => sourceHasLoaded[source]);
  const asOfIso = useMemo(() => options.asOf?.toISOString() ?? new Date().toISOString(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- These changes intentionally refresh the captured clock.
    [options.asOf, races, workouts, overrides, ready, day, timeZone]);
  return useMemo<HrImpactCard | null>(() => {
    if (!enabled) return null;
    if (!ready) return { state: "loading" };
    try {
      return { state: "ready", impact: computeHrEnhancedRunImpact({ races, workouts, overrides, asOf: asOfIso, timeZone, runId }) };
    } catch (error) {
      console.error("[hrEnhancedRunImpact]", error);
      return { state: "error", message: "The HR-enhanced impact could not be calculated." };
    }
  }, [enabled, ready, races, workouts, overrides, asOfIso, timeZone, runId]);
}
