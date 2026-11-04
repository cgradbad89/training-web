/** Pure projection of supplied results. Acquisition belongs to the session owner. */
import {
  SHARED_PERFORMANCE_EVIDENCE_VERSION,
  type CurrentCapabilityEvidence, type DemonstratedPerformanceEvidence,
  type DemonstratedRaceObservation, type EvidenceAdapterContext, type EvidenceMetadata,
  type ManualPerformanceEvidence, type PerformanceRaceGoalContext, type SavedManualEvidenceInput,
  type SharedEvidenceRead, type WithheldRaceDayForecast, type WithheldRaceDayOutlook,
  type WithheldValidatedCapability,
} from "@/types/sharedPerformanceEvidence";
import type { CurrentHalfEstimate } from "./experimentalCurrentPerformance";
import type { RacePerformanceEvidence, RacePerformanceResult } from "@/types/racePerformance";

function metadata(): EvidenceMetadata {
  return {
    evidenceCutoff: null, timeZone: null, calculationStartedAt: null, calculationCompletedAt: null,
    latestIncludedWorkout: { workoutId: null, date: null }, parentAvailabilityThrough: null,
    coverage: { window: null, workouts: "unknown", telemetry: "unknown", deviceVo2: "unknown",
      expectedWorkoutCount: null, limitations: [] },
    versions: { model: null, extractor: null, qualityPolicy: null, qualityPolicyDigest: null },
    provenance: null, limitations: [],
  };
}

function readModel<T>(evidence: SharedEvidenceRead<T>["evidence"], context: EvidenceAdapterContext): SharedEvidenceRead<T> {
  const retrieval = context.retrieval ?? { status: "unknown", origin: "unknown", retrievedAt: null, error: null };
  return {
    contractVersion: SHARED_PERFORMANCE_EVIDENCE_VERSION,
    availability: evidence ? "available" : retrieval.status === "success" ? "absent"
      : retrieval.status === "error" ? "unavailable" : "not_loaded",
    owner: context.owner ? { ...context.owner } : null,
    retrieval: { ...retrieval },
    applicability: context.applicability ? structuredClone(context.applicability)
      : { status: "not_assessed", assessedAt: null, reasons: [] },
    evidence,
  };
}

export function withholdValidatedCapability(): WithheldValidatedCapability {
  return { status: "withheld", validated: false, estimatedSeconds: null,
    confidenceInterval: null, reason: "no_validated_estimator" };
}

export function withholdRaceDayForecast(): WithheldRaceDayForecast {
  return { status: "withheld", validated: false, estimatedSeconds: null,
    confidenceInterval: null, reason: "no_validated_forecast" };
}

export function createWithheldRaceDayOutlook(goal: PerformanceRaceGoalContext | null = null): WithheldRaceDayOutlook {
  return { goal: goal ? structuredClone(goal) : null, forecast: withholdRaceDayForecast() };
}

function raceObservation(observation: RacePerformanceEvidence): DemonstratedRaceObservation {
  return {
    origin: "race_performance",
    confirmation: observation.status === "verified" ? "reported_verified"
      : observation.status === "owner_confirmed" ? "owner_confirmed"
      : observation.status === "recorded_unverified" ? "unverified" : "unknown",
    independentSourceVerification: "not_established",
    benchmarkQualification: "preserved_from_source", observation,
  };
}

