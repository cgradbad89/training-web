/**
 * Contracts for the Phase 3Q–3T experimental performance models:
 *   performance-capacity-v1       (independent performance-capacity engine)
 *   aerobic-trend-v1              (multiweek aerobic efficiency evidence)
 *   experimental-hybrid-hm-v1     (hybrid current-capability estimate)
 *   experimental-raceday-forecast-v1 (separate future race-day forecast)
 *
 * Research/provisional only. NOTHING here is validated. No value from these contracts may
 * populate `RacePerformanceResult.currentCapability` / `raceDayForecast`, a saved race, or an
 * immutable checkpoint. Uncertainty is qualitative or an explicitly labelled assumption-
 * sensitivity range — never a calibrated statistical interval.
 */
import type { CurrentHalfEstimate } from "@/utils/experimentalCurrentPerformance";
import type { HrEnhancedEstimate } from "@/types/hrEnhancedPerformance";

// ─── 3Q: evidence ───────────────────────────────────────────────────────────

/** 1 confirmed race/time trial · 2 strong but not definitively maximal · 3 ordinary training · 4 unusable. */
export type EvidenceTier = "confirmed_maximal" | "strong_unconfirmed" | "ordinary_training" | "unsuitable";
export type EvidenceKind = "confirmed_race" | "recorded_race" | "whole_run_effort" | "labelled_race_run";

export interface PerformanceEvidenceItem {
  /** Correlation cluster. Every effort derived from one workout shares it and counts ONCE. */
  clusterId: string;
  workoutId: string | null;
  raceId: string | null;
  kind: EvidenceKind;
  tier: EvidenceTier;
  /** Local calendar date of the performance. */
  date: string;
  ageDays: number;
  distanceMeters: number;
  seconds: number;
  /** Base reliability 0..1 from tier/kind and data completeness (not a probability). */
  quality: number;
  avgHeartRate: number | null;
  tempF: number | null;
  reasons: string[];
}

export interface EvidenceExclusion { clusterId: string; reason: string }

export interface PerformanceCurvePoint {
  distanceKey: "1mi" | "5k" | "10k" | "10mi" | "half";
  distanceMeters: number;
  seconds: number;
  date: string;
  /** Tier of the host workout. An ordinary-training segment is a LOWER BOUND on capability, never a maximal test. */
  hostTier: EvidenceTier;
}

export interface EvidenceQualification {
  version: "performance-evidence-v1";
  asOf: string;
  asOfDate: string;
  /** One item per independent cluster (and per local day), strongest first. */
  independent: PerformanceEvidenceItem[];
  /** Everything classified, including dropped duplicates. */
  all: PerformanceEvidenceItem[];
  counts: Record<EvidenceTier, number>;
  excludedByReason: Record<string, number>;
  /** Items beyond the numerical-use age limit: listed, never silently authoritative. */
  expired: PerformanceEvidenceItem[];
  effortReference: { runs: number; hrThreshold: number | null; equivalentSecondsThreshold: number | null; available: boolean };
  /** Observed envelope of GPS best-effort segments (descriptive; lower bound of capability). */
  curve: PerformanceCurvePoint[];
}

// ─── 3Q: capacity methods ────────────────────────────────────────────────────

export type CapacityMethodId = "A_race_equivalence" | "B_critical_speed" | "C_recent_demonstrated";
export type CapacityMethodStatus = "available" | "fit_only" | "unavailable";

export interface CapacityContribution {
  clusterId: string;
  kind: EvidenceKind;
  tier: EvidenceTier;
  date: string;
  ageDays: number;
  sourceDistanceMeters: number;
  sourceSeconds: number;
  equivalentSeconds: number;
  vdotEquivalentSeconds: number | null;
  /** Source distance → target distance ratio. */
  extrapolationRatio: number;
  weight: number;
  weightShare: number;
  /** True when an isolated, uncorroborated much-faster unconfirmed effort was down-weighted. */
  isolatedFast?: boolean;
}

export interface CapacityMethodResult {
  id: CapacityMethodId;
  version: string;
  status: CapacityMethodStatus;
  targetDistanceMeters: number;
  seconds: number | null;
  /** Number of independent clusters that supplied weight. */
  evidenceCount: number;
  contributions: CapacityContribution[];
  reasons: string[];
  assumptions: string[];
  /** Only method B populates these. */
  criticalSpeed?: {
    speedMetersPerSecond: number; dPrimeMeters: number; r2: number; standardErrorFraction: number;
    efforts: number; durationRangeSeconds: [number, number];
  };
}

