import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { WorkoutOverride } from "@/types/workoutOverride";

/** An explicit evidence revision, not inferred from a race name or a workout pace.
 * knownAt must move forward whenever any confirmed field or source is corrected.
 * Legacy Phase 3A offline input. New saved confirmations use the explicitly
 * untrusted chronology in Race.confirmationHistory instead. */
export interface RacePerformanceConfirmation {
  status: "verified" | "owner_confirmed";
  kind: "official_race" | "race" | "time_trial" | "high_effort";
  knownAt: string;
  raceDate: string;
  distanceMeters: number;
  finishSeconds: number;
  effort: "maximal" | "hard" | "nonmaximal" | "unknown";
  /** Owner description of course/weather/other material conditions. */
  conditions: string | null;
  /** Official result URL or explicit owner-confirmation provenance. */
  source: string;
  /** Required to prefer a confirmed official time over discrepant workout timing. */
  timingReconciliation?: string;
}

export type RaceEvidenceStatus = "verified" | "owner_confirmed" | "recorded_unverified" | "inconsistent" | "insufficient_evidence";
export type RaceEvidenceTier = "official_result" | "confirmed_race_or_time_trial" | "linked_race_workout" | "identified_high_effort" | "insufficient";

/** Screening choices for evidence integrity; none are validated fitness adjustments. */
export interface RacePerformancePolicy {
  version: string;
  staleAfterDays: number;
  recordedDistanceToleranceFraction: number;
  sameDistanceToleranceMeters: number;
  timingToleranceSeconds: number;
  timingToleranceFraction: number;
  currentEstimator: "unvalidated";
  forecastEstimator: "unvalidated";
}

export interface RacePerformanceInput {
  races: readonly Race[];
  workouts: readonly HealthWorkout[];
  overrides?: Record<string, WorkoutOverride> | null;
  asOf: string;
  timeZone: string;
  targetDistanceMeters?: number;
  /** Historical evaluation abstains for unversioned current race/linkage metadata. */
  asOfMode?: "current" | "historical";
  policy?: RacePerformancePolicy;
}

export interface RacePerformanceEvidence {
  raceId: string;
  name: string;
  raceDate: string;
  distanceMeters: number | null;
  finishSeconds: number | null;
  workoutId: string | null;
  recordedDistanceMeters: number | null;
  durationSeconds: number | null;
  elapsedSeconds: number | null;
  timingBasis: "confirmed_result" | "recorded_workout_duration" | "unverified_entered_result" | "none";
  timingAgreement: "consistent" | "discrepant" | "unknown" | "reconciled";
  status: RaceEvidenceStatus;
  tier: RaceEvidenceTier;
  effort: RacePerformanceConfirmation["effort"];
  conditions: string | null;
  knownAt: string | null;
  /** Exact selected Phase 3B revision; absent for legacy Phase 3A fixtures. */
  confirmationRevisionId?: string | null;
  confirmationChronology?: "client_document_untrusted" | "legacy_known_at" | "unconfirmed";
  availableAsOf: boolean;
  ageDays: number | null;
  stale: boolean;
  eligibleSameDistanceBenchmark: boolean;
  eligibleForEquivalence: boolean;
  reasons: readonly string[];
  provenance: { source: string; sourceId: string; confirmationSource: string | null };
}

export interface RaceResearchEquivalence {
  raceId: string;
  method: "riegel_fixed_1_06" | "vdot_style";
  sourceDistanceMeters: number;
  targetDistanceMeters: number;
  equivalentSeconds: number;
  purpose: "research_only";
  /** Never a personalized confidence interval or a current/forecast estimate. */
  limitations: readonly string[];
}

export interface RacePerformanceResult {
  version: "phase3a-race-evidence-v1";
  asOf: string;
  targetDistanceMeters: number;
  evidence: readonly RacePerformanceEvidence[];
  /** Actual dated observations; no weekly interpolation or estimated trend. */
  historicalBenchmarks: readonly RacePerformanceEvidence[];
  /** May be provisional, and must always be displayed with its status/date. */
  latestBenchmark: RacePerformanceEvidence | null;
  researchEquivalences: readonly RaceResearchEquivalence[];
  currentCapability: { status: "unavailable"; estimatedSeconds: null; confidenceInterval: null; reason: "no_validated_estimator" };
  raceDayForecast: { status: "unavailable"; estimatedSeconds: null; confidenceInterval: null; reason: "no_validated_forecast" };
  limitations: readonly string[];
}
