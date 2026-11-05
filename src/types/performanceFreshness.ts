import type { HealthWorkout } from "./healthWorkout";
import type { WorkoutOverride } from "./workoutOverride";
import type { ManualPerformanceEvidence, SharedEvidenceRead } from "./sharedPerformanceEvidence";

export type PerformanceFreshnessStatus = "no_saved_analysis" | "checking" | "no_detected_changes"
  | "update_available" | "incomplete_sync" | "unable_to_verify";

/** Parent-metadata identity for a flagged record. Dates come from the loaded
 * parent; `incorporated` is saved-manifest membership, never upload state. */
export interface PerformanceFlaggedRecord {
  workoutId: string;
  startedAt: string;
  displayType: string;
  incorporated: boolean;
  afterCutoff: boolean;
}

export interface PerformanceFreshness {
  status: PerformanceFreshnessStatus;
  newWorkoutIds: string[];
  newlyVisibleWorkoutIds: string[];
  changedWorkoutIds: string[];
  /** Recent (ended within PERFORMANCE_RECENT_INCOMPLETE_DAYS) or still-unfinished
   * runs whose parent reports a partial route. The only incomplete category that
   * drives `incomplete_sync`; it suggests, but cannot prove, an active upload. */
  incompleteWorkoutIds: string[];
  /** Older runs still carrying `routeComplete: false`. A historical metadata
   * limitation: no active upload can be established from the parent alone. */
  historicalIncompleteWorkoutIds: string[];
  uncertainWorkoutIds: string[];
  /** Identity/date for every new, newly visible, changed or incomplete ID. */
  records: Record<string, PerformanceFlaggedRecord>;
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