export type CapacityStatus = "available" | "provisional" | "unavailable";
export type CapacityUnavailableCause =
  | "no_performance_evidence"
  | "anchor_expired_no_contemporary_evidence"
  | "insufficient_independent_evidence"
  | "unsupported_distance"
  | "invalid_input";

export interface PerformanceCapacityResult {
  version: "performance-capacity-v1";
  researchStatus: "experimental_provisional";
  validated: false;
  asOf: string;
  asOfDate: string;
  dataThrough: string | null;
  targetDistanceMeters: number;
  status: CapacityStatus;
  unavailableCause: CapacityUnavailableCause | null;
  /** Primary capacity: method C when numerical. */
  seconds: number | null;
  methods: CapacityMethodResult[];
  qualification: EvidenceQualification;
  /** Effective Riegel exponent applied to sources shorter than the target. */
  exponent: number;
  evidenceQuality: "adequate" | "limited" | "insufficient";
  /** Dispersion (weighted log-time MAD) of the contributing equivalents; null with fewer than two. */
  dispersionFraction: number | null;
  flags: string[];
  reasons: string[];
  assumptions: string[];
}

// ─── 3R: physiological evidence ─────────────────────────────────────────────

export interface HrSample { /** Seconds from workout start. */ t: number; bpm: number }

export type HrStreamQuality = "good" | "limited" | "unusable";
export interface HrStreamSummary {
  version: "hr-stream-quality-v1";
  quality: HrStreamQuality;
  flags: string[];
  samples: number;
  /** Median gap between valid samples (s). */
  medianGapSeconds: number | null;
  coverageFraction: number;
  warmupSeconds: number | null;
  trimmedAvgHr: number | null;
  rawAvgHr: number | null;
  stableSegmentSeconds: number;
  /** Least-squares HR slope inside the stable post-warm-up segment, bpm per 10 min. Pace constancy is NOT known. */
  postWarmupSlopeBpmPer10Min: number | null;
  intervalLike: boolean;
}

export type AerobicTrendClass =
  | "unavailable"
  | "no_detectable_change"
  | "observed_improvement"
  | "observed_decline";

export interface AerobicTrendEvidence {
  version: "aerobic-trend-v1";
  status: "available" | "unavailable";
  reasons: string[];
  flags: string[];
  window: { start: string; end: string } | null;
  runs: number;
  weeks: number;
  treadmillOrUnknownSurface: number;
  /** Fractional pace change per 28 days at fixed HR, duration, climb and (when estimable) temperature. Negative = faster. */
  slopePer28d: number | null;
  standardError: number | null;
  tStatistic: number | null;
  /** Largest change of the slope when one calendar week is dropped. */
  leaveOneWeekOutRange: number | null;
  weatherAdjustment: "estimated" | "insufficient_coverage" | "not_used";
  covariates: { hrSlopePerBpm: number | null; tempPerF: number | null; climbPerMeterPerMile: number | null };
  hrSource: "parent_average" | "stream_trimmed_mixed" | "stream_trimmed";
  classification: AerobicTrendClass;
  vo2: { direction: "improving" | "declining" | "inconclusive" | "unavailable"; recentMedian: number | null; priorMedian: number | null; readings: number; discontinuity: boolean };
  /** Whether the VO2 direction agrees with the observed pace-at-HR direction. */
  vo2Corroboration: "agrees" | "disagrees" | "inconclusive" | "unavailable";
  /** Plain-language separation of what was observed, what is plausible and what is NOT supported. */
  interpretation: { observed: string[]; plausible: string[]; notSupported: string[] };
}

// ─── 3S: endurance readiness and hybrid ─────────────────────────────────────

export interface EnduranceReadiness {
  version: "endurance-readiness-v1";
  asOfDate: string;
  targetDistanceMeters: number;
  /** 0..1 composite of long-run, volume and frequency relative to the target distance. */
  score: number | null;
  longestRunMiles: number | null;
  weeklyMiles: number | null;
  runsPerWeek: number | null;
  weeksObserved: number;
  longRunFraction: number | null;
  components: { longRun: number; volume: number; frequency: number } | null;
  reasons: string[];
}

export type HybridStatus = "available" | "provisional" | "unavailable";
export type HybridUnavailableCause =
  | "no_performance_evidence"
  | "anchor_expired_no_contemporary_evidence"
  | "insufficient_independent_evidence"
  | "insufficient_endurance_preparation"
  | "invalid_input";

export type HybridFamily = "demonstrated_performance" | "physiological_trend" | "race_history" | "endurance_readiness";

