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
  startDate: string; // ISO date (Monday-normalized)
  weeks: PlanWeek[];
  isActive: boolean;
  isBuiltInDefault?: boolean;
  createdAt: string;
  updatedAt: string;
}
