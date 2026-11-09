/**
 * Hybrid Performance Model v1.1 (experimental-hybrid-hm-v1.1) — current-capability estimate that learns from credible
 * newer evidence instead of staying tethered to an old race. Separately versioned; `experimental-hybrid-hm-v1` is unchanged
 * and remains reproducible (stored v1 results are never reinterpreted as v1.1).
 *
 * What changed relative to v1 (all constants are ENGINEERING ASSUMPTIONS, none fitted to a race outcome):
 *  1 Evidence    performance-evidence-v1.1 adds sustained segments (tempo/progression/fast-finish/hard 10 K inside a run) as a
 *                submaximal lower-bound category on top of the unchanged v1 qualification (`evidenceSegments.ts`).
 *  2 Weighting   a precision-weighted two-group combination (`evidenceCombination.ts`): races and newer efforts are observations
 *                with explicit, age-growing uncertainty; evidence mass — not a renormalised weight — decides how far newer
 *                efforts displace a race. With no newer evidence the race is unchanged (uncertainty grows, the number does not);
 *                a lone or uncorroborated effort cannot displace it; slower evidence needs corroboration and is weaker than faster.
 *  3 Physiology  the v1 aerobic-trend term (pace at fixed HR/duration/climb/temperature), now fed by bounded, screened HR streams
 *                (interval-like streams leave the steady-state regression; unstreamed runs are offset-calibrated) and by Apple
 *                Health VO₂ max for CORROBORATION ONLY: a disagreeing VO₂ direction raises the physiological uncertainty, an agreeing
 *                one is disclosed; VO₂ never enters the finish time and never raises confidence (device estimate, no validated
 *                conversion). The change is measured SINCE the evidence's effective date, so a recent effort that already contains
 *                an improvement is not counted twice.
 *  4 Endurance   endurance-readiness-v1 unchanged: it sets the exponent for sources shorter than the target and a bounded
 *                (±1.5 %) change term for at-target evidence. Training load / CTL / ATL / TSB / intensity distribution were evaluated and
 *                are NOT numerical terms (see docs): they largely restate the same training exposure the readiness score already
 *                uses and no outcome evidence supports a coefficient.
 *  5 Reporting   effective contribution diagnostics that reconcile with the calculation, evidence age/freshness, conflicts
 *                reported (never summed away), provisional reasons, and an assumption-sensitivity range (never an interval).
 * Insufficient evidence lowers CONFIDENCE, never the number. A failed VO₂/stream load degrades to the lower-evidence calculation
 * and says so; it never substitutes a plausible-looking value.
 */
import type { CurrentHalfEstimate } from "@/utils/experimentalCurrentPerformance";
import type { HrEnhancedEstimate } from "@/types/hrEnhancedPerformance";
import type { AerobicTrendEvidence, EnduranceReadiness, HybridFamilyContribution, HybridUnavailableCause, HrStreamSummary } from "@/types/hybridPerformance";
import type {
  ConflictSignal, DemonstratedRaceDisclosure, EvidenceCombination, HistoricalInfluence, HrStreamDisclosure, HybridV11Estimate, TargetDisclosure, Vo2Disclosure,
} from "@/types/hybridPerformanceV11";
import type { RacePerformanceInput } from "@/types/racePerformance";
import type { Vo2Entry } from "@/utils/vo2History";
import { buildRaceEvidence, HALF_MARATHON_METERS } from "@/utils/racePerformance";
import { isPerformanceInstant } from "@/utils/performanceEvidence";
import { selectResearchRuns } from "@/utils/workoutRaceResearch";
import { AEROBIC_TREND_POLICY, computeAerobicTrend } from "./aerobicTrend";
import { combineEvidence, COMBINATION_POLICY, type CombinationParams } from "./evidenceCombination";
import { computeEnduranceReadiness } from "./enduranceReadiness";
import { DEMONSTRATED_RACE_REASON, isDemonstratedRaceEvidence } from "./evidenceQualification";
import { qualifyEvidenceV11 } from "./evidenceSegments";
import { HYBRID_POLICY, type HybridOptions } from "./hybridPerformance";
import type { TargetProfile } from "./hybridTargetProfiles";
import type { HybridPerformanceEstimate } from "@/types/hybridPerformance";

export const HYBRID_V11_VERSION = "experimental-hybrid-hm-v1.1" as const;
export const HYBRID_V11_POLICY = Object.freeze({
  version: HYBRID_V11_VERSION,
  /** Inherited unchanged from v1: physiology, endurance and correlated-combination terms. */
  base: HYBRID_POLICY,
  /** A displacement smaller than this is not a "recent performance direction" for conflict detection. */
  conflictDisplacementFraction: 0.005, conflictPhysiologyFraction: 0.002, conflictReadinessDrop: 0.15,
  sensitivity: { exponents: [1.06, 1.10], transfers: [0.25, 0.75], commonModeScale: [0.5, 2], drift: [0.005, 0.015], measurementScale: [0.75, 1.25] },
});

