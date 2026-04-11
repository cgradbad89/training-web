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

/**
 * An individual exercise within a workout session.
 * The `notes` field holds per-exercise instructions (e.g. "Pause at bottom").
 */
export interface PlanExercise {
  id: string;
  name: string;
  sets: number;
  reps: number;
  weight_lbs: number;
  notes?: string;
}

/**
 * A section header that can be placed between exercises to visually group
 * them (e.g. "Warm Up", "Superset 1").
 */
export interface PlanSection {
  id: string;
  kind: "section";
  title: string;
}

/**
 * Discriminated union for items in a workout day's exercise list.
 * An exercise item has `kind: "exercise"` (or no `kind` for legacy docs).
 * A section header has `kind: "section"`.
 */
export type ExerciseItem =
  | (PlanExercise & { kind: "exercise" })
  | PlanSection;

/**
 * Normalize a raw Firestore item into ExerciseItem. Existing documents
 * written before the discriminated-union migration lack a `kind` field —
 * they are treated as plain exercises.
 */
export function normalizeExerciseItem(raw: Record<string, unknown>): ExerciseItem {
  const kind = (raw.kind as string | undefined) ?? "exercise";
  if (kind === "section") {
    return {
      id: (raw.id as string) ?? "",
      kind: "section",
      title: (raw.title as string) ?? "",
    };
  }
  return {
    id: (raw.id as string) ?? "",
    kind: "exercise",
    name: (raw.name as string) ?? "",
    sets: (raw.sets as number) ?? 0,
    reps: (raw.reps as number) ?? 0,
    weight_lbs: (raw.weight_lbs as number) ?? 0,
    notes: raw.notes as string | undefined,
  };
}

/** Type guard: true when item is an exercise, false for section headers. */
export function isExerciseItem(item: ExerciseItem): item is PlanExercise & { kind: "exercise" } {
  return item.kind === "exercise" || !("kind" in item) || (item as unknown as Record<string, unknown>).kind === undefined;
}

/** Type guard: true when item is a section header. */
export function isSectionItem(item: ExerciseItem): item is PlanSection {
  return item.kind === "section";
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
  exercises?: ExerciseItem[];
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
  const exerciseCount = (entry.exercises ?? []).filter(
    (e) => !("kind" in e) || e.kind === "exercise"
  ).length;
  return exerciseCount === 0 && entry.duration_mins != null;
}
