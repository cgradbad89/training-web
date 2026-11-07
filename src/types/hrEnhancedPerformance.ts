/**
 * Contracts for the experimental HR-enhanced half-marathon estimate
 * (experimental-hr-enhanced-hm-v1) and the HR effort signal that feeds it.
 *
 * Research/provisional only. Nothing here is validated, and nothing here may
 * populate a validated prediction contract, a saved race, or a checkpoint.
 */
import type { CurrentHalfEstimate } from "@/utils/experimentalCurrentPerformance";

export type HrSignalReason =
  | "no_outdoor_hr_runs"
  | "insufficient_baseline_runs"
  | "insufficient_recent_runs"
  | "insufficient_baseline_weeks"
  | "insufficient_recent_weeks"
  | "no_hr_overlap"
  | "effort_differs"
  | "duration_mix_differs"
  | "slope_not_estimable"
  | "inconsistent_across_weeks"
  | "no_recent_window";

export type HrSignalFlag =
  | "weather_partial"
  | "weather_differs"
  | "slope_sensitive"
  | "slope_nonphysiological"
  | "indoor_runs_not_used"
  | "artifacts_rejected";

export type HrSignalDirection = "improved" | "declined" | "no_detectable_change" | "unavailable";

export interface HrSignalPeriodWindow { start: string; end: string }

/** Pace-at-constant-HR evidence. Negative contrast = faster at the same heart rate. */
export interface HrEffortSignal {
  version: string;
  status: "available" | "suppressed";
  reasons: HrSignalReason[];
  flags: HrSignalFlag[];
  window: { baseline: HrSignalPeriodWindow; recent: HrSignalPeriodWindow };
  referenceHr: number | null;
  supportBand: { low: number; high: number } | null;
  counts: {
    /** Outdoor, steady, valid-HR, race-excluded runs in either window before band/terrain/artifact screens. */
    candidates: { baseline: number; recent: number };
    /** Runs that actually support the contrast. */
    supported: { baseline: number; recent: number };
    weeks: { baseline: number; recent: number };
    /** Counts only; never identifiers. */
    excluded: Record<string, number>;
    indoorOrUnknownSurface: number;
  };
  medianHr: { baseline: number; recent: number } | null;
  medianDurationRatio: number | null;
  slope: {
    /** Robust within-period HR→ln(pace) slope (per bpm), bounded; null when not estimable. */
    estimated: number | null;
    /** The two slopes whose contrasts were compared (smaller magnitude is used). */
    sensitivity: number[];
  };
  contrast: {
    /** ln(recent/baseline pace) at the common HR using the estimated slope. */
    raw: number | null;
    /** Smaller-magnitude contrast across the slope sensitivity set (0 when the sign flips). */
    conservative: number | null;
    standardError: number | null;
    /** After the noise-multiple soft threshold and the cross-week consistency check. */
    shrunk: number | null;
    /** Percent pace change at constant HR implied by `shrunk` (negative = faster). */
    shrunkPercent: number | null;
    rawPercent: number | null;
  };
  consistency: { weeksAgree: number; weeksTotal: number } | null;
  weather: {
    status: "comparable" | "differs" | "partial" | "not_evaluated";
    coverage: { baseline: number; recent: number } | null;
    medianTempF: { baseline: number; recent: number } | null;
    deltaF: number | null;
    factor: number;
  };
  strength: { runFactor: number; weekFactor: number; weatherFactor: number; effortFactor: number; durationFactor: number; combined: number };
  direction: HrSignalDirection;
}

export type HrEnhancedUnavailableCause =
  | "official_unavailable"
  | "evidence_insufficient"
  | "evidence_stale";

export interface HrEnhancedEstimate {
  version: "experimental-hr-enhanced-hm-v1";
  signalVersion: string;
  /** Always research/provisional: never validated, never the official estimate. */
  researchStatus: "experimental_provisional";
  validated: false;
  asOf: string;
  anchorRaceId: string | null;
  anchorDate: string | null;
  officialVersion: string;
  officialSeconds: number | null;
  officialMinutes: number | null;
  /** Null unless the HR signal is available AND directional. */
  candidateSeconds: number | null;
  candidateMinutes: number | null;
  candidatePaceSecondsPerMile: number | null;
  /** candidate − official, unrounded seconds; negative = candidate faster. Null when the candidate is unavailable. */
  differenceSeconds: number | null;
  signalDirection: HrSignalDirection;
  /** "available": the HR evidence changes the estimate; "no_change": adequate evidence, no detectable effect; "unavailable": withheld. */
  status: "available" | "no_change" | "unavailable";
  supportingRuns: { baseline: number; recent: number; total: number };
  observationWeeks: { baseline: number; recent: number };
  window: { baseline: HrSignalPeriodWindow; recent: HrSignalPeriodWindow } | null;
  evidenceQuality: "adequate" | "limited" | "insufficient";
  unavailableCause: HrEnhancedUnavailableCause | null;
  reasons: HrSignalReason[];
  fallbackReason: string | null;
  adjustmentCap: { applied: boolean; capSeconds: number | null; uncappedSeconds: number | null };
  /** Blend weight toward the HR-implied value (0 = official). */
  blendWeight: number;
  /** Official adjustment fraction and HR-implied fraction, for transparent display. */
  fractions: { official: number; hrImplied: number | null; candidate: number | null };
  signal: HrEffortSignal | null;
  /** The unmodified official estimate this candidate adapts. */
  official: CurrentHalfEstimate;
  assumptions: string[];
  caveats: string[];
}
