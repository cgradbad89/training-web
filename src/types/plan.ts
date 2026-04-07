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

// ─── Cross training plan types (new) ─────────────────────────────────────────

export interface PlanExercise {
  id: string;
  name: string;
  sets: number;
  reps: number;
  weight_lbs: number;
}

export interface PlannedWorkoutEntry {
  id: string;
  weekIndex: number;
  weekday: number;     // 1=Mon … 7=Sun
  dayOfWeek: number;
  type: "rest" | "workout";
  label?: string;          // e.g. "Upper Body", "OTF", "HIIT"
  notes?: string;
  exercises?: PlanExercise[];
  completed?: boolean;
  completedAt?: string;
}

export interface PlannedPilatesEntry {
  id: string;
  weekIndex: number;
  weekday: number;
  dayOfWeek: number;
  type: "rest" | "pilates";
  label?: string;          // e.g. "Reformer Pilates"
  duration_mins?: number;
  notes?: string;
  completed?: boolean;
  completedAt?: string;
}

export interface PlanWorkoutWeek {
  weekNumber: number;
  entries: PlannedWorkoutEntry[];
  notes?: string;
}

export interface PlanPilatesWeek {
  weekNumber: number;
  entries: PlannedPilatesEntry[];
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

export interface PilatesPlan {
  id: string;
  name: string;
  planType: "pilates";
  startDate: string;
  weeks: PlanPilatesWeek[];
  isActive: boolean;
  raceId?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Discriminated union ─────────────────────────────────────────────────────

export type Plan = RunningPlan | WorkoutPlan | PilatesPlan;

export type PlanType = "running" | "workout" | "pilates";

/** Type guards for narrowing the discriminated union. */
export function isRunningPlan(plan: Plan): plan is RunningPlan {
  return plan.planType === undefined || plan.planType === "running";
}

export function isWorkoutPlan(plan: Plan): plan is WorkoutPlan {
  return plan.planType === "workout";
}

export function isPilatesPlan(plan: Plan): plan is PilatesPlan {
  return plan.planType === "pilates";
}
