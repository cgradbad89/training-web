/**
 * Contracts for the Hybrid Performance Model v1.1 (Phases 3U–3Y):
 *   performance-evidence-v1.1        evidence qualification extended with sustained-segment evidence
 *   performance-capacity-v1.1        precision-weighted, two-group evidence combination (race vs recent efforts)
 *   experimental-hybrid-hm-v1.1      hybrid current-capability estimate built on the above
 *   experimental-raceday-forecast-v2 race-day forecast that starts from the v1.1 estimate
 *
 * Research/provisional only. NOTHING here is validated. v1 contracts (`hybridPerformance.ts`) are untouched and a stored
 * v1 result is never reinterpreted as v1.1. No value from these contracts may populate
 * `RacePerformanceResult.currentCapability` / `raceDayForecast`, a saved race or an immutable checkpoint.
 * "Standard error" below is an INTERNAL relative-weighting quantity of the evidence combination; it is not a
 * calibrated statistical interval and is never presented as one.
 */
import type { CurrentHalfEstimate } from "@/utils/experimentalCurrentPerformance";
import type { HrEnhancedEstimate } from "@/types/hrEnhancedPerformance";
import type {
  AerobicTrendEvidence, EnduranceReadiness, EvidenceKind, EvidenceQualification, EvidenceTier, HybridFamilyContribution,
  HybridStatus, HybridUnavailableCause,
} from "@/types/hybridPerformance";

// ─── evidence ────────────────────────────────────────────────────────────────

export type EvidenceKindV11 = EvidenceKind | "sustained_segment";

export interface SegmentProvenance {
  key: "5k" | "10k" | "10mi" | "half";
  hostDistanceMeters: number;
  hostSeconds: number;
  /** Host-workout average HR minus the athlete's own trailing-year median (bpm) — the effort support. */
  hostHrAboveMedianBpm: number;
}

export interface EvidenceItemV11 {
  /** Every effort derived from one workout shares it and counts ONCE. */
  clusterId: string;
  workoutId: string | null;
  raceId: string | null;
  kind: EvidenceKindV11;
  tier: EvidenceTier;
  date: string;
  ageDays: number;
  distanceMeters: number;
  seconds: number;
  avgHeartRate: number | null;
  tempF: number | null;
  /** The run had no recorded temperature (extra uncertainty, never assumed favourable). */
  weatherMissing: boolean;
  segment: SegmentProvenance | null;
  reasons: string[];
}

export interface EvidenceQualificationV11 {
  version: "performance-evidence-v1.1";
  asOf: string;
  asOfDate: string;
  /** One item per independent cluster and per local day, age ≤ 180 days. */
  independent: EvidenceItemV11[];
  /** The unchanged v1 qualification this extends (races and whole-run efforts come from it). */
  base: EvidenceQualification;
  segments: { candidates: number; qualified: number; referenceRuns: Record<string, number> };
  /** Potentially informative workouts that did NOT become evidence, by reason (aggregate counts). */
  informativeExcluded: Record<string, number>;
}

// ─── combination ─────────────────────────────────────────────────────────────

export type EvidenceGroup = "race" | "recent_effort";
export type CombinationItemFlag = "isolated_uncorroborated" | "slower_than_estimate_lower_bound" | "weather_missing";

export interface CombinationItem {
  clusterId: string;
  kind: EvidenceKindV11;
  tier: EvidenceTier;
  group: EvidenceGroup;
  date: string;
  ageDays: number;
  sourceDistanceMeters: number;
  sourceSeconds: number;
  equivalentSeconds: number;
  extrapolationRatio: number;
  /** Total internal standard uncertainty (fraction of time) = √(measurement² + extrapolation² + age-drift²), after inflations. */
  uncertaintyFraction: number;
  precision: number;
  /** Share of the final base (sums to 1 over used items; reconciles with `baseSeconds`). */
  effectiveShare: number;
  flags: CombinationItemFlag[];
}

export type IgnoredReason = "segment_slower_than_estimate" | "equivalent_implausible" | "extrapolation_unreliable" | "source_too_short";
export interface IgnoredItem { clusterId: string; kind: EvidenceKindV11; date: string; reason: IgnoredReason }

export interface GroupSummary {
  group: EvidenceGroup;
  count: number;
  /** Share of the base carried by this group. */
  share: number;
  estimateSeconds: number;
  /** √(1/Σprecision + common-mode²): the common-mode term does not average out with more items. */
  uncertaintyFraction: number;
  commonModeFraction: number;
}

export type RaceDominance = "none" | "minor" | "shared" | "dominant";

export type CombinationUnavailableCause =
  | "no_performance_evidence" | "anchor_expired_no_contemporary_evidence" | "insufficient_independent_evidence" | "invalid_input";

export interface EvidenceCombination {
  version: "performance-capacity-v1.1";
  method: "precision_weighted_two_group";
  status: "available" | "unavailable";
  unavailableCause: CombinationUnavailableCause | null;
  targetDistanceMeters: number;
  exponent: number;
  items: CombinationItem[];
  ignored: IgnoredItem[];
  race: GroupSummary | null;
  recent: GroupSummary | null;
  baseSeconds: number | null;
  /** What the race(s) alone imply (the counterfactual with no newer evidence); null without a race. */
  raceOnlySeconds: number | null;
  recentOnlySeconds: number | null;
  /** baseSeconds − raceOnlySeconds: the effect newer evidence has had (negative = faster). */
  displacementSeconds: number | null;
  raceShare: number;
  recentShare: number;
  raceDominance: RaceDominance;
  /** True when newer (non-race) evidence carries the majority of the base. */
  newerEvidenceMajority: boolean;
  latestRaceDate: string | null;
  latestRaceAgeDays: number | null;
  independentObservations: number;
  /** Internal relative-weighting uncertainty of the combined base (fraction of time). Not a statistical interval. */
  uncertaintyFraction: number | null;
  /** Weighted log-time dispersion of the item equivalents (null with fewer than two). */
  dispersionFraction: number | null;
  /** Largest item equivalent / smallest − 1. */
  spreadFraction: number;
  quality: "adequate" | "limited" | "insufficient";
  flags: string[];
  reasons: string[];
}