export function adaptSavedManualPerformance(
  saved: SavedManualEvidenceInput | null,
  context: EvidenceAdapterContext = {},
): SharedEvidenceRead<ManualPerformanceEvidence> {
  if (!saved) return readModel(null, context);
  // Copy only pure payload fields; an SDK committedAt object is neither invoked nor retained.
  const payload = structuredClone(saved.payload);
  const result = payload.result;
  const basis = metadata();
  basis.evidenceCutoff = result.asOf;
  basis.timeZone = result.timeZone;
  basis.calculationStartedAt = payload.calculationStartedAt ?? null;
  basis.calculationCompletedAt = payload.calculationCompletedAt ?? null;
  basis.coverage = structuredClone(result.completeness.coverage);
  basis.versions = { model: result.versions.model, extractor: result.versions.extractor,
    qualityPolicy: result.versions.qualityPolicy, qualityPolicyDigest: null };
  basis.provenance = payload.provenance ?? null;
  basis.limitations = [...result.limitations];
  return readModel({ metadata: basis, value: {
    kind: "measured_performance", analysis: result,
    demonstratedRaces: result.demonstratedRaces.map(observation => ({
      origin: "manual_linked_workout", confirmation: "unverified",
      independentSourceVerification: "not_established", benchmarkQualification: "not_assessed", observation,
    })),
    workoutObservations: null,
    publication: {
      schemaVersion: saved.schemaVersion ?? null, revision: saved.revision ?? null,
      snapshotId: saved.snapshotId ?? null, previousSnapshotId: saved.previousSnapshotId ?? null,
      publicationDigest: saved.publicationDigest ?? null, payloadEvidenceDigest: payload.evidenceDigest ?? null,
      payloadVersions: payload.versions ?? null, evidenceAsOf: payload.evidenceAsOf ?? null,
      reason: payload.reason ?? null, historyBasis: payload.historyBasis ?? null,
      featureRevisions: saved.featureRevisions ? structuredClone(saved.featureRevisions) : null,
      committedAt: context.committedAt ?? null,
    },
    validatedCapability: withholdValidatedCapability(),
  } }, context);
}

export function adaptRacePerformance(
  source: RacePerformanceResult | null,
  context: EvidenceAdapterContext = {},
): SharedEvidenceRead<DemonstratedPerformanceEvidence> {
  if (!source) return readModel(null, context);
  const result = structuredClone(source);
  const basis = metadata();
  basis.evidenceCutoff = result.asOf;
  basis.timeZone = context.timeZone ?? null;
  basis.versions.model = result.version;
  basis.limitations = [...result.limitations];
  return readModel({ metadata: basis, value: {
    kind: "demonstrated_performance", result,
    demonstratedRaces: result.evidence.map(raceObservation), workoutObservations: null,
    validatedCapability: withholdValidatedCapability(), futureForecast: withholdRaceDayForecast(),
  } }, context);
}

/** The caller supplies the existing experiment gate. This module never reads env
 * or evaluates a model; gate-off output carries no supplied numerical estimate. */
export function adaptExperimentalCurrentPerformance(
  estimate: CurrentHalfEstimate | null,
  enabled: boolean,
  context: EvidenceAdapterContext = {},
): SharedEvidenceRead<CurrentCapabilityEvidence> {
  if (!enabled) return readModel({ metadata: metadata(), value: {
    kind: "current_capability", status: "withheld", validated: false,
    estimatedSeconds: null, confidenceInterval: null, reason: "experiment_not_enabled", sourceEstimate: null,
  } }, context);
  if (!estimate) return readModel(null, context);
  const sourceEstimate = structuredClone(estimate);
  const basis = metadata();
  basis.evidenceCutoff = sourceEstimate.asOf;
  basis.timeZone = context.timeZone ?? null;
  basis.latestIncludedWorkout.date = sourceEstimate.dataThrough;
  basis.versions.model = sourceEstimate.version;
  basis.limitations = [...sourceEstimate.gaps, ...sourceEstimate.assumptions];
  const value: CurrentCapabilityEvidence = sourceEstimate.status === "experimental" && sourceEstimate.finishMinutes !== null
    ? { kind: "current_capability", status: "experimental", validated: false, confidenceInterval: null, sourceEstimate }
    : { kind: "current_capability", status: "withheld", validated: false, estimatedSeconds: null,
      confidenceInterval: null, reason: sourceEstimate.reason, sourceEstimate };
  return readModel({ metadata: basis, value }, context);
}
