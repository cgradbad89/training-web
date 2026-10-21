/** Pure manual-performance contracts. No Firebase types or raw telemetry in saved records. */
export type PerformanceInstant = string;
export type PerformanceDate = string;
export type EvidenceState = "complete" | "absent" | "pending" | "failed" | "unknown";
export type CoverageState = "complete" | "partial" | "unknown";

export interface PerformanceVersions {
  schema: 1;
  model: string;
  extractor: string;
  qualityPolicy: string;
}

export interface PerformanceProvenance {
  source: string | null;
  sourceId: string;
  notes: readonly string[];
}

/** A receipt for the exact supplied child content; parent flags are never receipts. */
export interface TelemetryVerification {
  state: EvidenceState;
  contentDigest: string | null;
  verification: "supplied_content" | "unverified";
}

export interface EffectivePerformanceWorkout {
  workoutId: string;
  startedAt: PerformanceInstant;
  endedAt: PerformanceInstant;
  availableAt: PerformanceInstant | null;
  completion: "completed" | "incomplete" | "unknown";
  excluded: boolean;
  isRun: boolean;
  runKind: "outdoor" | "treadmill" | "other";
  distanceMeters: number | null;
  durationSeconds: number | null;
  averageHrBpm: number | null;
  ascentMeters: number | null;
  environment: { temperatureF: number | null; dewPointF: number | null; windMph: number | null };
  /** Relevant raw parent + canonical override content, excluding derived UI caches. */
  parentDigest: string;
  telemetry: TelemetryVerification;
  provenance: PerformanceProvenance;
  limitations: readonly string[];
}

/** Normalized transient intervals derived from raw positions/time by a future reader.
 * They must be freshly supplied or verified against their complete content digest;
 * cached parent average speed/HR and UI-enriched fields are not evidence. */
export interface PerformanceTelemetryInterval {
  startSeconds: number;
  endSeconds: number;
  speedMps: number;
  hrBpm: number | null;
}

export interface SteadyObservation {
  lowerBpmInclusive: number;
  upperBpmExclusive: number;
  medianSpeedMps: number;
  medianHrBpm: number;
  windowCount: number;
  representativeStartSeconds: number;
  representativeEndSeconds: number;
}

export interface WorkoutPerformanceFeature {
  workoutId: string;
  parentDigest: string;
  sourceInputDigest: string;
  telemetryDigest: string | null;
  extractorVersion: string;
  qualityPolicyVersion: string;
  qualityPolicyDigest: string;
  observedAt: PerformanceInstant;
  extractedAt: PerformanceInstant;
  completion: EffectivePerformanceWorkout["completion"];
  telemetryState: EvidenceState;
  status: "accepted" | "rejected" | "unresolved";
  observations: readonly SteadyObservation[];
  reasons: readonly string[];
  quality: {
    timeCoverageFraction: number | null;
    hrCoverageFraction: number | null;
    acceptedSeconds: number;
    sourceSampleCount: number;
    environmentKnown: boolean;
  };
  provenance: PerformanceProvenance;
  limitations: readonly string[];
}

/** Named descriptive screening choices, not validated physiological constants. */
export interface PerformanceQualityPolicy {
  version: string;
  minimumSourceSamples: number;
  minimumWorkoutSeconds: number;
  minimumWorkoutMeters: number;
  maximumIntervalSeconds: number;
  maximumSpeedMps: number;
  minimumCoverageFraction: number;
  minimumHrCoverageFraction: number;
  minimumHrBpm: number;
  maximumHrBpmExclusive: number;
  warmupSeconds: number;
  windowSeconds: number;
  minimumMinuteSeconds: number;
  minimumRunningFraction: number;
  minimumRunningSpeedMps: number;
  maximumRunningSpeedMps: number;
  maximumMinuteSpeedCV: number;
  maximumMinuteHrSdBpm: number;
  maximumWindowHrDriftBpm: number;
  maximumAscentMetersPerKm: number;
  maximumTemperatureF: number;
  maximumDewPointF: number;
  maximumWindMph: number;
  hrBandWidthBpm: number;
  minimumIndependentWorkouts: number;
}

export interface PerformanceWindow {
  startDate: PerformanceDate;
  endDate: PerformanceDate;
}

export interface PerformanceCoverage {
  window: PerformanceWindow;
  workouts: CoverageState;
  telemetry: CoverageState;
  deviceVo2: CoverageState;
  expectedWorkoutCount: number | null;
  limitations: readonly string[];
}

export interface LinkedPerformanceRace {
  raceId: string;
  workoutId: string;
  raceDate: PerformanceDate;
  nominalDistanceMeters: number;
  copiedDurationSeconds: number | null;
  provenance: PerformanceProvenance;
  limitations: readonly string[];
}

export interface DemonstratedPerformanceRace extends LinkedPerformanceRace {
  recordedDistanceMeters: number;
  durationSeconds: number;
  elapsedSeconds: number;
  timingBasis: "effective_workout_duration";
  officialChipTimeVerified: false;
  timingAgreement: "agrees" | "discrepant" | "unknown";
}