// ─── hybrid ──────────────────────────────────────────────────────────────────

export type Vo2Availability = "no_readings" | "sparse" | "available" | "load_failed" | "not_requested";
export interface Vo2Disclosure {
  availability: Vo2Availability;
  /** Readings inside the as-of boundary that passed plausibility screening (both windows). */
  readings: number;
  direction: AerobicTrendEvidence["vo2"]["direction"];
  corroboration: AerobicTrendEvidence["vo2Corroboration"];
  discontinuity: boolean;
  recentMedian: number | null;
  priorMedian: number | null;
  /** What VO₂ did to this estimate: never a direct numerical term. */
  effect: "none" | "raised_physiological_uncertainty" | "corroboration_disclosed_only";
  note: string;
}

export type HrStreamAvailability = "not_requested" | "none_available" | "partial" | "used" | "load_failed";
export interface HrStreamDisclosure {
  availability: HrStreamAvailability;
  /** Trend-eligible runs with warm-up-trimmed HR from a screened stream. */
  streamRuns: number;
  eligibleRuns: number;
  excludedIntervalLike: number;
  /** Offset (bpm) applied to whole-workout HR of runs without a stream, so selective hydration cannot create a trend. */
  calibrationOffsetBpm: number | null;
  note: string;
}

export interface HistoricalInfluence {
  latestRaceDate: string | null;
  latestRaceAgeDays: number | null;
  /** Share of the base carried by races / by newer efforts (the effective weights of the calculation). */
  raceShare: number;
  recentShare: number;
  raceDominance: RaceDominance;
  independentObservations: number;
  newerEvidenceDisplacedRace: boolean;
  /** Seconds the newer evidence moved the base from what the race alone implies (negative = faster). */
  displacementSeconds: number | null;
  physiologicalTrendApplied: boolean;
  /** Seconds the physiological and endurance terms moved the final estimate from the evidence base. */
  physiologyAdjustmentSeconds: number;
  enduranceAdjustmentSeconds: number;
  provisional: boolean;
  provisionalReasons: string[];
  /** Plain-language reasons (informative workouts not used, evidence aging, conflicts). */
  notes: string[];
  excludedInformative: Record<string, number>;
}

export interface ConflictSignal { id: "recent_performance_vs_aerobic_trend" | "recent_speed_vs_endurance_preparation"; detail: string }

/**
 * What kind of evidence carries the number.
 *  maximal_or_recorded_evidence       the unchanged v1.1 evidence (confirmed-maximal races, recorded races, strong efforts, segments)
 *  demonstrated_performance_included  a confirmed hard/nonmaximal race made the estimate FASTER than the strict estimate
 *  demonstrated_performance_only      nothing else qualified: the number is a time the athlete has DEMONSTRATED, not a maximal-performance prediction
 */
export type EvidenceBasis = "maximal_or_recorded_evidence" | "demonstrated_performance_included" | "demonstrated_performance_only";

export interface DemonstratedRaceDisclosure {
  basis: EvidenceBasis;
  /** Confirmed hard/nonmaximal races that passed the race-integrity checks (any age). */
  eligibleRaces: number;
  /** Of those, how many carry the number (within the 180-day currency limit). */
  usedRaces: number;
  /** The policy was switched off (rollback): the strict v1.1 evidence only. */
  policyDisabled: boolean;
  note: string | null;
}

export interface HybridV11Estimate {
  version: "experimental-hybrid-hm-v1.1";
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
  confidence: "low" | "moderate" | null;
  sensitivityRange: { fastSeconds: number; slowSeconds: number; basis: string } | null;
  contributions: HybridFamilyContribution[];
  combination: EvidenceCombination;
  qualification: EvidenceQualificationV11;
  physiology: AerobicTrendEvidence | null;
  readiness: EnduranceReadiness | null;
  adjustmentFraction: number;
  influence: HistoricalInfluence;
  conflicts: ConflictSignal[];
  inputs: { vo2: Vo2Disclosure; hrStreams: HrStreamDisclosure };
  comparison: { officialSeconds: number | null; hrEnhancedSeconds: number | null; hybridV1Seconds: number | null;
    differenceVsOfficialSeconds: number | null; differenceVsHrEnhancedSeconds: number | null; differenceVsHybridV1Seconds: number | null };
  flags: string[];
  missing: string[];
  reasons: string[];
  fallbackReason: string | null;
  assumptions: string[];
  caveats: string[];
  /** Whether a confirmed hard/nonmaximal race carries the number. Always present; `maximal_or_recorded_evidence` is the unchanged v1.1. */
  demonstrated: DemonstratedRaceDisclosure;
}

export interface HybridV11ComparisonInput { official: CurrentHalfEstimate | null; hrEnhanced: HrEnhancedEstimate | null }
