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

  // Mutable buffers per plan so the two-pass loop can update individual
  // entries in place. plan.weeks.map(w => [...w.entries]) shallow-copies the
  // entry arrays while leaving the entry objects intact (we replace them by
  // index when a match is found). planChangedMap tracks whether any pass
  // mutated this plan, so we only persist real changes.
  const planEntries = new Map<string, PlannedWorkoutEntry[][]>();
  const planChangedMap = new Map<string, boolean>();
  for (const plan of plans) {
    if (!isWorkoutPlan(plan)) continue;
    planEntries.set(
      plan.id,
      plan.weeks.map((w) => [...w.entries])
    );
    planChangedMap.set(plan.id, false);
  }

  /**
   * Attempt to match a single PlannedWorkoutEntry from the shared byDate
   * pool. Returns either an updated (completed) entry or null when no
   * candidate is found. Shared by both passes so the matching contract
   * (predicate, consumption, logs) stays identical.
   */
  function tryMatch(
    entry: PlannedWorkoutEntry,
    plan: WorkoutPlan
  ): PlannedWorkoutEntry | null {
    if (entry.type !== "workout") return null;
    if (entry.completed === true) return null;
    const sessionDate = plannedSessionDate(
      plan.startDate,
      entry.weekIndex,
      entry.weekday
    );
    if (sessionDate > today) return null;

    const key = localISODate(sessionDate);
    const candidates = byDate.get(key);

    // Debug — fires whenever there's a same-day candidate to consider OR the
    // session is a 'strength' category (so we log even no-candidate days for
    // that category which was the original regression vector).
    if (entry.category === 'strength' || candidates) {
      // eslint-disable-next-line no-console
      console.log('[autoMatch] checking session:', {
        sessionDate: key,
        category: entry.category ?? '(legacy)',
        planId: plan.id,
        weekIndex: entry.weekIndex,
        weekday: entry.weekday,
        candidateWorkouts: (candidates ?? []).map((w) => ({
          workoutId: w.workoutId,
          date: localISODate(w.startDate),
          activityType: w.activityType,
          isRunLike: w.isRunLike,
        })),
      });
    }

    if (!candidates || candidates.length === 0) return null;

    // Determine predicate: category-aware or legacy.
    const matchPredicate = getMatchPredicate(entry);
    const predicate: (w: HealthWorkout) => boolean =
      matchPredicate === 'legacy'
        ? isDurationOnlyEntry(entry)
          ? isPilatesActivity
          : isStrengthLikeActivity
        : matchPredicate;

    const matchIdx = candidates.findIndex(predicate);
    if (matchIdx === -1) {
      // eslint-disable-next-line no-console
      console.log('[autoMatch] no match for session', {
        sessionDate: key,
        category: entry.category ?? '(legacy)',
        candidateActivityTypes: candidates.map((w) => w.activityType),
      });
      return null;
    }

    const matched = candidates.splice(matchIdx, 1)[0];
    result.matched += 1;
    console.log(
      `[AutoMatch] Workout session matched: ${plan.id} day ${entry.weekIndex * 7 + (entry.weekday - 1)} → ${matched.workoutId}`
    );
    return {
      ...entry,
      completed: true,
      completedAt: matched.startDate.toISOString(),
    };
  }

  /**
   * Run one pass across every workout plan, attempting to match entries that
   * satisfy `entryFilter`. Pass 1 = non-OTF (specific categories); Pass 2 =
   * OTF only. The byDate pool persists between passes, so anything Pass 1
   * consumes is unavailable to Pass 2. Net effect: a same-day strength
   * session can't starve a same-day OTF session — OTF only ever claims
   * leftovers, which is also a tighter behaviour for the most permissive
   * (!isRunLike) predicate.
   */
  function runPass(entryFilter: (e: PlannedWorkoutEntry) => boolean) {
    for (const plan of plans) {
      if (!isWorkoutPlan(plan)) continue;
      const weeksEntries = planEntries.get(plan.id);
      if (!weeksEntries) continue;
      for (let wi = 0; wi < weeksEntries.length; wi++) {
        const entries = weeksEntries[wi];
        for (let ei = 0; ei < entries.length; ei++) {
          const entry = entries[ei];
          if (!entryFilter(entry)) continue;
          const matched = tryMatch(entry, plan);
          if (matched) {
            entries[ei] = matched;
            planChangedMap.set(plan.id, true);
          }
        }
      }
    }
  }

  // Pass 1 — every category EXCEPT OTF. Strict predicates consume their
  // workouts from byDate first.
  runPass((e) => e.category !== 'orangetheory');
  // Pass 2 — OTF only. Picks from whatever Pass 1 left behind via the same
  // (w) => !w.isRunLike predicate.
  runPass((e) => e.category === 'orangetheory');

  const nextPlans: Plan[] = [];
  for (const plan of plans) {
    if (!isWorkoutPlan(plan)) {
      // Running plans and legacy pilates plans pass through unchanged.
      nextPlans.push(plan);
      continue;
    }
    if (!planChangedMap.get(plan.id)) {
      nextPlans.push(plan);
      continue;
    }
    const weeksEntries = planEntries.get(plan.id);
    if (!weeksEntries) {
      nextPlans.push(plan);
      continue;
    }
    const updatedWeeks = plan.weeks.map((week, wi) => ({
      ...week,
      entries: weeksEntries[wi],
    }));
    const updated: WorkoutPlan = { ...plan, weeks: updatedWeeks };
    try {
      await updatePlan(uid, updated);
      result.updatedPlanIds.push(plan.id);
      nextPlans.push(updated);
    } catch (err) {
      console.error("[AutoMatch] failed to persist workout plan", plan.id, err);
      nextPlans.push(plan);
    }
  }

  return { plans: nextPlans, result };
}
