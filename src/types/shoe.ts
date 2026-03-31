export interface RunningShoe {
  id: string;
  name: string;
  brand: string;
  model: string;
  colorway?: string;
  purchaseDate?: string;       // ISO date string
  startMileageOffset: number;
  retirementMileageTarget?: number;
  notes?: string;
  isRetired: boolean;
  addedAt: string;             // ISO date string
  autoAssignRules?: ShoeAutoAssignRule[];
}

/** Inline rule stored as an array on the RunningShoe document */
export interface ShoeAutoAssignRule {
  id: string;
  shoeId: string;              // redundant when stored inline, required for aggregated views
  isEnabled: boolean;
  scope: "any" | "outdoor" | "treadmill";
  minDistance?: number;        // miles
  maxDistance?: number;        // miles
  startDate?: string;          // ISO date string
  endDate?: string;            // ISO date string
}

/** Legacy per-document assignment (one Firestore doc per activity) */
export interface ShoeAssignment {
  activityId: number;
  shoeId: string | null; // null = explicit "no shoe"
}

/** @deprecated Use ShoeAutoAssignRule instead */
export type ShoeAutoAssignmentRule = ShoeAutoAssignRule;
