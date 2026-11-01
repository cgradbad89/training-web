"use client";

import { useCallback } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useAppData } from "@/contexts/AppDataContext";
import {
  createManualActivity,
  deleteManualActivity,
  ManualActivityError,
  updateManualActivity,
  type ManualActivityUpdateResult,
} from "@/services/manualActivities";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type ManualActivityInput } from "@/utils/manualActivity";

/**
 * Manual activity writes plus their shared-state publication. Publishing happens
 * only after a write succeeds, so every AppData consumer (Dashboard, Runs,
 * Workouts, calendar, Insights, Coach) updates at once with no extra reads.
 */
export function useManualActivityActions() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const { publishWorkout, removeWorkout, patchOverrides, patchPlan } = useAppData();

  const requireUid = useCallback((): string => {
    if (!uid) throw new ManualActivityError("unauthorized", "Please sign in again to change activities.");
    return uid;
  }, [uid]);

  const create = useCallback(
    async (input: ManualActivityInput, idempotencyId: string): Promise<HealthWorkout> => {
      const workout = await createManualActivity(requireUid(), input, idempotencyId);
      publishWorkout(workout);
      return workout;
    },
    [publishWorkout, requireUid]
  );

  const update = useCallback(
    async (workoutId: string, input: ManualActivityInput): Promise<ManualActivityUpdateResult> => {
      const result = await updateManualActivity(requireUid(), workoutId, input);
      publishWorkout(result.workout);
      const nextOverride = result.override;
      if (nextOverride === null) {
        patchOverrides((prev) => {
          const next = { ...prev };
          delete next[workoutId];
          return next;
        });
      } else if (nextOverride !== undefined) {
        patchOverrides((prev) => ({ ...prev, [workoutId]: nextOverride }));
      }
      result.plans.forEach(patchPlan);
      return result;
    },
    [patchOverrides, patchPlan, publishWorkout, requireUid]
  );

  const remove = useCallback(
    async (workoutId: string): Promise<void> => {
      const result = await deleteManualActivity(requireUid(), workoutId);
      removeWorkout(workoutId);
      if (result.overrideRemoved) {
        patchOverrides((prev) => {
          const next = { ...prev };
          delete next[workoutId];
          return next;
        });
      }
      result.plans.forEach(patchPlan);
    },
    [patchOverrides, patchPlan, removeWorkout, requireUid]
  );

  return { create, update, remove };
}