type Input = Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">;
export type LoadState = "not_requested" | "loaded" | "failed";
export interface HybridV11Options extends HybridOptions {
  /** The v1 estimate for the same inputs, for display comparison only. */
  hybridV1?: HybridPerformanceEstimate | null;
  /** Whether the optional sources were requested/loaded (a failed load is disclosed, never replaced by a plausible value). */
  vo2Load?: LoadState;
  streamLoad?: LoadState;
  /** RESEARCH SWEEPS ONLY (never set by live code): alternative evidence-combination parameters for the primary calculation. */
  combinationParams?: CombinationParams;
  /** Rollback / strict research replay: ignore confirmed hard/nonmaximal races entirely (the pre-policy v1.1 behaviour, bit for bit). */
  strictMaximalOnly?: boolean;
  /**
   * Distance-aware target profile (5K / 10 mi / half / marathon; see `hybridTargetProfiles.ts`). Absent = the pre-existing half-marathon-only
   * behaviour, bit for bit. The half-marathon profile reproduces it exactly; the others change only distance-dependent parameters.
   */
  profile?: TargetProfile;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
const mmss = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;

const ASSUMPTIONS = [
  "Experimental and provisional: not independently validated and not the official estimate. Version v1.1 supersedes v1 for display; v1 remains reproducible.",
  "Evidence is combined by precision: each performance has an internal uncertainty (measurement kind, distance extrapolation, and age growing as 1 %·√(days/30)); races and newer efforts are pooled as two groups with common-mode terms. All constants are engineering assumptions, not fitted to any outcome.",
  "An old race is not made faster or slower by age: with no newer evidence it stays the best point estimate and only its uncertainty grows. Newer evidence displaces it only as far as its own evidence mass supports.",
  "Sustained segments (tempo, progression, fast finish, hard 10 K inside a run) are submaximal lower bounds; a slower-than-estimate segment is ignored and a slower unconfirmed effort is weaker evidence than a faster one.",
  "Physiological evidence enters as a change since the evidence's effective date, shrunk by its own precision, capped at ±2 %; Apple Health VO₂ max only corroborates and never enters the finish time.",
  "Endurance preparation sets the exponent for shorter-distance evidence and a bounded (±1.5 %) adjustment for at-target evidence; training-load, fatigue and intensity-distribution metrics add no numerical term.",
  "No calibrated confidence interval exists. The range shown is an assumption-sensitivity range, not a statistical interval.",
  "Whole-minute finish and five-second pace rounding are presentation choices.",
];

function vo2Disclosure(physiology: AerobicTrendEvidence | null, entries: readonly Vo2Entry[] | undefined, load: LoadState): Vo2Disclosure {
  const v = physiology?.vo2;
  const base = { readings: v?.readings ?? 0, direction: v?.direction ?? "unavailable" as const, corroboration: physiology?.vo2Corroboration ?? "unavailable" as const,
    discontinuity: v?.discontinuity ?? false, recentMedian: v?.recentMedian ?? null, priorMedian: v?.priorMedian ?? null };
  if (load === "failed") return { ...base, availability: "load_failed", effect: "none", note: "VO₂ max readings could not be loaded; the estimate was calculated without them (they only corroborate)." };
  if (load === "not_requested" && !entries?.length) return { ...base, availability: "not_requested", effect: "none", note: "VO₂ max readings were not supplied." };
  if (!entries?.length || base.readings === 0) return { ...base, availability: "no_readings", effect: "none", note: "VO₂ max: no plausible Apple Health readings before the calculation date. Unavailable is not the same as stable." };
  if (base.direction === "unavailable") return { ...base, availability: "sparse", effect: "none", note: `VO₂ max: only ${base.readings} usable readings across the two 28-day windows (3 needed in each), so corroboration is unavailable.` };
  const effect: Vo2Disclosure["effect"] = base.corroboration === "disagrees" ? "raised_physiological_uncertainty" : base.corroboration === "agrees" ? "corroboration_disclosed_only" : "none";
  const text = base.discontinuity ? "A discontinuity in the readings makes the direction inconclusive."
    : base.direction === "inconclusive" ? "VO₂ max is stable within ±1 mL/kg/min — a real measurement of no meaningful change, not missing data."
    : `VO₂ max ${base.direction} (${base.priorMedian?.toFixed(1)} → ${base.recentMedian?.toFixed(1)}).`;
  return { ...base, availability: "available", effect, note: `${text} Device estimate; used for corroboration only, never converted to a finish time.` };
}

function streamDisclosure(physiology: AerobicTrendEvidence | null, load: LoadState): HrStreamDisclosure {
  const s = physiology?.streams;
  const base = { streamRuns: s?.used ?? 0, eligibleRuns: s?.eligible ?? 0, excludedIntervalLike: s?.excludedIntervalLike ?? 0, calibrationOffsetBpm: s?.calibrationOffsetBpm ?? null };
  if (load === "failed") return { ...base, availability: "load_failed", note: "Heart-rate streams could not be loaded; whole-workout average heart rate was used instead." };
  if (load === "not_requested") return { ...base, availability: "not_requested", note: "Heart-rate streams were not requested; whole-workout average heart rate was used." };
  if (!s || s.used === 0) return { ...base, availability: "none_available", note: "Heart-rate streams: none of the comparison runs had a screened stream; whole-workout average heart rate was used." };
  return { ...base, availability: s.used >= s.eligible ? "used" : "partial",
    note: `${s.used} of ${s.eligible} comparison runs use warm-up-trimmed heart rate${s.excludedIntervalLike ? `; ${s.excludedIntervalLike} interval-like run${s.excludedIntervalLike === 1 ? "" : "s"} left out of the steady-state comparison` : ""}${s.calibrationOffsetBpm !== null ? `; the rest are shifted by the measured ${s.calibrationOffsetBpm.toFixed(1)} bpm trimming offset` : ""}.` };
}

const emptyContributions = (reason: string): HybridFamilyContribution[] =>
  (["demonstrated_performance", "physiological_trend", "race_history", "endurance_readiness"] as const)
    .map(family => ({ family, status: "unavailable" as const, seconds: 0, fraction: 0, influence: 0, explanation: reason }));

const emptyInfluence = (combination: EvidenceCombination, notes: string[], excluded: Record<string, number>): HistoricalInfluence => ({
  latestRaceDate: combination.latestRaceDate, latestRaceAgeDays: combination.latestRaceAgeDays, raceShare: 0, recentShare: 0, raceDominance: "none",
  independentObservations: combination.independentObservations, newerEvidenceDisplacedRace: false, displacementSeconds: null,
  physiologicalTrendApplied: false, physiologyAdjustmentSeconds: 0, enduranceAdjustmentSeconds: 0, provisional: true, provisionalReasons: notes, notes, excludedInformative: excluded });

const NO_DEMONSTRATED: DemonstratedRaceDisclosure = { basis: "maximal_or_recorded_evidence", eligibleRaces: 0, usedRaces: 0, policyDisabled: false, note: null };

/**
 * The demonstrated-race policy (the only change to v1.1's evidence handling; every numerical term below is unchanged):
 * a confirmed race that passed every integrity check but was attested `hard` or `nonmaximal` shows what was ACHIEVED, not maximal capability.
 *   - strict estimate S = the unchanged v1.1 (confirmed-maximal, recorded, strong-effort and segment evidence only);
 *   - A = the same estimator with those races admitted as `recorded_race`-class evidence (unverified-maximality class, 1.5 % σ);
 *   - result = S unless A is available and S is unavailable or slower than A is faster: i.e. S when S ≤ A, so such a race can only make
 *     the estimate faster, never slower; when A carries the number it is provisional, low confidence and labelled demonstrated performance.
 * No effort percentage, coefficient or discount exists. The 180-day currency limit and all race-integrity checks apply unchanged.
 */
export function estimateHybridHalfMarathonV11(input: Input, options: HybridV11Options = {}): HybridV11Estimate {
  const strict = estimateCore(input, options, false);
  const eligible = buildRaceEvidence({ ...input, overrides: input.overrides ?? {} }).filter(isDemonstratedRaceEvidence).length;
  const tag = (e: HybridV11Estimate, d: Partial<DemonstratedRaceDisclosure>): HybridV11Estimate => ({ ...e, demonstrated: { ...NO_DEMONSTRATED, eligibleRaces: eligible, ...d } });
  if (options.strictMaximalOnly) return tag(strict, { policyDisabled: true, note: eligible ? "The demonstrated-race policy is switched off; confirmed hard or nonmaximal races are ignored." : null });
  if (!eligible) return strict;
  const alt = estimateCore(input, options, true);
  const used = alt.qualification.independent.filter(i => i.reasons.includes(DEMONSTRATED_RACE_REASON)).length;
  if (alt.seconds === null || !used) {
    // Nothing numeric to add. If the only candidate has aged out, say so instead of "no evidence".
    if (strict.seconds === null && alt.unavailableCause === "anchor_expired_no_contemporary_evidence")
      return tag(alt, { note: "A confirmed hard or nonmaximal race exists but is older than the 180-day currency limit, so it carries no weight." });
    return tag(strict, {});
  }
  if (strict.seconds !== null && strict.seconds <= alt.seconds)
    return tag(strict, { note: "A confirmed hard or nonmaximal race exists but does not make the estimate faster, so the strict estimate is unchanged." });
  const only = strict.seconds === null;
  const message = only
    ? "This number is demonstrated performance: it comes from a confirmed race that was not run at maximal effort, so it shows what you have already run, not your maximal-performance limit."
    : "A confirmed race that was not run at maximal effort made this estimate faster than the maximal-effort evidence alone; it shows what you have already run, not your maximal-performance limit.";
  return tag({ ...alt, status: "provisional", confidence: "low",
    flags: [...new Set([...alt.flags, only ? "demonstrated_performance_only" : "demonstrated_performance_included"])],
    influence: { ...alt.influence, provisional: true, provisionalReasons: [...new Set([...alt.influence.provisionalReasons, message])] },
    caveats: [message, ...alt.caveats] },
  { basis: only ? "demonstrated_performance_only" : "demonstrated_performance_included", usedRaces: used, note: message });
}

function estimateCore(input: Input, options: HybridV11Options, admitDemonstrated: boolean): HybridV11Estimate {
  if (!isPerformanceInstant(input.asOf)) throw new TypeError("A valid hybrid-estimate cutoff is required");
  const P = HYBRID_V11_POLICY, B = HYBRID_POLICY, profile = options.profile ?? null;
  const target = profile?.distanceMeters ?? options.targetDistanceMeters ?? HALF_MARATHON_METERS;
  // Distance-dependent conversion parameters (undefined profile → the policy constants inside `combineEvidence`).
  const conv: CombinationParams = profile ? { extrapolationSigmaPerLn: profile.extrapolationSigmaPerLn, longerSourceSigmaPerLn: profile.longerSourceSigmaPerLn,
    longerSourceExponent: profile.longerSourceExponent } : {};
  const physScale = profile?.physiologyScale ?? 1, endScale = profile?.enduranceScale ?? 1;
  const overrides = input.overrides ?? {};
  const qualification = qualifyEvidenceV11(input, { admitDemonstratedRaces: admitDemonstrated });
  const asOfDate = qualification.asOfDate;
  const { runs } = selectResearchRuns({ ...input, overrides, capturedAt: input.asOf, source: "owner_parent_export",
    complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
  const raceWorkoutIds = new Set(input.races.flatMap(r => r.actualRunId ? [r.actualRunId] : []));
  const vo2Load: LoadState = options.vo2Load ?? (options.vo2Entries ? "loaded" : "not_requested");
  const streamLoad: LoadState = options.streamLoad ?? (options.streamSummaries ? "loaded" : "not_requested");

  const measured = computeEnduranceReadiness({ runs, raceWorkoutIds, asOfDate, targetDistanceMeters: target });
  const readiness: EnduranceReadiness = options.readinessOverride === undefined ? measured
    : { ...measured, score: clamp(options.readinessOverride, 0, 1), reasons: [...measured.reasons, "scenario_readiness_override"] };
  const maxExponent = profile?.maximumExponent ?? B.maximumExponent;
  const exponent = readiness.score === null ? B.baseExponent : B.baseExponent + (maxExponent - B.baseExponent) * (1 - readiness.score);
  const expired = qualification.base.expired.length;
  const combination = combineEvidence(qualification.independent, { targetDistanceMeters: target, exponent, expiredItems: expired, params: profile ? { ...conv, ...options.combinationParams } : options.combinationParams });
  const physiology = computeAerobicTrend({ runs, raceWorkoutIds, asOf: input.asOf, asOfDate, streamSummaries: options.streamSummaries as Readonly<Record<string, HrStreamSummary>> | undefined,
    vo2Entries: options.vo2Entries, streamPolicy: "calibrated" });
  const vo2 = vo2Disclosure(physiology, options.vo2Entries, vo2Load), hrStreams = streamDisclosure(physiology, streamLoad);

  const official = options.official as CurrentHalfEstimate | null | undefined ?? null, hr = options.hrEnhanced as HrEnhancedEstimate | null | undefined ?? null;
  const officialSeconds = official && official.baselineSeconds !== null && official.finishMinutes !== null ? official.baselineSeconds + official.adjustmentSeconds : null;
  const hrSeconds = hr?.candidateSeconds ?? null, v1Seconds = options.hybridV1?.seconds ?? null;
  const missing: string[] = [];
  const flags: string[] = [...combination.flags];
  const caveats = ["The official estimate remains the primary prediction; this is a labelled experiment beside it.",
    "Not independently validated: there are not yet enough qualified race outcomes to test whether it is more accurate."];
  const comparisonOf = (seconds: number | null) => ({ officialSeconds, hrEnhancedSeconds: hrSeconds, hybridV1Seconds: v1Seconds,
    differenceVsOfficialSeconds: seconds === null || officialSeconds === null ? null : seconds - officialSeconds,
    differenceVsHrEnhancedSeconds: seconds === null || hrSeconds === null ? null : seconds - hrSeconds,
    differenceVsHybridV1Seconds: seconds === null || v1Seconds === null ? null : seconds - v1Seconds });

  const shell = (status: HybridV11Estimate["status"], cause: HybridUnavailableCause | null, reason: string, extra: Partial<HybridV11Estimate> = {}): HybridV11Estimate => ({
    version: HYBRID_V11_VERSION, researchStatus: "experimental_provisional", validated: false, asOf: input.asOf, asOfDate,
    dataThrough: qualification.independent.map(i => i.date).sort().at(-1) ?? null, targetDistanceMeters: target, status, unavailableCause: cause,
    seconds: null, minutes: null, paceSecondsPerMile: null, evidenceQuality: combination.quality, confidence: null, sensitivityRange: null,
    contributions: emptyContributions(reason), combination, qualification, physiology, readiness, adjustmentFraction: 0,
    influence: emptyInfluence(combination, [reason], qualification.informativeExcluded), conflicts: [], inputs: { vo2, hrStreams }, comparison: comparisonOf(null),
    flags: [...new Set(flags)], missing, reasons: [reason], fallbackReason: reason, assumptions: profile ? [...ASSUMPTIONS, ...targetAssumptions(profile)] : ASSUMPTIONS, caveats, demonstrated: NO_DEMONSTRATED,
    ...(profile ? { target: targetDisclosure(profile, null, null, [], null) } : {}), ...extra });

  if (combination.status === "unavailable" || combination.baseSeconds === null) {
    const raw = combination.unavailableCause;
    const cause: HybridUnavailableCause = raw === null ? "no_performance_evidence" : raw;
    if (physiology.status === "available") missing.push("Maximal-performance evidence (a physiological trend alone is never converted into a finish time)");
    return shell("unavailable", cause, combination.reasons[0] ?? "No qualifying performance evidence.");
  }
  const rows = combination.items, base = combination.baseSeconds;
  const atTarget = (r: { extrapolationRatio: number }) => r.extrapolationRatio <= B.atTargetRatio && r.extrapolationRatio >= 0.8;
  const atTargetShare = rows.filter(atTarget).reduce((s, r) => s + r.effectiveShare, 0);
  // Support share: the at-target band (half marathon / marathon, unchanged); for 5K and 10 miles also any LONGER performance (it already demonstrates the endurance).
  const supportShare = profile?.longerSourceDemonstratesEndurance ? rows.filter(r => r.extrapolationRatio <= B.atTargetRatio).reduce((s, r) => s + r.effectiveShare, 0) : atTargetShare;
  const support = readiness.score === null ? null : Math.max(readiness.score, supportShare);
  const minimumSupport = profile ? profile.minimumReadiness : target >= HALF_MARATHON_METERS - 25 ? B.minimumReadiness : null;
  const noun = profile?.noun ?? "half-marathon";
  if (support !== null && minimumSupport !== null && support < minimumSupport) {
    flags.push("endurance_unprepared");
    return shell("unavailable", "insufficient_endurance_preparation",
      `Recent long-run, volume and frequency evidence (readiness ${(readiness.score! * 100).toFixed(0)}%) is too low, and no recent race-distance performance demonstrates the endurance, to carry a ${noun} time. Demonstrated speed is shown separately; endurance readiness is a different question.`);
  }
  // Marathon durability: half-marathon ability is never read as proof of marathon readiness (waived only when marathon-distance performance carries the base).
  const dur = profile?.durability ?? null;
  const longRunMean = readiness.longRunFraction === null ? null : readiness.longRunFraction * (target / 1609.344);
  const demonstratedAtTarget = dur ? atTargetShare >= dur.demonstratedShare : false;
  if (dur && !demonstratedAtTarget) {
    if (readiness.score === null || (readiness.longestRunMiles ?? 0) < dur.withholdBelowLongestRunMiles) {
      flags.push("durability_unsupported");
      return shell("unavailable", "insufficient_endurance_preparation", readiness.score === null
        ? "Fewer than four recent weeks have recorded runs, so long-run and volume history is unknown. A marathon time is not estimated from half-marathon speed without evidence of endurance preparation."
        : `The longest recent run is ${(readiness.longestRunMiles ?? 0).toFixed(1)} miles (under ${dur.withholdBelowLongestRunMiles}): there is not enough long-run evidence to carry a marathon time. Half-marathon ability is shown separately and is not proof of marathon durability.`,
        { target: targetDisclosure(profile!, null, { longestRunMiles: readiness.longestRunMiles, longRunMeanMiles: longRunMean, weeklyMiles: readiness.weeklyMiles, demonstratedAtTarget, satisfied: false }, [], null) });
    }
  }
  if (readiness.score === null) { flags.push("readiness_unknown"); missing.push("Endurance readiness (fewer than four recent weeks with recorded runs)"); }

  // Effective date of the evidence (share-weighted): the physiological and endurance terms measure change SINCE it.
  const refDay = rows.reduce((s, r) => s + dayNumber(r.date) * r.effectiveShare, 0);
  const refDate = new Date(refDay * 86_400_000).toISOString().slice(0, 10);
  const daysSinceRef = Math.max(0, dayNumber(asOfDate) - refDay);

  const fPhysAt = (kappa: number) => {
    if (physiology.status !== "available" || physiology.slopePer28d === null || physiology.standardError === null
      || physiology.classification === "no_detectable_change" || physiology.classification === "unavailable") return { f: 0, influence: 0, observed: 0 };
    const T = Math.min(daysSinceRef, AEROBIC_TREND_POLICY.windowDays) / 28;
    const observed = kappa * physiology.slopePer28d * T;
    const hrDisagrees = hr?.signal?.status === "available" && ((hr.signalDirection === "improved" && observed > 0) || (hr.signalDirection === "declined" && observed < 0));
    const inflate = hrDisagrees || physiology.vo2Corroboration === "disagrees" ? B.disagreementInflation : 1;
    const sigma2 = ((kappa * physiology.standardError * T) ** 2 + (B.transferUncertainty * observed) ** 2) * inflate ** 2;
    const tau2 = (B.priorSpreadPerSqrtMonth * Math.sqrt(Math.max(daysSinceRef, 1) / 30)) ** 2;
    const s = sigma2 + tau2 > 0 ? tau2 / (tau2 + sigma2) : 0;
    return { f: clamp(s * observed, -B.maximumPhysiologicalFraction, B.maximumPhysiologicalFraction), influence: s, observed };
  };
  const physiologyStatus = physiology.status === "available" && physiology.classification !== "no_detectable_change" ? "used" : physiology.status === "available" ? "no_effect" : "unavailable";
  if (physiology.status !== "available") missing.push("Multiweek aerobic-efficiency trend (" + (physiology.reasons[0] ?? "insufficient runs") + ")");
  if (physiology.flags.includes("weather_unadjusted")) missing.push("Weather for enough comparison runs (heat could explain part of any pace change; not assumed equal)");
  if (vo2.availability !== "available") missing.push(`Apple Health VO₂ max corroboration (${vo2.availability.replace("_", " ")}; optional)`);
  if (hrStreams.availability !== "used" && physiology.status === "available") missing.push(hrStreams.availability === "partial" ? "Warm-up-trimmed heart rate for every comparison run (partial hydration)" : "Warm-up-trimmed heart-rate streams (whole-workout average HR includes the warm-up)");
  const phys = fPhysAt(B.transferFraction * physScale);

  let fE = 0, enduranceStatus: HybridFamilyContribution["status"] = "unavailable", readinessThen: EnduranceReadiness | null = null;
  if (readiness.score !== null) {
    readinessThen = computeEnduranceReadiness({ runs, raceWorkoutIds, asOfDate: refDate, targetDistanceMeters: target });
    if (readinessThen.score !== null && atTargetShare > 0) {
      const delta = clamp(readiness.score - readinessThen.score, -B.enduranceDeltaClamp, B.enduranceDeltaClamp);
      fE = clamp(-B.enduranceCoefficient * delta * atTargetShare * B.enduranceInfluence * endScale, -B.maximumEnduranceFraction * endScale, B.maximumEnduranceFraction * endScale);
      enduranceStatus = fE === 0 ? "no_effect" : "used";
    } else enduranceStatus = "no_effect";
  }
  const combine = (a: number, b: number) => {
    const same = Math.sign(a) * Math.sign(b) > 0;
    const total = !a || !b ? a + b : same ? (Math.abs(a) >= Math.abs(b) ? a + B.correlatedOverlap * b : b + B.correlatedOverlap * a) : a + b;
    return clamp(total, -B.maximumTotalFraction, B.maximumTotalFraction);
  };
  const contradictoryAdj = Math.sign(phys.f) * Math.sign(fE) < 0 && Math.abs(phys.f) >= B.contradictoryMinimumFraction && Math.abs(fE) >= B.contradictoryMinimumFraction;
  if (contradictoryAdj) flags.push("contradictory_signals");
  if (physiology.vo2Corroboration === "disagrees") flags.push("vo2_disagrees");
  const total = combine(phys.f, fE);
  const seconds = base * (1 + total);

  // ── Conflicts between independent signals are REPORTED, never silently summed. ──
  const conflicts: ConflictSignal[] = [];
  const disp = combination.raceOnlySeconds === null ? 0 : Math.log(base / combination.raceOnlySeconds);
  if (Math.abs(disp) >= P.conflictDisplacementFraction && physiology.status === "available" && Math.abs(phys.f) >= P.conflictPhysiologyFraction && Math.sign(disp) * Math.sign(phys.f) < 0)
    conflicts.push({ id: "recent_performance_vs_aerobic_trend", detail: `Recent performances imply ${disp < 0 ? "faster" : "slower"} running than the race, but pace at a given heart rate has ${phys.f < 0 ? "improved" : "declined"}.` });
  if (disp <= -P.conflictDisplacementFraction && readiness.score !== null && readinessThen?.score != null && readiness.score - readinessThen.score <= -P.conflictReadinessDrop)
    conflicts.push({ id: "recent_speed_vs_endurance_preparation", detail: `Recent efforts are faster than the race, but endurance preparation has fallen (${(readinessThen.score * 100).toFixed(0)}% → ${(readiness.score * 100).toFixed(0)}%).` });
  if (conflicts.length) flags.push("conflicting_signals");

  // ── Assumption-sensitivity range: alternative defensible parameters (not a statistical interval). ──
  const variants: number[] = [seconds];
  const S = P.sensitivity;
  for (const exp of profile ? profile.sensitivityExponents : S.exponents) {
    const alt = combineEvidence(qualification.independent, { targetDistanceMeters: target, exponent: exp, expiredItems: expired, ...(profile ? { params: conv } : {}) }).baseSeconds;
    if (alt !== null) { variants.push(alt); for (const k of S.transfers) variants.push(alt * (1 + combine(fPhysAt(k * physScale).f, fE))); }
  }
  // Longer-source conversions (e.g. a half marathon → 5 K) have their own, disclosed exponent uncertainty.
  for (const lexp of profile?.sensitivityLongerExponents ?? []) {
    const alt = combineEvidence(qualification.independent, { targetDistanceMeters: target, exponent, expiredItems: expired, params: { ...conv, longerSourceExponent: lexp } }).baseSeconds;
    if (alt !== null) variants.push(alt * (1 + total));
  }
  const alts: { [k: string]: Parameters<typeof combineEvidence>[1] } = {
    commonModeLow: { params: { commonModeRace: COMBINATION_POLICY.commonMode.race * S.commonModeScale[0], commonModeRecent: COMBINATION_POLICY.commonMode.recent_effort * S.commonModeScale[0] } },
    commonModeHigh: { params: { commonModeRace: COMBINATION_POLICY.commonMode.race * S.commonModeScale[1], commonModeRecent: COMBINATION_POLICY.commonMode.recent_effort * S.commonModeScale[1] } },
    driftLow: { params: { driftPerSqrtMonth: S.drift[0] } }, driftHigh: { params: { driftPerSqrtMonth: S.drift[1] } },
    measureLow: { params: { measurementScale: S.measurementScale[0] } }, measureHigh: { params: { measurementScale: S.measurementScale[1] } },
    noSegments: { params: { excludeKinds: ["sustained_segment"] } },
  };
  for (const o of Object.values(alts)) {
    const alt = combineEvidence(qualification.independent, { targetDistanceMeters: target, exponent, expiredItems: expired, ...(profile ? { params: { ...conv, ...(o?.params ?? {}) } } : o) }).baseSeconds;
    if (alt !== null) variants.push(alt * (1 + total));
  }
  const sensitivityRange = { fastSeconds: Math.min(...variants), slowSeconds: Math.max(...variants),
    basis: profile && profile.id !== "half"
      ? `Alternative defensible assumptions (distance exponent ${profile.sensitivityExponents[0]} vs ${profile.sensitivityExponents[1]}${profile.sensitivityLongerExponents ? `, ${profile.sensitivityLongerExponents[0]}–${profile.sensitivityLongerExponents[1]} for longer-distance evidence` : ""}, 25–75 % physiological transfer, common-mode and age-drift terms halved/doubled, measurement uncertainty ±25 %, with and without sustained segments). Not a statistical interval.`
      : "Alternative defensible assumptions (distance exponent 1.06 vs 1.10, 25–75 % physiological transfer, common-mode and age-drift terms halved/doubled, measurement uncertainty ±25 %, with and without sustained segments). Not a statistical interval." };

  // ── Status, confidence, provisional reasons. ──
  const provisionalReasons: string[] = [];
  if (combination.quality !== "adequate") provisionalReasons.push("Evidence quality is limited (too little corroborated, recent, low-uncertainty evidence).");
  if (flags.includes("contradictory_evidence")) provisionalReasons.push("Evidence within a group disagrees.");
  if (conflicts.length) provisionalReasons.push("Independent signals conflict.");
  if (contradictoryAdj) provisionalReasons.push("The physiological and endurance terms point in opposite directions.");
  if (readiness.score === null) provisionalReasons.push("Endurance readiness is unknown.");
  if (combination.raceDominance === "dominant" && (combination.latestRaceAgeDays ?? 0) > 42) provisionalReasons.push("The estimate rests almost entirely on an aging race with no newer corroborating evidence.");
  // Distance-specific evidence rules (profile only; the half marathon is unchanged).
  const directShare = profile?.directRatio ? rows.filter(r => r.extrapolationRatio <= profile.directRatio! && r.extrapolationRatio >= 1 / profile.directRatio!).reduce((s, r) => s + r.effectiveShare, 0) : null;
  const targetNotes: string[] = [];
  if (profile?.directRatio && directShare !== null && directShare < 0.5) {
    const msg = profile.id === "5k"
      ? "This 5K is mostly converted from longer-distance evidence (half marathon or beyond), which says little about short-race speed. Treat it as a rough estimate until a 5K or 10K effort is available."
      : `This ${noun} estimate is mostly converted from evidence at a distant race distance.`;
    provisionalReasons.push(msg); targetNotes.push(msg);
  }
  if (dur && !demonstratedAtTarget) {
    if (longRunMean !== null && longRunMean < dur.provisionalBelowLongRunMiles) provisionalReasons.push(`Recent long runs average ${longRunMean.toFixed(1)} miles (the three longest weeks), under ${dur.provisionalBelowLongRunMiles}: marathon durability is not demonstrated.`);
    if ((readiness.weeklyMiles ?? 0) < dur.provisionalBelowWeeklyMiles) provisionalReasons.push(`Typical weekly mileage (${(readiness.weeklyMiles ?? 0).toFixed(0)} mi) is under ${dur.provisionalBelowWeeklyMiles}: marathon durability is not demonstrated.`);
    for (const r of provisionalReasons.filter(x => /durability/.test(x))) targetNotes.push(r);
  }
  const durabilityOk = dur ? demonstratedAtTarget || !provisionalReasons.some(x => /durability/.test(x)) : true;
  const provisional = provisionalReasons.length > 0;
  const confidence: HybridV11Estimate["confidence"] = !provisional && (readiness.score ?? 0) >= B.moderateReadiness && physiology.vo2Corroboration !== "disagrees" ? "moderate" : "low";
  const status: HybridV11Estimate["status"] = provisional ? "provisional" : "available";
  const miles = target / 1609.344;
  // Presentation rounding (HALF profile: nearest minute, identical to the pre-existing behaviour).
  const increment = profile?.roundingSeconds ?? 60;
  const shownSeconds = Math.round(seconds / increment) * increment;
  const minutes = increment === 60 ? Math.round(seconds / 60) : shownSeconds / 60;

  const notes: string[] = [];
  const ign = combination.ignored.filter(i => i.reason === "segment_slower_than_estimate").length;
  if (ign) notes.push(`${ign} sustained segment${ign === 1 ? "" : "s"} slower than the estimate ignored: a slow segment is not evidence of lost capability.`);
  if (combination.items.some(i => i.flags.includes("isolated_uncorroborated"))) notes.push("An isolated effort far from the rest of the evidence was down-weighted until corroborated by another independent effort.");
  if (combination.items.some(i => i.flags.includes("slower_than_estimate_lower_bound"))) notes.push("A slower unconfirmed effort was down-weighted: a submaximal effort looks slow and is weaker evidence than a faster one.");
  if (!combination.recent) notes.push("No newer qualifying effort exists, so the race is the best available benchmark; the estimate is unchanged by its age but its uncertainty grows.");
  if ((combination.latestRaceAgeDays ?? 0) > 120) notes.push("The latest race is older than 120 days; treat the estimate as aging evidence.");
  for (const [reason, n] of Object.entries(qualification.informativeExcluded)) notes.push(`${n} potentially informative workout${n === 1 ? "" : "s"} not used: ${reason.replaceAll("_", " ")}.`);
  const influence: HistoricalInfluence = {
    latestRaceDate: combination.latestRaceDate, latestRaceAgeDays: combination.latestRaceAgeDays, raceShare: combination.raceShare, recentShare: combination.recentShare,
    raceDominance: combination.raceDominance, independentObservations: combination.independentObservations, newerEvidenceDisplacedRace: combination.newerEvidenceMajority,
    displacementSeconds: combination.displacementSeconds, physiologicalTrendApplied: physiologyStatus === "used" && phys.f !== 0,
    physiologyAdjustmentSeconds: base * phys.f, enduranceAdjustmentSeconds: base * fE, provisional, provisionalReasons, notes, excludedInformative: qualification.informativeExcluded };

  const raceCount = combination.race?.count ?? 0, effCount = combination.recent?.count ?? 0;
  const contributions: HybridFamilyContribution[] = [
    { family: "demonstrated_performance", status: "used", seconds: 0, fraction: 0, influence: 1,
      explanation: `Base ${mmss(base)} from ${rows.length} independent performance${rows.length === 1 ? "" : "s"} (${raceCount} race${raceCount === 1 ? "" : "s"}, ${effCount} newer effort${effCount === 1 ? "" : "s"}; exponent ${exponent.toFixed(3)}); evidence quality ${combination.quality}.` },
    { family: "physiological_trend", status: physiologyStatus, seconds: base * phys.f, fraction: phys.f, influence: phys.influence,
      explanation: physiology.status !== "available" ? `Unavailable: ${physiology.reasons[0] ?? "insufficient evidence"}`
        : physiology.classification === "no_detectable_change" ? `No sustained change in pace at a given heart rate across ${physiology.runs} runs / ${physiology.weeks} weeks.`
        : `Pace at a given heart rate ${physiology.classification === "observed_improvement" ? "improved" : "declined"} ${(Math.abs(physiology.slopePer28d!) * 100).toFixed(1)}% per 28 days; ${daysSinceRef.toFixed(0)} days since the evidence's effective date; shrunk by precision to ${(phys.influence * 100).toFixed(0)}% influence.` },
    { family: "race_history", status: combination.raceShare > 0 ? "used" : "no_effect", seconds: 0, fraction: 0, influence: combination.raceShare,
      explanation: combination.raceShare > 0 ? `Races carry ${(combination.raceShare * 100).toFixed(0)}% of the base (effective weight, counted once inside the demonstrated family); latest race ${combination.latestRaceAgeDays} days old.`
        : `No race currently contributes${expired ? `; ${expired} older than 180 days carry no weight` : ""}.` },
    { family: "endurance_readiness", status: enduranceStatus, seconds: base * fE, fraction: fE, influence: enduranceStatus === "used" ? B.enduranceInfluence : 0,
      explanation: readiness.score === null ? "Readiness unknown (too few recent weeks recorded); no adjustment, confidence reduced."
        : `Readiness ${(readiness.score * 100).toFixed(0)}% (longest ${readiness.longestRunMiles?.toFixed(1)} mi, ${readiness.weeklyMiles?.toFixed(0)} mi/wk). Sets the extrapolation exponent${enduranceStatus === "used" ? `; change since the evidence (${readinessThen?.score == null ? "?" : (readinessThen.score * 100).toFixed(0) + "%"} → ${(readiness.score * 100).toFixed(0)}%) adjusts the base` : ""}.` },
  ];
  return shell(status, null, "", { seconds, minutes, paceSecondsPerMile: Math.round(minutes * 60 / miles / 5) * 5, confidence, sensitivityRange, contributions,
    adjustmentFraction: total, influence, conflicts, flags: [...new Set(flags)], fallbackReason: null, reasons: combination.reasons, comparison: comparisonOf(seconds),
    ...(profile ? { target: targetDisclosure(profile, directShare, dur ? { longestRunMiles: readiness.longestRunMiles, longRunMeanMiles: longRunMean, weeklyMiles: readiness.weeklyMiles,
      demonstratedAtTarget, satisfied: durabilityOk } : null, targetNotes, increment) } : {}) });
}

function targetAssumptions(p: TargetProfile): string[] {
  const out = [`Distance-aware target (${p.label}): conversion uncertainty ${p.extrapolationSigmaPerLn} per ln-distance for shorter sources and ${p.longerSourceSigmaPerLn} for longer sources; physiological-trend weight ×${p.physiologyScale}, endurance-change weight ×${p.enduranceScale}. These are engineering assumptions, not fitted to any outcome.`];
  if (p.id === "5k") out.push("A half-marathon-or-longer result converts to a 5K with Riegel's exponent 1.06 and a wide uncertainty; speed-specific evidence (a 5K–10K race or sustained effort) is what makes a 5K estimate more than a rough one.");
  if (p.id === "marathon") out.push("A marathon time is never read from half-marathon speed alone: recent long runs, weekly volume and endurance readiness must support it, and the shorter-source conversion exponent rises to 1.15 as readiness falls.");
  return out;
}
function targetDisclosure(p: TargetProfile, directShare: number | null, durability: TargetDisclosure["durability"], notes: string[], rounding: number | null): TargetDisclosure {
  return { id: p.id, label: p.label, directShare, durability, roundingSeconds: rounding ?? p.roundingSeconds, notes };
}
