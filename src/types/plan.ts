// ─── Running plan types (existing — unchanged) ──────────────────────────────

export type PlanRunType = "outdoor" | "treadmill" | "otf" | "longRun" | "rest";

export interface PlannedRunEntry {
  id: string;
  weekIndex: number;   // 0-based week index into the plan
  weekday: number;     // 1=Mon, 2=Tue, … 7=Sun
  dayOfWeek: number;   // 0=Mon … 6=Sun (legacy alias, weekday - 1)
  distanceMiles: number;
  paceTarget?: string; // e.g. "10:30"
  runType?: PlanRunType;
  description?: string;
  notes?: string;
  targetHeartRate?: number | null;
  workoutType?: "easy" | "tempo" | "long" | "race" | "rest" | "cross";
}

export interface PlanWeek {
  weekNumber: number; // 1-based
  entries: PlannedRunEntry[];
  notes?: string;
}

export interface RunningPlan {
  id: string;
  name: string;
  /** Discriminator. Existing docs without this field default to "running". */
  planType?: "running";
  startDate: string; // ISO date (Monday-normalized)
  weeks: PlanWeek[];
  isActive: boolean;
  isBuiltInDefault?: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Workout plan types (unified — includes former Pilates) ─────────────────

export interface PlanExercise {
  id: string;
  name: string;
  sets: number;
  reps: number;
  weight_lbs: number;
}

/**
 * A single planned workout day.
 *
 * Two modes:
 *   1. Exercise-based (`exercises` non-empty) — strength / HIIT / OTF.
 *      Auto-matches against any non-running, non-yoga-like HealthKit workout.
 *   2. Duration-only (`exercises` empty AND `duration_mins` present) —
 *      what used to be the separate Pilates plan type. Auto-matches against
 *      yoga/pilates/mind-body/flexibility HealthKit workouts.
 */
export interface PlannedWorkoutEntry {
  id: string;
  weekIndex: number;
  weekday: number;     // 1=Mon … 7=Sun
  dayOfWeek: number;
  type: "rest" | "workout";
  label?: string;          // e.g. "Upper Body", "Reformer Pilates"
  notes?: string;
  exercises?: PlanExercise[];
  /** Duration for duration-only sessions (e.g. pilates, yoga, cardio). */
  duration_mins?: number;
  completed?: boolean;
  completedAt?: string;
}

export interface PlanWorkoutWeek {
  weekNumber: number;
  entries: PlannedWorkoutEntry[];
  notes?: string;
}

export interface WorkoutPlan {
  id: string;
  name: string;
  planType: "workout";
  startDate: string;
  weeks: PlanWorkoutWeek[];
  isActive: boolean;
  /** Optional link to a race in users/{uid}/races */
  raceId?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Legacy: orphaned Pilates plans ─────────────────────────────────────────

/**
 * Old Pilates plan shape kept ONLY so we can detect and display an
 * "unsupported, please delete" message for any orphaned documents in
 * Firestore. No code path creates or edits these anymore.
 */
export interface LegacyPilatesPlan {
  id: string;
  name: string;
  planType: "pilates";
  startDate: string;
  weeks: Array<{ weekNumber: number; entries: unknown[]; notes?: string }>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Discriminated union ─────────────────────────────────────────────────────

export type Plan = RunningPlan | WorkoutPlan | LegacyPilatesPlan;

export type PlanType = "running" | "workout";

/** Type guards for narrowing the discriminated union. */
export function isRunningPlan(plan: Plan): plan is RunningPlan {
  return plan.planType === undefined || plan.planType === "running";
}

export function isWorkoutPlan(plan: Plan): plan is WorkoutPlan {
  return plan.planType === "workout";
}

export function isLegacyPilatesPlan(plan: Plan): plan is LegacyPilatesPlan {
  return plan.planType === "pilates";
}

/** True when the session should be treated as duration-only (ex-Pilates). */
export function isDurationOnlyEntry(entry: PlannedWorkoutEntry): boolean {
  const hasExercises = (entry.exercises?.length ?? 0) > 0;
  return !hasExercises && entry.duration_mins != null;
}
