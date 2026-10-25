import type { RaceDistance } from "@/types/race";
import type { RacePerformanceConfirmation } from "@/types/racePerformance";
import type { WorkoutOverride } from "@/types/workoutOverride";

/** Explicit owner input; no inferred official result or manufactured known-at date. */
export interface RaceConfirmationDraft {
  officialEventName: string;
  raceDate: string;
  distanceMeters: number;
  finishSeconds: number;
  timeBasis: "chip" | "gun" | "other";
  status: "verified" | "owner_confirmed";
  effort: RacePerformanceConfirmation["effort"];
  conditions: string;
  source: string;
  timingReconciliation?: string | null;
  correctionReason?: string | null;
}

export interface RaceConfirmationDetails extends Omit<RaceConfirmationDraft, "correctionReason" | "timingReconciliation"> {
  kind: "official_race";
  timingReconciliation: string | null;
  linkedWorkoutId: string;
}

/** Relevant original parent observations, never a rewritten workout or race result. */
export interface RaceConfirmationObservations {
  timeZone: string;
  race: {
    id: string; name: string; raceDate: string; raceDistance: RaceDistance;
    customDistanceMiles: number | null; actualRunId: string | null;
    actualRunDate: string | null; actualRunDistanceMiles: number | null;
    actualRunDurationSeconds: number | null; result: string | null;
    createdAt: string | null;
    performanceEvidence: RacePerformanceConfirmation | null;
  };
  workout: {
    workoutId: string; startDate: string; endDate: string;
    durationSeconds: number; distanceMiles: number; distanceMeters: number | null;
    isRunLike: boolean; activityType: string; syncedAt: string | null;
  };
  override: WorkoutOverride | null;
}

export interface RaceConfirmationRevision {
  revisionId: string;
  requestId: string;
  revisionNumber: number;
  supersedesRevisionId: string | null;
  /** Server receipt time after resolution; null means pending/unusable evidence. */
  availableAt: string | null;
  details: RaceConfirmationDetails;
  correctionReason: string | null;
  observations: RaceConfirmationObservations;
  snapshotToken: string;
}

/** Append-only in this adapter, but existing owner-writable rules cannot enforce
 * immutability or authoritative historical chronology. Predictors must abstain. */
export interface RaceConfirmationHistory {
  schemaVersion: 1;
  chronology: "client_document_untrusted";
  currentRevisionId: string;
  revisions: Record<string, RaceConfirmationRevision>;
}

export interface SaveRaceConfirmationInput {
  raceId: string;
  requestId: string;
  expectedRevisionId: string | null;
  snapshotToken: string;
  observations: RaceConfirmationObservations;
  details: RaceConfirmationDetails;
  correctionReason: string | null;
}
