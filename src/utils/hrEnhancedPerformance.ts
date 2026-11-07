/**
 * Experimental HR-enhanced half-marathon estimate (experimental-hr-enhanced-hm-v1).
 *
 * An ADAPTER over the official `experimental-current-hm-v2` estimator: it reuses the
 * official result unchanged (race anchor, expiry, exclusions, as-of handling, training
 * evidence) and never alters it. It adds one more kind of evidence, "pace at a
 * comparable heart rate", from `computeHrEffortSignal`.
 *
 * CONVERSION TO RACE TIME (explicit, bounded, provisional — not a validated calibration)
 *   HR-implied fraction  f_hr = clamp(0.5 × shrunk pace change at constant HR, ±2 %)
 *     – 0.5 is the transfer fraction v2 already uses for matched-effort pace evidence.
 *   Blend weight         w = 0.5 × strength × freshness           (strength ∈ [0,1], same freshness as v2)
 *   Candidate fraction   f_c = f_official + move,  move = w × (f_hr − f_official), kept only in the
 *                        direction the HR evidence points (sign-consistent)
 *     – a BLEND, not a sum: v2 states that correlated signals are not added (its volume/
 *       frequency summary and matched-pace evidence replace one another). HR evidence that
 *       clears its noise threshold replaces part of the official training adjustment, but a
 *       favourable HR signal smaller than the official gain never pulls the estimate back.
 *   Hard cap             |f_c − f_official| ≤ 1.5 % of the race-equivalent baseline.
 *
 * Degradation: an unavailable or non-directional HR signal returns the official number
 * (candidate = official, or no candidate at all) — never a different methodology.
 * This module is read-only: no Firestore, no wall clock, no persistence.
 */
import type { RacePerformanceInput } from "@/types/racePerformance";
import type { HrEnhancedEstimate, HrEnhancedUnavailableCause, HrSignalReason } from "@/types/hrEnhancedPerformance";
import { estimateCurrentHalfMarathon, CURRENT_HALF_POLICY, type CurrentHalfEstimate } from "./experimentalCurrentPerformance";
import { computeHrEffortSignal, HR_SIGNAL_POLICY, HR_SIGNAL_VERSION } from "./hrEffortSignal";
import { isPerformanceInstant, performanceLocalDate } from "./performanceEvidence";
import { HALF_MARATHON_METERS } from "./racePerformance";
import { selectResearchRuns } from "./workoutRaceResearch";

export const HR_ENHANCED_VERSION = "experimental-hr-enhanced-hm-v1" as const;

export const HR_ENHANCED_POLICY = Object.freeze({
  version: HR_ENHANCED_VERSION,
  /** Same transfer fraction v2 applies to matched-effort pace evidence. */
  transferFraction: 0.5,
  maximumSignalFraction: 0.02,
  maximumBlendWeight: 0.5,
  maximumDifferenceFraction: 0.015,
  strongEvidenceStrength: 0.5,
});

type Input = Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export const HR_REASON_TEXT: Record<HrSignalReason, string> = {
  no_outdoor_hr_runs: "No steady outdoor runs with valid average heart rate fall in the comparison windows.",
  insufficient_baseline_runs: "Too few steady runs with comparable heart rate before the race anchor.",
  insufficient_recent_runs: "Too few recent steady runs with comparable heart rate.",
  insufficient_baseline_weeks: "The comparable pre-race runs cover too few separate weeks.",
  insufficient_recent_weeks: "The comparable recent runs cover too few separate weeks.",
  no_hr_overlap: "Your pre-race and recent runs were run at different heart rates, so they cannot be compared without extrapolating.",
  effort_differs: "Typical heart rate differs too much between the two periods to separate fitness from effort.",
  duration_mix_differs: "Typical run length changed too much between the two periods to compare fairly.",
  slope_not_estimable: "Heart-rate range is too narrow to separate effort from fitness reliably.",
  inconsistent_across_weeks: "Recent weeks disagree with each other, so the change is not consistent enough to use.",
  no_recent_window: "There is no recent comparison window after the race anchor yet.",
};

