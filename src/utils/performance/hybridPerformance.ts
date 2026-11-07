/**
 * Phase 3S — experimental hybrid current-capability estimate (experimental-hybrid-hm-v1).
 *
 * Four evidence families, combined by explicit rules rather than by stacking percentages on v2:
 *
 *  1 Demonstrated performance (BASE)   performance-capacity-v1 method C: race / strong-effort equivalents,
 *                                      recency- and quality-weighted. Independent of v2's volume heuristics and
 *                                      of an unexpired race anchor. Races enter ONCE, here.
 *  2 Physiological trend               aerobic-trend-v1 (pace at fixed HR/duration/climb/temperature over ~16 weeks).
 *                                      Used only as a CHANGE SINCE the demonstrated evidence's weighted date, so a
 *                                      recent strong effort that already contains the improvement is not counted
 *                                      twice. Shrunk by evidence precision (below); corroboration from the HR-enhanced
 *                                      signal and device VO₂ modulates the variance, it is never added.
 *  3 Race history                      informational: which races/efforts carry the base and how old they are.
 *  4 Endurance preparation             endurance-readiness-v1. (a) Sets the Riegel exponent for evidence shorter than
 *                                      the target (1.06 → 1.12 as readiness falls) — demonstrated speed is not endurance;
 *                                      (b) for evidence at ≈ target distance, a bounded adjustment for the CHANGE in
 *                                      readiness since that evidence.
 *
 * Combination (all assumptions are ENGINEERING choices, none validated):
 *  - Physiological change f_obs = κ·g·T (κ = 0.5 transfer, g = pace change per 28 d, T = min(days since evidence, 112)/28).
 *    Its influence is the precision weight s = τ²/(τ² + σ²): τ = 1 %·√(T_days/30) is the prior spread of true capacity
 *    change over that interval and σ² the squared uncertainty of f_obs (trend standard error and ±50 % transfer error,
 *    inflated ×1.5 when other physiological evidence disagrees). Noisy evidence therefore moves the estimate less, and
 *    never produces an exact-looking value. Cap ±2 %.
 *  - Endurance change f_E = −0.06·clamp(ΔP, ±0.5)·(share of base weight at ≈ target distance)·0.5 influence, cap ±1.5 %.
 *  - Correlated adjustments are not added: same sign → larger + ½·smaller; opposite signs → net sum and a
 *    `contradictory_signals` flag. Total |adjustment| ≤ 3 %.
 *  - Insufficient evidence lowers CONFIDENCE, never the number. Missing weather/HR/VO₂/readiness are listed, never
 *    treated as favourable. Nothing in the result is a calibrated interval: the range is an assumption-sensitivity
 *    set (alternative defensible parameters), labelled as such.
 * Fallbacks are explicit (see `hybridFallbacks` in the docs): no performance evidence, expired anchor only,
 * insufficient independent evidence, insufficient endurance preparation → unavailable, with the cause.
 */
import type { CurrentHalfEstimate } from "@/utils/experimentalCurrentPerformance";
import type { HrEnhancedEstimate } from "@/types/hrEnhancedPerformance";
import type {
  AerobicTrendEvidence, EnduranceReadiness, HybridFamilyContribution, HybridPerformanceEstimate, HybridUnavailableCause,
  PerformanceCapacityResult,
} from "@/types/hybridPerformance";
import type { RacePerformanceInput } from "@/types/racePerformance";
import type { HrStreamSummary } from "@/types/hybridPerformance";
import type { Vo2Entry } from "@/utils/vo2History";
import { HALF_MARATHON_METERS } from "@/utils/racePerformance";
import { isPerformanceInstant } from "@/utils/performanceEvidence";
import { selectResearchRuns } from "@/utils/workoutRaceResearch";
import { computeAerobicTrend, AEROBIC_TREND_POLICY } from "./aerobicTrend";
import { estimatePerformanceCapacity } from "./capacityMethods";
import { computeEnduranceReadiness } from "./enduranceReadiness";
import { qualifyPerformanceEvidence } from "./evidenceQualification";

