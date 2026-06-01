"use client";

import { useMemo } from "react";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type RunningShoe } from "@/types/shoe";
import { evaluateAutoAssignRules } from "@/utils/shoeAutoAssign";

/**
 * Pure shoe-assignment resolution, shared by the run detail page so it matches
 * the run listing page exactly (runs/page.tsx:776 `{ ...autoAssigned, ...manualMap }`).
 *
 * Precedence (manual always wins over auto):
 *  - manualMap[workoutId] === null  → null  (user explicitly chose "no shoe")
 *  - manualMap[workoutId] === shoeId → that shoeId
 *  - workoutId not in manualMap     → auto-assigned shoeId if a rule matches, else null
 *
 * The manual-null case is preserved because evaluateAutoAssignRules SKIPS any
 * workoutId already present as a key in the manual map (`if (workoutId in
 * existingAssignments) continue`), AND the `{ ...auto, ...manual }` spread lets
 * the manual value (including null) override any auto value.
 */
export function resolveShoeAssignment(
  workout: HealthWorkout | null,
  shoes: RunningShoe[],
  manualMap: Record<string, string | null>
): string | null {
  if (!workout) return null;
  const autoAssigned = evaluateAutoAssignRules([workout], shoes, manualMap);
  const merged: Record<string, string | null> = { ...autoAssigned, ...manualMap };
  return merged[workout.workoutId] ?? null;
}

/**
 * Hook wrapper around resolveShoeAssignment. Call unconditionally (all hooks
 * before any early return); pass workout=null before data loads and it returns
 * null safely.
 */
export function useResolvedShoeAssignment(
  workout: HealthWorkout | null,
  shoes: RunningShoe[],
  manualMap: Record<string, string | null>
): string | null {
  return useMemo(
    () => resolveShoeAssignment(workout, shoes, manualMap),
    [workout, shoes, manualMap]
  );
}
