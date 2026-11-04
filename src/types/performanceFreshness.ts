import type { HealthWorkout } from "./healthWorkout";
import type { WorkoutOverride } from "./workoutOverride";
import type { ManualPerformanceEvidence, SharedEvidenceRead } from "./sharedPerformanceEvidence";

export type PerformanceFreshnessStatus = "no_saved_analysis" | "checking" | "no_detected_changes"
  | "update_available" | "incomplete_sync" | "unable_to_verify";

export interface PerformanceFreshness {
  status: PerformanceFreshnessStatus;
  newWorkoutIds: string[];
  newlyVisibleWorkoutIds: string[];
  changedWorkoutIds: string[];
  incompleteWorkoutIds: string[];
  uncertainWorkoutIds: string[];
  evidenceCutoff: string | null;
  limitations: string[];
  refreshFailed: boolean;
}

/** A comparison of records actually observed in this session, never a fabricated
 * source digest at the saved calculation. Kept only in the authenticated owner. */
export interface PerformanceMetadataObservation {
  publicationDigest: string;
  observedAt: string;
  records: Record<string, { startedAt: number; basis: string; isRun: boolean }>;
  absenceEstablishedFrom: number | null;
}

export interface PerformanceFreshnessInput {
  evidence: SharedEvidenceRead<ManualPerformanceEvidence>;
  workouts: readonly HealthWorkout[];
  overrides: Readonly<Record<string, WorkoutOverride>>;
  sources: {
    workouts: { hasLoaded: boolean; resolution: "loading" | "success" | "error" };
    overrides: { hasLoaded: boolean; resolution: "loading" | "success" | "error" };
  };
  workoutsHistoryComplete: boolean;
  observation: PerformanceMetadataObservation | null;
  now: string;
}