export const HYBRID_VERSION = "experimental-hybrid-hm-v1" as const;
export const HYBRID_POLICY = Object.freeze({
  version: HYBRID_VERSION,
  baseExponent: 1.06, maximumExponent: 1.12,
  transferFraction: 0.5, transferUncertainty: 0.5,
  priorSpreadPerSqrtMonth: 0.01, disagreementInflation: 1.5,
  maximumPhysiologicalFraction: 0.02,
  enduranceCoefficient: 0.06, enduranceDeltaClamp: 0.5, enduranceInfluence: 0.5, maximumEnduranceFraction: 0.015,
  atTargetRatio: 1.25,
  correlatedOverlap: 0.5, maximumTotalFraction: 0.03,
  minimumReadiness: 0.2, moderateReadiness: 0.5, /* endurance support = max(readiness, share of base at ≈ target distance) */
  contradictoryMinimumFraction: 0.002,
  alternative: { exponent: 1.1, transferLow: 0.25, transferHigh: 0.75 },
});

type Input = Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">;
export interface HybridOptions {
  targetDistanceMeters?: number;
  /** Already computed for these exact inputs by the caller (Plan Insights); used only for display comparison and corroboration. */
  official?: CurrentHalfEstimate | null;
  hrEnhanced?: HrEnhancedEstimate | null;
  /** Optional, bounded sources (never fetched here). */
  vo2Entries?: readonly Vo2Entry[];
  streamSummaries?: Readonly<Record<string, HrStreamSummary>>;
  /** SCENARIO ONLY (race-day forecast): replaces the measured readiness score for the exponent and the endurance-change term. */
  readinessOverride?: number;
}
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
const mmss = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;

const ASSUMPTIONS = [
  "Experimental and provisional: not independently validated and not the official estimate.",
  "Base = recency/quality-weighted race equivalence (Riegel, fixed population-style exponent 1.06 for well-prepared athletes, up to 1.12 as endurance preparation falls). Weights, the 42-day half-life and all thresholds are engineering assumptions.",
  "Physiological evidence enters as a change since the demonstrated evidence, shrunk by its own precision; half of a pace-at-heart-rate change is assumed to transfer to race time (the fraction v2 already uses), capped at ±2 %.",
  "Endurance preparation sets the exponent for shorter-distance evidence and a bounded (±1.5 %) adjustment when evidence at ≈ target distance is older than a change in preparation. Break-points are engineering assumptions.",
  "Correlated adjustments are combined (larger + ½ smaller), never added; total adjustment ≤ 3 %.",
  "No calibrated confidence interval exists. The range shown is an assumption-sensitivity range, not a statistical interval.",
  "Whole-minute finish and five-second pace rounding are presentation choices.",
];

function emptyContributions(reason: string): HybridFamilyContribution[] {
  return (["demonstrated_performance", "physiological_trend", "race_history", "endurance_readiness"] as const)
    .map(family => ({ family, status: "unavailable" as const, seconds: 0, fraction: 0, influence: 0, explanation: reason }));
}

