export interface PlannedRunEntry {
  id: string;
  dayOfWeek: number; // 0=Mon … 6=Sun
  distanceMiles: number;
  paceTarget?: string; // e.g. "10:30"
  notes?: string;
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
  createdAt: string;
  updatedAt: string;
}