const NOT_AVAILABLE_ASSUMPTIONS = [
  "Experimental and provisional: not independently validated, and not the official estimate.",
];
const ASSUMPTIONS = [
  ...NOT_AVAILABLE_ASSUMPTIONS,
  "Compares steady outdoor runs at similar average heart rate in the 56 days before the anchor race (excluding the final 8 days) with the last 42 days; nothing outside the shared heart-rate range is extrapolated.",
  "Same average HR is not proof of equal effort: heat, fatigue, terrain, caffeine and sensor error can all move pace at a given HR. Weather is compared when available; missing weather halves the strength rather than assuming equal conditions.",
  "Treadmill/indoor and route-less runs, hard-labelled sessions, race results, implausible pace/HR combinations and terrain outliers are never used.",
  "Conversion: half of the shrunk pace change at constant HR transfers to race time (the fraction v2 uses for matched-effort evidence), capped at ±2 %, blended with the official adjustment (never added to it), at most 50 % weight, and never more than 1.5 % away from the official estimate.",
  "The contrast is shrunk by one standard error and computed with both the estimated and a doubled HR–pace slope (the smaller magnitude is used) because aggregate average-HR data attenuates that slope.",
  "No confidence interval is supported. Whole-minute rounding is a presentation choice.",
];

function freshnessOf(official: CurrentHalfEstimate): number {
  const age = official.anchor?.ageDays ?? null, since = official.diagnostics.daysSinceTrainingRun;
  if (age === null || since === null) return 0;
  return clamp((CURRENT_HALF_POLICY.maximumAnchorDays - age) / 90, 0, 1) * clamp((42 - since) / 28, 0, 1);
}

function unavailable(official: CurrentHalfEstimate, cause: HrEnhancedUnavailableCause, fallbackReason: string,
  extra: Partial<HrEnhancedEstimate> = {}): HrEnhancedEstimate {
  const officialSeconds = official.baselineSeconds === null || official.finishMinutes === null ? null : official.baselineSeconds + official.adjustmentSeconds;
  return {
    version: HR_ENHANCED_VERSION, signalVersion: HR_SIGNAL_VERSION, researchStatus: "experimental_provisional", validated: false,
    asOf: official.asOf, anchorRaceId: official.anchor?.raceId ?? null, anchorDate: official.anchor?.raceDate ?? null,
    officialVersion: official.version, officialSeconds, officialMinutes: official.finishMinutes,
    candidateSeconds: null, candidateMinutes: null, candidatePaceSecondsPerMile: null, differenceSeconds: null,
    signalDirection: "unavailable", status: "unavailable",
    supportingRuns: { baseline: 0, recent: 0, total: 0 }, observationWeeks: { baseline: 0, recent: 0 }, window: null,
    evidenceQuality: "insufficient", unavailableCause: cause, reasons: [], fallbackReason,
    adjustmentCap: { applied: false, capSeconds: null, uncappedSeconds: null }, blendWeight: 0,
    fractions: { official: official.baselineSeconds ? official.adjustmentSeconds / official.baselineSeconds : 0, hrImplied: null, candidate: null },
    signal: null, official, assumptions: ASSUMPTIONS,
    caveats: ["The official estimate is unchanged and remains the primary prediction."], ...extra,
  };
}

/**
 * `options.official` lets a caller that already computed the official estimate for these exact inputs
 * (Plan Insights) avoid recomputing it; it must carry the same `asOf`.
 */
