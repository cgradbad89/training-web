/**
 * Auto-match cross-training plan sessions against HealthKit workouts.
 *
 * Phase 2 of non-running plans. For each Workout / Pilates plan,
 * walk every planned session and try to find a HealthWorkout that
 * fell on the same calendar date and matches the activityType
 * filter for that session type. If found, mark the session
 * completed and persist via updatePlan().
 */

import { type HealthWorkout } from "@/types/healthWorkout";
import {
  type Plan,
  type WorkoutPlan,
  type PilatesPlan,
  type PlannedWorkoutEntry,
  type PlannedPilatesEntry,
  isWorkoutPlan,
  isPilatesPlan,
} from "@/types/plan";
import { updatePlan } from "@/services/plans";

// ─── Activity type filters ──────────────────────────────────────────────────

/**
 * Pilates / yoga / mind-body / flexibility raw HealthKit activity type
 * strings. Normalised to lowercase for comparison.
 */
const PILATES_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  "yoga",
  "mindandbody",
  "mind_and_body",
  "pilates",
  "flexibility",
  "cooldown",
]);

/** Returns true if the workout's raw activityType belongs to the pilates set. */
export function isPilatesActivity(w: HealthWorkout): boolean {
  return PILATES_ACTIVITY_TYPES.has(w.activityType.toLowerCase().trim());
}

/**
 * Returns true if the workout is a non-running, non-pilates strength /
 * functional / HIIT / OTF style workout — i.e. eligible to satisfy a
 * Workout plan session.
 */
export function isStrengthLikeActivity(w: HealthWorkout): boolean {
  if (w.isRunLike) return false;
  if (isPilatesActivity(w)) return false;
  return true;
}

// ─── Date helpers ───────────────────────────────────────────────────────────

function localISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function plannedSessionDate(
  planStartDate: string,
  weekIndex: number,
  weekday: number
): Date {
  const [year, month, day] = planStartDate.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const offset = weekIndex * 7 + (weekday - 1);
  const d = new Date(start);
  d.setDate(start.getDate() + offset);
  return d;
}

// ─── Match result types ─────────────────────────────────────────────────────

export interface AutoMatchResult {
  /** Number of sessions newly marked completed during this run */
  matched: number;
  /** Plans that were updated and persisted */
  updatedPlanIds: string[];
}

// ─── Core matcher ───────────────────────────────────────────────────────────

/**
 * Walk every Workout / Pilates plan and auto-mark matching sessions.
 *
 * - Skips sessions that are already `completed === true`
 * - Skips sessions whose planned date is in the future
 * - Each HealthWorkout can only satisfy one session per run (avoids
 *   double-counting if two sessions land on the same day)
 * - Persists each modified plan via updatePlan() and updates the
 *   provided plans array in place via the returned new objects.
 *
 * Returns the modified plans (running plans pass through unchanged) so
 * the caller can replace its state.
 */
export async function autoMatchCrossTrainingSessions(
  uid: string,
  plans: Plan[],
  healthWorkouts: HealthWorkout[]
): Promise<{ plans: Plan[]; result: AutoMatchResult }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Group HealthWorkouts by local calendar date for O(1) lookup.
  // Each entry holds workouts not yet consumed by a match this pass.
  const byDate = new Map<string, HealthWorkout[]>();
  for (const w of healthWorkouts) {
    const key = localISODate(w.startDate);
    const list = byDate.get(key);
    if (list) list.push(w);
    else byDate.set(key, [w]);
  }
  // Sort each bucket by startDate ascending so we consume oldest first
  for (const list of byDate.values()) {
    list.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  }

  const result: AutoMatchResult = { matched: 0, updatedPlanIds: [] };
  const nextPlans: Plan[] = [];

  for (const plan of plans) {
    if (!isWorkoutPlan(plan) && !isPilatesPlan(plan)) {
      nextPlans.push(plan);
      continue;
    }

    let planChanged = false;

    if (isWorkoutPlan(plan)) {
      const updatedWeeks = plan.weeks.map((week) => {
        const updatedEntries: PlannedWorkoutEntry[] = week.entries.map((entry) => {
          if (entry.type !== "workout") return entry;
          if (entry.completed === true) return entry;
          const sessionDate = plannedSessionDate(
            plan.startDate,
            entry.weekIndex,
            entry.weekday
          );
          if (sessionDate > today) return entry;

          const key = localISODate(sessionDate);
          const candidates = byDate.get(key);
          if (!candidates || candidates.length === 0) return entry;

          const matchIdx = candidates.findIndex(isStrengthLikeActivity);
          if (matchIdx === -1) return entry;

          const matched = candidates.splice(matchIdx, 1)[0];
          planChanged = true;
          result.matched += 1;
          console.log(
            `[AutoMatch] Workout session matched: ${plan.id} day ${entry.weekIndex * 7 + (entry.weekday - 1)} → ${matched.workoutId}`
          );
          return {
            ...entry,
            completed: true,
            completedAt: matched.startDate.toISOString(),
          };
        });
        return { ...week, entries: updatedEntries };
      });

      if (planChanged) {
        const updated: WorkoutPlan = { ...plan, weeks: updatedWeeks };
        try {
          await updatePlan(uid, updated);
          result.updatedPlanIds.push(plan.id);
          nextPlans.push(updated);
        } catch (err) {
          console.error("[AutoMatch] failed to persist workout plan", plan.id, err);
          nextPlans.push(plan);
        }
      } else {
        nextPlans.push(plan);
      }
    } else {
      // Pilates plan
      const updatedWeeks = plan.weeks.map((week) => {
        const updatedEntries: PlannedPilatesEntry[] = week.entries.map((entry) => {
          if (entry.type !== "pilates") return entry;
          if (entry.completed === true) return entry;
          const sessionDate = plannedSessionDate(
            plan.startDate,
            entry.weekIndex,
            entry.weekday
          );
          if (sessionDate > today) return entry;

          const key = localISODate(sessionDate);
          const candidates = byDate.get(key);
          if (!candidates || candidates.length === 0) return entry;

          const matchIdx = candidates.findIndex(isPilatesActivity);
          if (matchIdx === -1) return entry;

          const matched = candidates.splice(matchIdx, 1)[0];
          planChanged = true;
          result.matched += 1;
          console.log(
            `[AutoMatch] Pilates session matched: ${plan.id} day ${entry.weekIndex * 7 + (entry.weekday - 1)} → ${matched.workoutId}`
          );
          return {
            ...entry,
            completed: true,
            completedAt: matched.startDate.toISOString(),
          };
        });
        return { ...week, entries: updatedEntries };
      });

      if (planChanged) {
        const updated: PilatesPlan = { ...plan, weeks: updatedWeeks };
        try {
          await updatePlan(uid, updated);
          result.updatedPlanIds.push(plan.id);
          nextPlans.push(updated);
        } catch (err) {
          console.error("[AutoMatch] failed to persist pilates plan", plan.id, err);
          nextPlans.push(plan);
        }
      } else {
        nextPlans.push(plan);
      }
    }
  }

  return { plans: nextPlans, result };
}