export interface HybridFamilyContribution {
  family: HybridFamily;
  status: "used" | "unavailable" | "no_effect";
  /** Seconds relative to the demonstrated-performance capacity (0 for the base family). */
  seconds: number;
  fraction: number;
  /** 0..1 share of influence given to this family after evidence-quality shrinkage. */
  influence: number;
  explanation: string;
}

export interface HybridPerformanceEstimate {
  version: "experimental-hybrid-hm-v1";
  researchStatus: "experimental_provisional";
  validated: false;
  asOf: string;
  asOfDate: string;
  dataThrough: string | null;
  targetDistanceMeters: number;
  status: HybridStatus;
  unavailableCause: HybridUnavailableCause | null;
  seconds: number | null;
  minutes: number | null;
  paceSecondsPerMile: number | null;
  evidenceQuality: "adequate" | "limited" | "insufficient";
  /** Qualitative only. "moderate" is the maximum: nothing here is calibrated. */
  confidence: "low" | "moderate" | null;
  /** Assumption-sensitivity range (alternative defensible parameter sets). NOT a statistical interval. */
  sensitivityRange: { fastSeconds: number; slowSeconds: number; basis: string } | null;
  contributions: HybridFamilyContribution[];
  capacity: PerformanceCapacityResult;
  physiology: AerobicTrendEvidence | null;
  readiness: EnduranceReadiness | null;
  /** Total relative adjustment applied on top of the demonstrated-performance base. */
  adjustmentFraction: number;
  /** Differences vs the other experimental/official estimates for display; null if the comparator is unavailable. */
  comparison: { officialSeconds: number | null; hrEnhancedSeconds: number | null;
    differenceVsOfficialSeconds: number | null; differenceVsHrEnhancedSeconds: number | null };
  flags: string[];
  missing: string[];
  reasons: string[];
  fallbackReason: string | null;
  assumptions: string[];
  caveats: string[];
}

// ─── 3T: race-day forecast ──────────────────────────────────────────────────

export type ForecastStatus = "provisional" | "withheld";
export type ForecastWithheldCause =
  | "current_capability_unavailable"
  | "race_date_invalid_or_past"
  | "horizon_too_long"
  | "insufficient_endurance_basis";

export type WeatherBasis = "unknown" | "climatology_unavailable" | "forecast_unavailable";

export interface ForecastScenario {
  id: "current_training_maintained" | "plan_at_historical_adherence" | "plan_completed_as_planned" | "training_lapses" | "population_taper_context";
  label: string;
  seconds: number | null;
  fraction: number;
  /** What makes this scenario speculative. */
  basis: string;
  /** Whether this scenario is part of the central estimate. */
  central: boolean;
}

export interface RaceDayForecast {
  version: "experimental-raceday-forecast-v1";
  researchStatus: "experimental_provisional";
  validated: false;
  asOf: string;
  asOfDate: string;
  raceDate: string;
  daysToRace: number;
  targetDistanceMeters: number;
  status: ForecastStatus;
  withheldCause: ForecastWithheldCause | null;
  /** Current capability input: separate from, and never replaced by, the forecast. */
  currentCapabilitySeconds: number | null;
  currentCapabilityStatus: HybridStatus;
  /** Central provisional race-day value; null when withheld. */
  seconds: number | null;
  minutes: number | null;
  paceSecondsPerMile: number | null;
  /** Assumption-scenario range; not calibrated. */
  scenarioRange: { fastSeconds: number; slowSeconds: number; basis: string } | null;
  /** Symmetric allowance for unknown capacity change over the horizon: 1 %·√(days/30). Engineering assumption. */
  horizonAllowanceFraction: number;
  /** Age (days) the newest numerical performance evidence will have on race day. */
  evidenceAgeAtRaceDays: number | null;
  scenarios: ForecastScenario[];
  assumptions: {
    plannedTrainingTreatedAs: "planned_actions_not_adaptations";
    fitnessGainAssumed: 0;
    taper: "context_only_no_numeric_credit";
    weather: WeatherBasis;
    course: "unknown";
  };
  plan: { remainingPlannedRuns: number; remainingPlannedMiles: number; longestPlannedRunMiles: number | null;
    historicalAdherence: number | null; usedAdherence: number | null } | null;
  readiness: { now: number | null; projectedCompleted: number | null; projectedLapse: number | null };
  uncertainty: string[];
  reasons: string[];
  caveats: string[];
}

export interface HybridComparisonInput {
  official: CurrentHalfEstimate | null;
  hrEnhanced: HrEnhancedEstimate | null;
}