export interface DeviceVo2Measurement {
  measurementId: string;
  date: PerformanceDate;
  value: number;
  unit: "ml/kg/min" | "unknown";
  sourceKind: "device_estimate" | "unknown";
  sourceName: string | null;
  availableAt: PerformanceInstant | null;
  provenance: PerformanceProvenance;
}

export interface AerobicPerformanceIndicators {
  status: "descriptive" | "insufficient";
  currentWindow: PerformanceWindow;
  referenceWindow: PerformanceWindow;
  independentWorkoutCount: number;
  bands: readonly {
    lowerBpmInclusive: number;
    upperBpmExclusive: number;
    currentWorkoutCount: number;
    referenceWorkoutCount: number;
    currentMedianSpeedMps: number | null;
    referenceMedianSpeedMps: number | null;
    currentMedianHrBpm: number | null;
    referenceMedianHrBpm: number | null;
    speedChangePct: number | null;
    status: "descriptive" | "insufficient";
    observationDates: readonly PerformanceDate[];
  }[];
  limitations: readonly string[];
}

export interface DeviceVo2Trend {
  status: "descriptive" | "insufficient";
  currentWindow: PerformanceWindow;
  referenceWindow: PerformanceWindow;
  measurementDateCount: number;
  latest: DeviceVo2Measurement | null;
  groups: readonly {
    unit: DeviceVo2Measurement["unit"];
    sourceKind: DeviceVo2Measurement["sourceKind"];
    sourceName: string | null;
    currentDates: number;
    referenceDates: number;
    currentMedian: number | null;
    referenceMedian: number | null;
    change: number | null;
    status: "descriptive" | "insufficient";
  }[];
  measurements: readonly DeviceVo2Measurement[];
  limitations: readonly string[];
}

export interface EndurancePreparation {
  recentWindow: PerformanceWindow;
  longRunWindow: PerformanceWindow;
  longRunDefinitionMeters: number;
  recent: { meters: number | null; seconds: number | null; runCount: number | null; runDays: number | null; runsPerWeek: number | null };
  longestRecentRun: { workoutId: string; date: PerformanceDate; meters: number; seconds: number } | null;
  longRunCount: number | null;
  weekly: readonly {
    weekStart: PerformanceDate;
    window: PerformanceWindow;
    meters: number | null;
    miles: number | null;
    runCount: number | null;
    runDays: number | null;
    coverage: CoverageState;
    partialWeek: boolean;
  }[];
  consistency: { completeWeeks: number; weeksWithRuns: number; fraction: number | null };
  limitations: readonly string[];
}

export interface PerformanceAnalysisInput {
  asOf: PerformanceInstant;
  timeZone: string;
  workouts: readonly EffectivePerformanceWorkout[];
  linkedRaces: readonly LinkedPerformanceRace[];
  features: readonly WorkoutPerformanceFeature[];
  deviceVo2: readonly DeviceVo2Measurement[];
  coverage: PerformanceCoverage;
  versions: PerformanceVersions;
  qualityPolicy: PerformanceQualityPolicy;
  observationDays: number;
  comparisonDays: number;
  longRunDefinitionMeters: number;
}

export interface PerformanceAnalysisResult {
  versions: PerformanceVersions;
  asOf: PerformanceInstant;
  timeZone: string;
  observationWindow: PerformanceWindow;
  demonstratedRaces: readonly DemonstratedPerformanceRace[];
  aerobic: AerobicPerformanceIndicators;
  deviceVo2: DeviceVo2Trend;
  preparation: EndurancePreparation;
  capability: { distance: "half_marathon"; status: "unavailable"; estimatedSeconds: null; confidenceInterval: null; reason: "no_validated_estimator" };
  completeness: {
    coverage: PerformanceCoverage;
    effectiveWorkoutCount: number;
    acceptedFeatureCount: number;
    unresolvedWorkoutIds: readonly string[];
    rejectedWorkoutIds: readonly string[];
  };
  warnings: readonly string[];
  limitations: readonly string[];
  evidenceDigest: string;
}

/** Publication draft. The future persistence layer supplies its own server commit timestamp. */
export interface PerformanceSnapshotPayload {
  result: PerformanceAnalysisResult;
  evidenceDigest: string;
  versions: PerformanceVersions;
  reason: "analyze_new_workouts" | "reprocess_selected_workouts" | "historical_reconstruction";
  historyBasis: "actual_calculation" | "reconstruction_current_metadata";
  calculationStartedAt: PerformanceInstant;
  calculationCompletedAt: PerformanceInstant;
  evidenceAsOf: PerformanceInstant;
  provenance: readonly PerformanceProvenance[];
  coverage: PerformanceCoverage;
}

export interface ManualWorkoutSelection {
  workoutId: string;
  action: "reuse" | "extract" | "review" | "exclude";
  reason: string;
  /** Forced reprocessing always requests fresh child content even if parent metadata matches. */
  requireFreshTelemetry: boolean;
}