export function estimateHybridHalfMarathon(input: Input, options: HybridOptions = {}): HybridPerformanceEstimate {
  if (!isPerformanceInstant(input.asOf)) throw new TypeError("A valid hybrid-estimate cutoff is required");
  const P = HYBRID_POLICY, target = options.targetDistanceMeters ?? HALF_MARATHON_METERS;
  const overrides = input.overrides ?? {};
  const qualification = qualifyPerformanceEvidence(input);
  const asOfDate = qualification.asOfDate;
  const { runs } = selectResearchRuns({ ...input, overrides, capturedAt: input.asOf, source: "owner_parent_export",
    complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
  const raceWorkoutIds = new Set(input.races.flatMap(r => r.actualRunId ? [r.actualRunId] : []));

  const measuredReadiness = computeEnduranceReadiness({ runs, raceWorkoutIds, asOfDate, targetDistanceMeters: target });
  const readiness: EnduranceReadiness = options.readinessOverride === undefined ? measuredReadiness
    : { ...measuredReadiness, score: clamp(options.readinessOverride, 0, 1), reasons: [...measuredReadiness.reasons, "scenario_readiness_override"] };
  const exponent = readiness.score === null ? P.baseExponent : P.baseExponent + (P.maximumExponent - P.baseExponent) * (1 - readiness.score);
  const capacity = estimatePerformanceCapacity(input, { targetDistanceMeters: target, exponent, qualification });
  const physiology = computeAerobicTrend({ runs, raceWorkoutIds, asOf: input.asOf, asOfDate, streamSummaries: options.streamSummaries, vo2Entries: options.vo2Entries });

  const official = options.official ?? null, hr = options.hrEnhanced ?? null;
  const officialSeconds = official && official.baselineSeconds !== null && official.finishMinutes !== null ? official.baselineSeconds + official.adjustmentSeconds : null;
  const hrSeconds = hr?.candidateSeconds ?? null;
  const missing: string[] = [];
  const flags: string[] = [...capacity.flags];
  const caveats = ["The official estimate remains the primary prediction; this is a labelled experiment beside it.",
    "Not independently validated: there are not yet enough qualified race outcomes to test whether it is more accurate."];

  const shell = (status: HybridPerformanceEstimate["status"], cause: HybridUnavailableCause | null, reason: string, extra: Partial<HybridPerformanceEstimate> = {}): HybridPerformanceEstimate => ({
    version: HYBRID_VERSION, researchStatus: "experimental_provisional", validated: false, asOf: input.asOf, asOfDate, dataThrough: capacity.dataThrough,
    targetDistanceMeters: target, status, unavailableCause: cause, seconds: null, minutes: null, paceSecondsPerMile: null,
    evidenceQuality: capacity.evidenceQuality, confidence: null, sensitivityRange: null, contributions: emptyContributions(reason), capacity, physiology, readiness,
    adjustmentFraction: 0, comparison: { officialSeconds, hrEnhancedSeconds: hrSeconds, differenceVsOfficialSeconds: null, differenceVsHrEnhancedSeconds: null },
    flags, missing, reasons: [reason], fallbackReason: reason, assumptions: ASSUMPTIONS, caveats, ...extra });

  if (capacity.status === "unavailable" || capacity.seconds === null) {
    const raw = capacity.unavailableCause;
    const cause: HybridUnavailableCause = raw === null ? "no_performance_evidence" : raw === "unsupported_distance" ? "invalid_input" : raw;
    const reason = capacity.reasons[0] ?? "No qualifying performance evidence.";
    if (physiology.status === "available") missing.push("Maximal-performance evidence (a physiological trend alone is never converted into a finish time)");
    return shell("unavailable", cause, reason);
  }
  // Endurance support = recent preparation, or endurance already demonstrated by evidence at ≈ the target distance.
  // Using the larger avoids withholding a race-based estimate during a normal post-race lull, and avoids a hard
  // day-to-day flip: both quantities move continuously.
  const rowsEarly = capacity.methods.find(m => m.id === "C_recent_demonstrated")!.contributions;
  const demonstratedShare = rowsEarly.filter(r => r.extrapolationRatio <= P.atTargetRatio && r.extrapolationRatio >= 0.8).reduce((s, r) => s + r.weightShare, 0);
  const support = readiness.score === null ? null : Math.max(readiness.score, demonstratedShare);
  if (support !== null && support < P.minimumReadiness && target >= HALF_MARATHON_METERS - 25) {
    flags.push("endurance_unprepared");
    return shell("unavailable", "insufficient_endurance_preparation",
      `Recent long-run, volume and frequency evidence (readiness ${(readiness.score! * 100).toFixed(0)}%) is too low, and no recent race-distance performance demonstrates the endurance, to carry a half-marathon time. Demonstrated speed is shown separately as capacity; endurance readiness is a different question.`);
  }
  if (readiness.score === null) { flags.push("readiness_unknown"); missing.push("Endurance readiness (fewer than four recent weeks with recorded runs)"); }

  // ── Demonstrated-performance base and its reference date. ──
  const rows = capacity.methods.find(m => m.id === "C_recent_demonstrated")!.contributions;
  const base = capacity.seconds;
  const refDay = rows.reduce((s, r) => s + dayNumber(r.date) * r.weightShare, 0);
  const refDate = new Date(refDay * 86_400_000).toISOString().slice(0, 10);
  const daysSinceRef = Math.max(0, dayNumber(asOfDate) - refDay);
  const raceShare = rows.filter(r => r.kind === "confirmed_race" || r.kind === "recorded_race").reduce((s, r) => s + r.weightShare, 0);
  const atTargetShare = rows.filter(r => r.extrapolationRatio <= P.atTargetRatio && r.extrapolationRatio >= 0.8).reduce((s, r) => s + r.weightShare, 0);

  // ── Physiological family: change since the demonstrated evidence, shrunk by precision. ──
  const fPhysAt = (kappa: number) => {
    if (physiology.status !== "available" || physiology.slopePer28d === null || physiology.standardError === null
      || physiology.classification === "no_detectable_change" || physiology.classification === "unavailable") return { f: 0, influence: 0, observed: 0 };
    const T = Math.min(daysSinceRef, AEROBIC_TREND_POLICY.windowDays) / 28;
    const observed = kappa * physiology.slopePer28d * T;
    const hrDisagrees = hr?.signal?.status === "available" && ((hr.signalDirection === "improved" && observed > 0) || (hr.signalDirection === "declined" && observed < 0));
    const vo2Disagrees = physiology.vo2Corroboration === "disagrees";
    const inflate = hrDisagrees || vo2Disagrees ? P.disagreementInflation : 1;
    const sigma2 = ((kappa * physiology.standardError * T) ** 2 + (P.transferUncertainty * observed) ** 2) * inflate ** 2;
    const tau2 = (P.priorSpreadPerSqrtMonth * Math.sqrt(Math.max(daysSinceRef, 1) / 30)) ** 2;
    const s = sigma2 + tau2 > 0 ? tau2 / (tau2 + sigma2) : 0;
    return { f: clamp(s * observed, -P.maximumPhysiologicalFraction, P.maximumPhysiologicalFraction), influence: s, observed };
  };
  const physiologyStatus = physiology.status === "available" && physiology.classification !== "no_detectable_change" ? "used" : physiology.status === "available" ? "no_effect" : "unavailable";
  if (physiology.status !== "available") missing.push("Multiweek aerobic-efficiency trend (" + (physiology.reasons[0] ?? "insufficient runs") + ")");
  if (physiology.flags.includes("weather_unadjusted")) missing.push("Weather for enough comparison runs (heat could explain part of any pace change; not assumed equal)");
  if (physiology.vo2.direction === "unavailable") missing.push("Apple Health VO₂ max readings for corroboration (optional)");
  if (physiology.hrSource === "parent_average" && physiology.status === "available") missing.push("Warm-up-trimmed heart-rate streams (whole-workout average HR includes the warm-up)");
  const phys = fPhysAt(P.transferFraction);

  // ── Endurance family: change in readiness since the evidence, only for evidence near the target distance. ──
  let fE = 0, enduranceStatus: HybridFamilyContribution["status"] = "unavailable", readinessThen: EnduranceReadiness | null = null;
  if (readiness.score !== null) {
    readinessThen = computeEnduranceReadiness({ runs, raceWorkoutIds, asOfDate: refDate, targetDistanceMeters: target });
    if (readinessThen.score !== null && atTargetShare > 0) {
      const delta = clamp(readiness.score - readinessThen.score, -P.enduranceDeltaClamp, P.enduranceDeltaClamp);
      fE = clamp(-P.enduranceCoefficient * delta * atTargetShare * P.enduranceInfluence, -P.maximumEnduranceFraction, P.maximumEnduranceFraction);
      enduranceStatus = fE === 0 ? "no_effect" : "used";
    } else enduranceStatus = "no_effect";
  }

  // ── Correlated combination. ──
  const combine = (a: number, b: number) => {
    const same = Math.sign(a) * Math.sign(b) > 0;
    const total = !a || !b ? a + b : same ? (Math.abs(a) >= Math.abs(b) ? a + P.correlatedOverlap * b : b + P.correlatedOverlap * a) : a + b;
    return clamp(total, -P.maximumTotalFraction, P.maximumTotalFraction);
  };
  const contradictory = Math.sign(phys.f) * Math.sign(fE) < 0 && Math.abs(phys.f) >= P.contradictoryMinimumFraction && Math.abs(fE) >= P.contradictoryMinimumFraction;
  if (contradictory) flags.push("contradictory_signals");
  if (physiology.vo2Corroboration === "disagrees") flags.push("vo2_disagrees");
  const total = combine(phys.f, fE);
  const seconds = base * (1 + total);

  // ── Assumption-sensitivity range: alternative defensible parameter sets (not a statistical interval). ──
  const variants: number[] = [seconds];
  for (const exp of [P.baseExponent, P.alternative.exponent]) {
    const alt = estimatePerformanceCapacity(input, { targetDistanceMeters: target, exponent: exp, qualification }).seconds;
    if (alt !== null) for (const k of [P.alternative.transferLow, P.alternative.transferHigh]) variants.push(alt * (1 + combine(fPhysAt(k).f, fE)));
    if (alt !== null) variants.push(alt);
  }
  const confirmedOnly = { ...qualification, independent: qualification.independent.filter(i => i.kind === "confirmed_race" || i.kind === "recorded_race") };
  if (confirmedOnly.independent.length && confirmedOnly.independent.length < qualification.independent.length) {
    const alt = estimatePerformanceCapacity(input, { targetDistanceMeters: target, exponent, qualification: confirmedOnly }).seconds;
    if (alt !== null) variants.push(alt * (1 + total));
  }
  const sensitivityRange = { fastSeconds: Math.min(...variants), slowSeconds: Math.max(...variants),
    basis: "Alternative defensible assumptions (distance exponent 1.06 vs 1.10, 25–75 % physiological transfer, with and without strong unconfirmed efforts). Not a statistical interval." };

  const confidence: HybridPerformanceEstimate["confidence"] = capacity.evidenceQuality === "adequate" && (readiness.score ?? 0) >= P.moderateReadiness
    && !flags.includes("contradictory_evidence") && !contradictory ? "moderate" : "low";
  const status: HybridPerformanceEstimate["status"] = capacity.status === "provisional" || contradictory || readiness.score === null ? "provisional" : "available";
  const minutes = Math.round(seconds / 60);
  const miles = target / 1609.344;
  const contributions: HybridFamilyContribution[] = [
    { family: "demonstrated_performance", status: "used", seconds: 0, fraction: 0, influence: 1,
      explanation: `Base ${mmss(base)} from ${rows.length} independent performance${rows.length === 1 ? "" : "s"} (exponent ${exponent.toFixed(3)}); evidence quality ${capacity.evidenceQuality}.` },
    { family: "physiological_trend", status: physiologyStatus, seconds: base * phys.f, fraction: phys.f, influence: phys.influence,
      explanation: physiology.status !== "available" ? `Unavailable: ${physiology.reasons[0] ?? "insufficient evidence"}`
        : physiology.classification === "no_detectable_change" ? `No sustained change in pace at a given heart rate across ${physiology.runs} runs / ${physiology.weeks} weeks.`
        : `Pace at a given heart rate ${physiology.classification === "observed_improvement" ? "improved" : "declined"} ${(Math.abs(physiology.slopePer28d!) * 100).toFixed(1)}% per 28 days; ${daysSinceRef.toFixed(0)} days since the demonstrated evidence; shrunk by precision to ${(phys.influence * 100).toFixed(0)}% influence.` },
    { family: "race_history", status: raceShare > 0 ? "used" : "no_effect", seconds: 0, fraction: 0, influence: raceShare,
      explanation: raceShare > 0 ? `Races carry ${(raceShare * 100).toFixed(0)}% of the base weight (counted once, inside the demonstrated family).`
        : `No race currently contributes${qualification.expired.length ? `; ${qualification.expired.length} older than 180 days carry no weight` : ""}.` },
    { family: "endurance_readiness", status: enduranceStatus, seconds: base * fE, fraction: fE, influence: enduranceStatus === "used" ? P.enduranceInfluence : 0,
      explanation: readiness.score === null ? "Readiness unknown (too few recent weeks recorded); no adjustment, confidence reduced."
        : `Readiness ${(readiness.score * 100).toFixed(0)}% (longest ${readiness.longestRunMiles?.toFixed(1)} mi, ${readiness.weeklyMiles?.toFixed(0)} mi/wk). Sets the extrapolation exponent${enduranceStatus === "used" ? `; change since the evidence (${readinessThen?.score === null || !readinessThen ? "?" : (readinessThen.score * 100).toFixed(0) + "%"} → ${(readiness.score * 100).toFixed(0)}%) adjusts the base` : ""}.` },
  ];
  return shell(status, null, "", { seconds, minutes, paceSecondsPerMile: Math.round(minutes * 60 / miles / 5) * 5, confidence, sensitivityRange,
    contributions, adjustmentFraction: total, flags: [...new Set(flags)], fallbackReason: null, reasons: capacity.reasons,
    comparison: { officialSeconds, hrEnhancedSeconds: hrSeconds, differenceVsOfficialSeconds: officialSeconds === null ? null : seconds - officialSeconds,
      differenceVsHrEnhancedSeconds: hrSeconds === null ? null : seconds - hrSeconds } });
}

export type { PerformanceCapacityResult, AerobicTrendEvidence };
