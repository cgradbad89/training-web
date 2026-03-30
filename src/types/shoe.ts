export interface RunningShoe {
  id: string;
  name: string;
  brand: string;
  model: string;
  colorway?: string;
  startMileageOffset: number;
  retirementMileageTarget?: number;
  notes?: string;
  isRetired: boolean;
  addedAt: string; // ISO date string
}

export interface ShoeAssignment {
  activityId: number;
  shoeId: string | null; // null = explicit "no shoe"
}

export interface ShoeAutoAssignmentRule {
  id: string;
  shoeId: string;
  matchActivityType?: string; // e.g. "Run"
  matchGearId?: string;       // Strava gear_id
}
