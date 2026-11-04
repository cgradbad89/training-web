/** Phase A read models only. These are not Firestore schemas or model validation. */
import type {
  CoverageState, DemonstratedPerformanceRace, EffectivePerformanceWorkout,
  PerformanceAnalysisResult, PerformanceProvenance, PerformanceSnapshotPayload,
  PerformanceVersions, PerformanceWindow,
} from "./performanceAnalysis";
import type { RacePerformanceEvidence, RacePerformanceResult } from "./racePerformance";
import type { CurrentHalfEstimate } from "@/utils/experimentalCurrentPerformance";

export const SHARED_PERFORMANCE_EVIDENCE_VERSION = "shared-performance-evidence-v1" as const;

/** Supplied by a future authorized consumer; not proof of authorization itself. */
export interface EvidenceOwner {
  uid: string;
  sessionEpoch: number;
}

export interface EvidenceRetrieval {
  status: "not_loaded" | "loading" | "success" | "error" | "unknown";
  origin: "server" | "cache" | "session" | "unknown";
  retrievedAt: string | null;
  error: string | null;
}

export interface EvidenceApplicability {
  status: "not_assessed" | "applicable" | "inputs_changed" | "incompatible";
  assessedAt: string | null;
  reasons: readonly string[];
}

/** No clock defaults, auth objects, SDK timestamps, or implicit freshness checks. */
export interface EvidenceAdapterContext {
  owner?: EvidenceOwner | null;
  retrieval?: EvidenceRetrieval;
  applicability?: EvidenceApplicability;
  /** Race/current results do not store their calculation's timezone. */
  timeZone?: string | null;
  /** Caller-normalized receipt time; never read from an SDK object here. */
  committedAt?: string | null;
}

export interface EvidenceMetadata {
  evidenceCutoff: string | null;
  timeZone: string | null;
  calculationStartedAt: string | null;
  calculationCompletedAt: string | null;
  /** A date key, not a source-retrieval timestamp. IDs may be unavailable. */
  latestIncludedWorkout: { workoutId: string | null; date: string | null };
  /** These result contracts contain no trustworthy parent-ingestion watermark. */
  parentAvailabilityThrough: string | null;
  coverage: {
    window: PerformanceWindow | null;
    workouts: CoverageState;
    telemetry: CoverageState;
    deviceVo2: CoverageState;
    expectedWorkoutCount: number | null;
    limitations: readonly string[];
  };
  versions: {
    model: string | null;
    extractor: string | null;
    qualityPolicy: string | null;
    qualityPolicyDigest: string | null;
  };
  provenance: readonly PerformanceProvenance[] | null;
  limitations: readonly string[];
}

export interface SharedEvidenceRead<T> {
  contractVersion: typeof SHARED_PERFORMANCE_EVIDENCE_VERSION;
  /** Only a successful supplied lookup can establish absent saved evidence. */
  availability: "available" | "not_loaded" | "absent" | "unavailable";
  owner: EvidenceOwner | null;
  retrieval: EvidenceRetrieval;
  applicability: EvidenceApplicability;
  evidence: { metadata: EvidenceMetadata; value: T } | null;
}

export type DemonstratedRaceObservation = {
  /** Neither existing adapter independently verifies an external results source. */
  independentSourceVerification: "not_established";
} & (
  | {
      origin: "manual_linked_workout";
      confirmation: "unverified";
      benchmarkQualification: "not_assessed";
      observation: DemonstratedPerformanceRace;
    }
  | {
      origin: "race_performance";
      confirmation: "reported_verified" | "owner_confirmed" | "unverified" | "unknown";
      /** Existing eligibility remains on observation; never recomputed here. */
      benchmarkQualification: "preserved_from_source";
      observation: RacePerformanceEvidence;
    }
);

/** Structurally accepts SavedPerformanceCurrent without importing its Firebase types.
 * Optional receipt metadata supports older/incomplete read inputs, not new writes. */
export interface SavedManualEvidenceInput {
  schemaVersion?: number | null;
  revision?: number | null;
  snapshotId?: string | null;
  previousSnapshotId?: string | null;
  publicationDigest?: string | null;
  featureRevisions?: readonly { workoutId: string; revision: number; featureDigest: string }[] | null;
  payload: Pick<PerformanceSnapshotPayload, "result"> & Partial<Omit<PerformanceSnapshotPayload, "result">>;
}

export interface ManualPerformanceEvidence {
  kind: "measured_performance";
  analysis: PerformanceAnalysisResult;
  demonstratedRaces: readonly DemonstratedRaceObservation[];
  /** Aggregate results cannot reconstruct individual non-race observations. */
  workoutObservations: readonly EffectivePerformanceWorkout[] | null;
  publication: {
    schemaVersion: number | null;
    revision: number | null;
    snapshotId: string | null;
    previousSnapshotId: string | null;
    publicationDigest: string | null;
    payloadEvidenceDigest: string | null;
    payloadVersions: PerformanceVersions | null;
    evidenceAsOf: string | null;
    reason: PerformanceSnapshotPayload["reason"] | null;
    historyBasis: PerformanceSnapshotPayload["historyBasis"] | null;
    featureRevisions: NonNullable<SavedManualEvidenceInput["featureRevisions"]> | null;
    committedAt: string | null;
  };
  validatedCapability: WithheldValidatedCapability;
}

export interface DemonstratedPerformanceEvidence {
  kind: "demonstrated_performance";
  result: RacePerformanceResult;
  demonstratedRaces: readonly DemonstratedRaceObservation[];
  workoutObservations: readonly EffectivePerformanceWorkout[] | null;
  validatedCapability: WithheldValidatedCapability;
  futureForecast: WithheldRaceDayForecast;
}

/** No validated numerical branch is authorized in Phase A. Preserve native units
 * and rounded values on sourceEstimate rather than deriving a new seconds value. */
export type CurrentCapabilityEvidence = {
  kind: "current_capability";
  validated: false;
  confidenceInterval: null;
} & (
  | { status: "experimental"; sourceEstimate: CurrentHalfEstimate }
  | {
      status: "withheld";
      estimatedSeconds: null;
      reason: string;
      sourceEstimate: CurrentHalfEstimate | null;
    }
);

export interface WithheldValidatedCapability {
  status: "withheld";
  validated: false;
  estimatedSeconds: null;
  confidenceInterval: null;
  reason: "no_validated_estimator";
}

export interface WithheldRaceDayForecast {
  status: "withheld";
  validated: false;
  estimatedSeconds: null;
  confidenceInterval: null;
  reason: "no_validated_forecast";
}

/** Owner intentions only. No target fields belong to a capability adapter. */
export interface PerformanceRaceGoalContext {
  raceId: string | null;
  raceDate: string | null;
  distanceMeters: number | null;
  linkedPlanId: string | null;
  targetPaceSecondsPerMile: number | null;
  targetFinishSeconds: number | null;
}

export interface WithheldRaceDayOutlook {
  goal: PerformanceRaceGoalContext | null;
  forecast: WithheldRaceDayForecast;
}