export function estimateHrEnhancedHalfMarathon(input: Input, options: { official?: CurrentHalfEstimate } = {}): HrEnhancedEstimate {
  if (!isPerformanceInstant(input.asOf)) throw new TypeError("A valid HR-enhanced estimate cutoff is required");
  const official = options.official ?? estimateCurrentHalfMarathon(input);
  if (official.asOf !== input.asOf) throw new TypeError("The supplied official estimate was computed for a different cutoff");
  if (!official.anchor || official.baselineSeconds === null || official.finishMinutes === null)
    return unavailable(official, "official_unavailable", `The official estimate is unavailable (${official.reason}) so no HR-enhanced estimate is calculated.`);

  const asOfDate = performanceLocalDate(input.asOf, input.timeZone);
  const { runs } = selectResearchRuns({ ...input, overrides: input.overrides ?? {}, capturedAt: input.asOf,
    source: "owner_parent_export", complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
  const raceWorkoutIds = new Set(input.races.flatMap(r => r.actualRunId ? [r.actualRunId] : []));
  const signal = computeHrEffortSignal({ runs, raceWorkoutIds, anchorDate: official.anchor.raceDate, asOfDate, asOf: input.asOf });
  const summary = {
    signal, window: signal.window,
    supportingRuns: { ...signal.counts.supported, total: signal.counts.supported.baseline + signal.counts.supported.recent },
    observationWeeks: signal.counts.weeks,
  };
  if (signal.status === "suppressed")
    return unavailable(official, "evidence_insufficient", signal.reasons.map(r => HR_REASON_TEXT[r]).join(" "),
      { ...summary, reasons: signal.reasons });

  const freshness = freshnessOf(official);
  if (freshness <= 0)
    return unavailable(official, "evidence_stale", "The race anchor or the latest supplied run is too old for the heart-rate evidence to carry weight.", { ...summary });
  const strength = signal.strength.combined * freshness;
  if (strength <= 0)
    return unavailable(official, "evidence_insufficient", signal.weather.factor === 0
      ? "Typical temperature differs too much between the two periods to separate fitness from heat."
      : "The comparison runs are too thin to carry weight.", { ...summary });

  const base = official.baselineSeconds, officialSeconds = base + official.adjustmentSeconds;
  const fOfficial = official.adjustmentSeconds / base;
  const shrunk = signal.contrast.shrunk ?? 0;
  const fHr = clamp(HR_ENHANCED_POLICY.transferFraction * shrunk, -HR_ENHANCED_POLICY.maximumSignalFraction, HR_ENHANCED_POLICY.maximumSignalFraction);
  const w = HR_ENHANCED_POLICY.maximumBlendWeight * strength;
  const evidenceQuality: HrEnhancedEstimate["evidenceQuality"] = strength >= HR_ENHANCED_POLICY.strongEvidenceStrength ? "adequate" : "limited";

  const directional = shrunk !== 0;
  // Sign-consistent blend: HR evidence may only move the estimate in the direction it points. A favourable HR
  // signal that is smaller than the official improvement does not pull the estimate back (absence of a larger
  // HR gain is not evidence against the official one), and vice versa.
  const blended = w * (fHr - fOfficial);
  const rawMove = !directional ? 0 : shrunk < 0 ? Math.min(0, blended) : Math.max(0, blended);
  const uncappedFraction = fOfficial + rawMove;
  const cap = HR_ENHANCED_POLICY.maximumDifferenceFraction;
  const cappedFraction = fOfficial + clamp(rawMove, -cap, cap);
  const candidateSeconds = base * (1 + cappedFraction);
  const candidateMinutes = Math.round(candidateSeconds / 60);
  const differenceSeconds = Math.abs(candidateSeconds - officialSeconds) < 1e-9 ? 0 : candidateSeconds - officialSeconds;
  const caveats = [
    "The official estimate remains the primary prediction; this is a labelled experiment beside it.",
    "Not independently validated: there are not yet enough qualified race outcomes to test whether it is more accurate.",
    ...(signal.flags.includes("weather_partial") ? ["Weather was missing for many comparison runs, so heat could explain part of the change. Strength was halved."] : []),
    ...(signal.flags.includes("weather_differs") ? ["Typical temperature differs between the two periods, so strength was reduced."] : []),
    ...(signal.flags.includes("slope_sensitive") ? ["The result depends on how steeply pace responds to heart rate; the smaller of two plausible readings was used."] : []),
  ];
  return {
    version: HR_ENHANCED_VERSION, signalVersion: HR_SIGNAL_VERSION, researchStatus: "experimental_provisional", validated: false,
    asOf: input.asOf, anchorRaceId: official.anchor.raceId, anchorDate: official.anchor.raceDate,
    officialVersion: official.version, officialSeconds, officialMinutes: official.finishMinutes,
    candidateSeconds, candidateMinutes,
    candidatePaceSecondsPerMile: Math.round(candidateMinutes * 60 / (HALF_MARATHON_METERS / 1609.344) / 5) * 5,
    differenceSeconds, signalDirection: signal.direction, status: differenceSeconds !== 0 ? "available" : "no_change",
    ...summary, evidenceQuality, unavailableCause: null, reasons: [],
    fallbackReason: differenceSeconds !== 0 ? null : directional
      ? "Pace at comparable heart rate moved in the same direction, but the official estimate already assumes at least that much, so the HR evidence adds nothing beyond it."
      : "Pace at comparable heart rate shows no change that clears the noise threshold, so the official estimate is unchanged.",
    adjustmentCap: { applied: Math.abs(uncappedFraction - fOfficial) > cap, capSeconds: base * cap, uncappedSeconds: base * (uncappedFraction - fOfficial) },
    blendWeight: directional ? w : 0,
    fractions: { official: fOfficial, hrImplied: directional ? fHr : null, candidate: cappedFraction },
    official, assumptions: ASSUMPTIONS, caveats,
  };
}

export { HR_SIGNAL_POLICY, HR_SIGNAL_VERSION };
