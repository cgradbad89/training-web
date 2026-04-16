/**
 * Auto-match cross-training plan sessions against HealthKit workouts.
 *
 * For each WorkoutPlan, walk every planned session and try to find a
 * HealthWorkout that fell on the same calendar date and matches the
 * activityType filter for that session's flavor (exercise-based vs
 * duration-only). If found, mark the session completed and persist.
 *
 * Duration-only sessions (exercises empty, duration_mins set) are the
 * former Pilates plan type — they match yoga/pilates/mind-body/
 * flexibility activity types.
 */

import { type HealthWorkout } from "@/types/healthWorkout";
import {
  type Plan,
  type WorkoutPlan,
  type PlannedWorkoutEntry,
  isWorkoutPlan,
  isDurationOnlyEntry,
  WORKOUT_CATEGORY_HK_TYPES,
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
 * functional / HIIT / OTF style workout — i.e. eligible to satisfy an
 * exercise-based Workout plan session.
 */
export function isStrengthLikeActivity(w: HealthWorkout): boolean {
  if (w.isRunLike) return false;
  if (isPilatesActivity(w)) return false;
  return true;
}

// ─── Category-aware predicate ────────────────────────────────────────────────

type MatchPredicate = ((workout: HealthWorkout) => boolean) | 'legacy';

/**
 * Returns the match predicate for a session.
 *
 * - Sessions with a category use category-specific HK type matching.
 * - OTF sessions match any non-running workout (OTF logs inconsistently).
 * - Sessions without a category return 'legacy' — use old behavior.
 */
function getMatchPredicate(session: PlannedWorkoutEntry): MatchPredicate {
  if (session.category) {
    if (session.category === 'orangetheory') {
      // Match any non-running workout — OTF logs inconsistently
      return (workout: HealthWorkout) => !workout.isRunLike;
    }
    const hkTypes = WORKOUT_CATEGORY_HK_TYPES[session.category];
    return (workout: HealthWorkout) =>
      !workout.isRunLike &&
      hkTypes.some(
        (t) => t.toLowerCase() === workout.activityType.toLowerCase().trim()
      );
  }
  return 'legacy';
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
 * Walk every WorkoutPlan and auto-mark matching sessions.
 *
 * - Skips sessions already `completed === true`
 * - Skips sessions whose planned date is in the future
 * - Each HealthWorkout can only satisfy one session per run
 * - Duration-only sessions match yoga/pilates/mind-body activity types
 * - Exercise-based sessions match any other non-running workout
 * - Running plans and orphaned legacy pilates plans pass through unchanged
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
    if (!isWorkoutPlan(plan)) {
      // Running plans and legacy pilates plans pass through unchanged.
      nextPlans.push(plan);
      continue;
    }

    let planChanged = false;

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

        // Determine predicate: category-aware or legacy.
        const matchPredicate = getMatchPredicate(entry);

        const predicate: (w: HealthWorkout) => boolean =
          matchPredicate === 'legacy'
            ? isDurationOnlyEntry(entry)
              ? isPilatesActivity
              : isStrengthLikeActivity
            : matchPredicate;

        const matchIdx = candidates.findIndex(predicate);
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
  }

  return { plans: nextPlans, result };
}
