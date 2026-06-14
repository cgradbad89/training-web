/**
 * Run plan-label wiring for the auto-title resolver (pure, in-memory).
 *
 * `resolveActivityTitle` accepts a pre-resolved `matchedPlanEntry` but never
 * does the matching itself. This module builds that context ONCE per loaded
 * {plan, workouts} set by inverting `matchPlanToActual` (entry→run) into a
 * run→entry map, so a render loop can look the label up per row in O(1)
 * WITHOUT re-running the (date+distance) matcher for every row.
 *
 * No Firestore reads/writes; the matcher's tolerances are reused verbatim.
 */

import {
  type Plan,
  type RunningPlan,
  type PlannedRunEntry,
  isRunningPlan,
} from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";
import { matchPlanToActual } from "@/utils/planMatching";
import { buildRunEntryLabel } from "@/utils/resolveActivityTitle";

/** The plan-entry context a surface feeds into `resolveActivityTitle`. */
export interface RunTitleContext {
  label: string;
  /** Planned distance — a fallback prefix when the run's own distance is absent. */
  distanceMiles: number;
}

/** The single in-progress running plan, or null. Mirrors the surfaces' own rule. */
export function findActiveRunningPlan(plans: Plan[]): RunningPlan | null {
  for (const p of plans) {
    if (isRunningPlan(p) && p.status === "active") return p;
  }
  return null;
}

/**
 * Map of workoutId → matched plan-entry title context for an active running
 * plan. Empty map when there is no plan. Memoize this over {plan, workouts} at
 * the surface; do NOT call it per render row.
 */
export function buildRunTitleMap(
  plan: RunningPlan | null | undefined,
  workouts: HealthWorkout[]
): Map<string, RunTitleContext> {
  const map = new Map<string, RunTitleContext>();
  if (!plan) return map;

  const entryById = new Map<string, PlannedRunEntry>();
  for (const week of plan.weeks) {
    for (const entry of week.entries) entryById.set(entry.id, entry);
  }

  const matchMap = matchPlanToActual(plan, workouts);
  for (const [entryId, match] of matchMap) {
    if (!match) continue;
    const entry = entryById.get(entryId);
    if (!entry) continue;
    map.set(match.activity.workoutId, {
      label: buildRunEntryLabel(entry),
      distanceMiles: entry.distanceMiles,
    });
  }
  return map;
}
