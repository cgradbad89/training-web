/**
 * Phase 3Q.3/3Q.4 — independent performance-capacity engine (performance-capacity-v1).
 *
 * Estimates what the athlete has DEMONSTRATED they can race today, without the v2 training-adjustment
 * heuristic (volume/frequency/endurance percentages) and without requiring an unexpired race anchor.
 *
 *  A  Race / sustained-performance equivalence: the single most reliable recent qualifying performance
 *     converted to the target distance (Riegel, with a Daniels–Gilbert VDOT cross-check).
 *  B  Critical speed (two-parameter distance–time model, D = CS·t + D′): fitted only from ≥3 independent
 *     strong efforts of ~2–20 min spanning a ≥2.5× duration range; poorly conditioned or implausible fits are
 *     rejected. A fit NEVER yields a half-marathon time here: CS is a severe-domain parameter and extrapolating
 *     it to a ~2-hour event needs endurance evidence this engine does not have.
 *  C  Recent demonstrated capacity (PRIMARY): a recency/quality/extrapolation-weighted log-mean of the
 *     target-equivalent times of ALL independent qualifying items. A confirmed time trial last week outweighs an
 *     old race; an expired race carries no weight; a strong contemporary pair of efforts suffices without any race.
 *
 * Sources: Riegel (1981) fixed exponent 1.06 (population-style, not fitted); Daniels–Gilbert VDOT equivalence;
 * critical-speed concept as reviewed by Anderson et al. (Sports Med 2026): ≥3 maximal trials of ~3–15 min in the
 * severe domain, two-parameter models recommended, events ≥10 km should not be fit trials. Weights, half-life,
 * extrapolation reliability and thresholds are ENGINEERING ASSUMPTIONS, not fitted to this athlete or published.
 */
import type {
  CapacityContribution, CapacityMethodResult, EvidenceQualification, PerformanceCapacityResult,
  PerformanceEvidenceItem, CapacityUnavailableCause,
} from "@/types/hybridPerformance";
import type { RacePerformanceInput } from "@/types/racePerformance";
import { HALF_MARATHON_METERS, researchRiegelSeconds, researchVdotSeconds } from "@/utils/racePerformance";
import { shiftPerformanceDate } from "@/utils/performanceEvidence";
import { EVIDENCE_POLICY, qualifyPerformanceEvidence } from "./evidenceQualification";

export const CAPACITY_VERSION = "performance-capacity-v1" as const;
export const CAPACITY_POLICY = Object.freeze({
  version: CAPACITY_VERSION,
  defaultExponent: 1.06,
  halfLifeDays: 42,
  /** Target/source distance ratio up to which a source is fully reliable, and where reliability reaches zero. */
  fullReliabilityRatio: 1.25, zeroReliabilityRatio: 6, minimumReliability: 0.15, longerSourceReliability: 0.8,
  minimumSourceDurationSeconds: 8 * 60,
  supportedTargetsMeters: [5000, 10000, HALF_MARATHON_METERS] as readonly number[],
  targetToleranceMeters: 25,
  contemporaryWindowDays: 120, minimumContemporaryItems: 2, minimumContemporaryWeeks: 2, minimumReliableExtrapolation: 0.5,
  adequateTotalWeight: 0.5, adequateConfirmedWeight: 0.4,
  contradictoryDispersion: 0.04, contradictorySpread: 0.06,
  /** An unconfirmed whole-run effort this much faster than everything else, with no similar peer, is more likely unrepresentative than a capability jump. */
  isolatedFastMargin: 0.04, isolatedPeerTolerance: 0.03, isolatedWeightFactor: 0.35,
  plausibleSpeedMetersPerSecond: { min: 1.0, max: 7.5 },
  cs: { minDurationSeconds: 120, maxDurationSeconds: 1200, minEfforts: 3, minDurationRatio: 2.5, minR2: 0.98, maxSlopeSeFraction: 0.05,
    minDPrimeMeters: 20, maxDPrimeMeters: 1000, minSpeed: 1.5, maxSpeed: 7.5, maxAgeDays: 90 },
});

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const isoWeek = (date: string) => shiftPerformanceDate(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

/** Reliability of converting a performance at `source` metres to a `target`-metre time (1 = full). */
export function extrapolationReliability(sourceMeters: number, targetMeters: number): number {
  const P = CAPACITY_POLICY, q = targetMeters / sourceMeters;
  if (q < 0.8) return P.longerSourceReliability;
  if (q <= P.fullReliabilityRatio) return 1;
  return clamp(1 - (q - P.fullReliabilityRatio) / (P.zeroReliabilityRatio - P.fullReliabilityRatio), 0, 1);
}

export function recencyWeight(ageDays: number): number { return Math.pow(0.5, Math.max(0, ageDays) / CAPACITY_POLICY.halfLifeDays); }

/** Exponent applied to sources shorter than the target. Longer sources already demonstrate the endurance. */
export function exponentFor(source: number, target: number, exponent: number, longerSourceExponent: number = CAPACITY_POLICY.defaultExponent): number {
  return target / source > 1.05 ? exponent : longerSourceExponent;
}

/** `longerSourceExponent` (default: the policy's fixed 1.06) is only ever supplied by the distance-aware target profiles (5K / 10 mi). */
export function equivalentOf(item: Pick<PerformanceEvidenceItem, "seconds" | "distanceMeters">, target: number, exponent: number, longerSourceExponent?: number) {
  const seconds = researchRiegelSeconds(item.seconds, item.distanceMeters, target, exponentFor(item.distanceMeters, target, exponent, longerSourceExponent));
  if (seconds === null) return null;
  const speed = target / seconds, range = CAPACITY_POLICY.plausibleSpeedMetersPerSecond;
  if (speed < range.min || speed > range.max) return null;
  const vdot = target >= 1500 && target <= 42195 && item.distanceMeters >= 1500 && item.distanceMeters <= 42195 ? researchVdotSeconds(item.seconds, item.distanceMeters, target) : null;
  return { seconds, vdot };
}

function contributionsFor(items: readonly PerformanceEvidenceItem[], target: number, exponent: number): CapacityContribution[] {
  const rows: CapacityContribution[] = [];
  for (const item of items) {
    if (item.seconds < CAPACITY_POLICY.minimumSourceDurationSeconds) continue;
    const reliability = extrapolationReliability(item.distanceMeters, target);
    if (reliability < CAPACITY_POLICY.minimumReliability) continue;
    const eq = equivalentOf(item, target, exponent);
    if (!eq) continue;
    const weight = item.quality * recencyWeight(item.ageDays) * reliability;
    if (weight <= 0) continue;
    rows.push({ clusterId: item.clusterId, kind: item.kind, tier: item.tier, date: item.date, ageDays: item.ageDays,
      sourceDistanceMeters: item.distanceMeters, sourceSeconds: item.seconds, equivalentSeconds: eq.seconds, vdotEquivalentSeconds: eq.vdot,
      extrapolationRatio: target / item.distanceMeters, weight, weightShare: 0 });
  }
  for (const r of rows) {
    if (r.kind !== "whole_run_effort") continue;
    const others = rows.filter(o => o !== r);
    if (!others.length) continue;
    const ow = others.reduce((s, o) => s + o.weight, 0);
    const meanOthers = others.reduce((s, o) => s + o.weight * Math.log(o.equivalentSeconds), 0) / ow;
    const hasPeer = others.some(o => o.kind === "whole_run_effort" && Math.abs(Math.log(o.equivalentSeconds) - Math.log(r.equivalentSeconds)) <= CAPACITY_POLICY.isolatedPeerTolerance);
    if (meanOthers - Math.log(r.equivalentSeconds) > CAPACITY_POLICY.isolatedFastMargin && !hasPeer) { r.weight *= CAPACITY_POLICY.isolatedWeightFactor; r.isolatedFast = true; }
  }
  const total = rows.reduce((s, r) => s + r.weight, 0);
  for (const r of rows) r.weightShare = total > 0 ? r.weight / total : 0;
  return rows.sort((a, b) => b.weight - a.weight || a.clusterId.localeCompare(b.clusterId));
}

const ASSUMPTIONS = [
  "Unvalidated engineering model. Weights, half-life (42 days), extrapolation reliability and thresholds are assumptions, not fitted to this athlete.",
  "Riegel equivalence uses a fixed exponent (1.06 by default); it is a population-style relationship, not an individual calibration.",
  "A recorded race or a strong workout effort is not proof of maximal effort; non-maximal efforts make the estimate conservative (slower than true capacity).",
  "Ordinary training runs, including their fastest GPS segments, never supply a numerical estimate; at most they bound capability from below.",
  "Efforts from one workout count once; at most one effort per local day is used. Evidence older than 180 days carries no weight.",
];

/** Method A — most reliable single qualifying performance, converted to the target distance. */
function methodA(items: readonly PerformanceEvidenceItem[], target: number, exponent: number): CapacityMethodResult {
  const rows = contributionsFor(items, target, exponent);
  const base: CapacityMethodResult = { id: "A_race_equivalence", version: `${CAPACITY_VERSION}/A`, status: "unavailable", targetDistanceMeters: target,
    seconds: null, evidenceCount: 0, contributions: [], reasons: [], assumptions: ASSUMPTIONS.slice(0, 2) };
  if (!rows.length) return { ...base, reasons: ["No qualifying performance with a supportable conversion to the target distance."] };
  const best = rows[0];
  const vdotGap = best.vdotEquivalentSeconds === null ? null : Math.abs(best.vdotEquivalentSeconds / best.equivalentSeconds - 1);
  return { ...base, status: "available", seconds: best.equivalentSeconds, evidenceCount: 1,
    contributions: [{ ...best, weightShare: 1 }],
    reasons: [vdotGap === null ? "VDOT cross-check unavailable for this source." : `VDOT-style cross-check differs by ${(vdotGap * 100).toFixed(1)}%.`] };
}

export interface CriticalSpeedFit { speed: number; dPrime: number; r2: number; slopeSeFraction: number; n: number }
/** Two-parameter distance–time fit, D = CS·t + D′ (ordinary least squares). */
export function fitCriticalSpeed(points: readonly { seconds: number; meters: number }[]): CriticalSpeedFit | null {
  const n = points.length;
  if (n < 3) return null;
  const mt = points.reduce((s, p) => s + p.seconds, 0) / n, md = points.reduce((s, p) => s + p.meters, 0) / n;
  const sxx = points.reduce((s, p) => s + (p.seconds - mt) ** 2, 0), sxy = points.reduce((s, p) => s + (p.seconds - mt) * (p.meters - md), 0);
  if (sxx <= 0) return null;
  const speed = sxy / sxx, dPrime = md - speed * mt;
  const sse = points.reduce((s, p) => s + (p.meters - (dPrime + speed * p.seconds)) ** 2, 0);
  const sst = points.reduce((s, p) => s + (p.meters - md) ** 2, 0);
  const r2 = sst > 0 ? 1 - sse / sst : 0;
  const se = Math.sqrt(sse / (n - 2) / sxx);
  return { speed, dPrime, r2, slopeSeFraction: speed > 0 ? se / speed : Infinity, n };
}

/** Method B — critical speed. Returns a FIT only, never a half-marathon time (see header). */
function methodB(items: readonly PerformanceEvidenceItem[], target: number): CapacityMethodResult {
  const P = CAPACITY_POLICY.cs;
  const base: CapacityMethodResult = { id: "B_critical_speed", version: `${CAPACITY_VERSION}/B`, status: "unavailable", targetDistanceMeters: target,
    seconds: null, evidenceCount: 0, contributions: [], reasons: [], assumptions: [
      "Two-parameter critical-speed model fitted only from strong efforts of 2–20 minutes; durations outside the severe domain are excluded.",
      "A fit describes severe-domain capacity. It is not extrapolated to the target distance without endurance evidence." ] };
  const usable = items.filter(i => i.tier !== "ordinary_training" && i.tier !== "unsuitable" && i.seconds >= P.minDurationSeconds
    && i.seconds <= P.maxDurationSeconds && i.ageDays <= P.maxAgeDays);
  if (usable.length < P.minEfforts) return { ...base, reasons: [`Fewer than ${P.minEfforts} independent strong efforts of 2–20 minutes (found ${usable.length}); a critical-speed fit would be underdetermined.`] };
  const times = usable.map(i => i.seconds), ratio = Math.max(...times) / Math.min(...times);
  if (ratio < P.minDurationRatio) return { ...base, evidenceCount: usable.length, reasons: [`Effort durations span only ${ratio.toFixed(2)}× (needs ≥ ${P.minDurationRatio}×); the fit is poorly conditioned.`] };
  const fit = fitCriticalSpeed(usable.map(i => ({ seconds: i.seconds, meters: i.distanceMeters })));
  const reject = (reason: string): CapacityMethodResult => ({ ...base, evidenceCount: usable.length, reasons: [reason] });
  if (!fit) return reject("Critical-speed regression is degenerate.");
  if (fit.r2 < P.minR2) return reject(`Fit quality R² ${fit.r2.toFixed(3)} is below ${P.minR2}; the efforts do not follow a single distance–time line.`);
  if (fit.slopeSeFraction > P.maxSlopeSeFraction) return reject(`Critical speed is poorly determined (standard error ${(fit.slopeSeFraction * 100).toFixed(1)}% of CS).`);
  if (fit.speed < P.minSpeed || fit.speed > P.maxSpeed) return reject("Fitted critical speed is physiologically implausible.");
  if (fit.dPrime < P.minDPrimeMeters || fit.dPrime > P.maxDPrimeMeters) return reject(`Fitted D′ ${fit.dPrime.toFixed(0)} m is outside the plausible ${P.minDPrimeMeters}–${P.maxDPrimeMeters} m range.`);
  if (usable.some(i => i.distanceMeters / i.seconds <= fit.speed)) return reject("An effort is slower than the fitted critical speed, which the model forbids.");
  return { ...base, status: "fit_only", evidenceCount: usable.length,
    criticalSpeed: { speedMetersPerSecond: fit.speed, dPrimeMeters: fit.dPrime, r2: fit.r2, standardErrorFraction: fit.slopeSeFraction,
      efforts: fit.n, durationRangeSeconds: [Math.min(...times), Math.max(...times)] },
    reasons: ["Critical speed fitted. No target-distance time is produced: endurance evidence is required to extrapolate a severe-domain parameter to a long event."] };
}

function qualityAndFlags(rows: CapacityContribution[], dispersion: number | null) {
  const totalWeight = rows.reduce((s, r) => s + r.weight, 0);
  const confirmedWeight = rows.filter(r => r.tier === "confirmed_maximal").reduce((s, r) => s + r.weight, 0);
  const P = CAPACITY_POLICY;
  const spread = rows.length > 1 ? Math.max(...rows.map(r => r.equivalentSeconds)) / Math.min(...rows.map(r => r.equivalentSeconds)) - 1 : 0;
  const contradictory = (dispersion !== null && dispersion > P.contradictoryDispersion) || spread > P.contradictorySpread;
  // Without a confirmed maximal performance, three independent items are needed before evidence counts as adequate.
  const adequate = (totalWeight >= P.adequateTotalWeight && rows.length >= 3) || confirmedWeight >= P.adequateConfirmedWeight;
  return { totalWeight, contradictory, spread, quality: adequate ? "adequate" as const : "limited" as const };
}

/** Method C — recency/quality/extrapolation-weighted log-mean over all independent qualifying items. */
/** Re-derive weight shares after rows were removed. */
function renormalize(rows: CapacityContribution[]): CapacityContribution[] {
  const total = rows.reduce((s, r) => s + r.weight, 0);
  for (const r of rows) r.weightShare = total > 0 ? r.weight / total : 0;
  return rows;
}

function methodC(q: EvidenceQualification, target: number, exponent: number) {
  const P = CAPACITY_POLICY;
  let rows = contributionsFor(q.independent, target, exponent);
  // Maximality asymmetry: a race result is the best evidence of what the athlete can do. An UNCONFIRMED effort that
  // implies a slower time is exactly what a submaximal effort looks like and says nothing against the race, so it may
  // only add information when it is faster. (Genuine decline is the physiological trend's job, and the anchor expires.)
  const raceRows = rows.filter(r => r.kind === "confirmed_race" || r.kind === "recorded_race");
  let ignoredSlower = 0;
  if (raceRows.length) {
    const raceLog = raceRows.reduce((s, r) => s + r.weight * Math.log(r.equivalentSeconds), 0) / raceRows.reduce((s, r) => s + r.weight, 0);
    const kept = rows.filter(r => r.kind === "confirmed_race" || r.kind === "recorded_race" || Math.log(r.equivalentSeconds) <= raceLog);
    ignoredSlower = rows.length - kept.length;
    rows = renormalize(kept);
  }
  const base: CapacityMethodResult = { id: "C_recent_demonstrated", version: `${CAPACITY_VERSION}/C`, status: "unavailable", targetDistanceMeters: target,
    seconds: null, evidenceCount: 0, contributions: rows, reasons: [], assumptions: ASSUMPTIONS };
  let cause: CapacityUnavailableCause | null = null;
  const anchors = rows.filter(r => r.kind === "confirmed_race" || r.kind === "recorded_race");
  const contemporary = rows.filter(r => r.kind !== "confirmed_race" && r.kind !== "recorded_race" && r.ageDays <= P.contemporaryWindowDays);
  const contemporaryEnough = contemporary.length >= P.minimumContemporaryItems
    && new Set(contemporary.map(r => isoWeek(r.date))).size >= P.minimumContemporaryWeeks
    && contemporary.some(r => extrapolationReliability(r.sourceDistanceMeters, target) >= P.minimumReliableExtrapolation);
  if (!anchors.length && !contemporaryEnough) {
    cause = !q.independent.length ? (q.expired.length ? "anchor_expired_no_contemporary_evidence" : "no_performance_evidence") : "insufficient_independent_evidence";
    const reason = cause === "anchor_expired_no_contemporary_evidence"
      ? "The only qualifying performance is older than 180 days and carries no weight; no strong contemporary evidence replaces it."
      : cause === "no_performance_evidence" ? "No qualifying race, time trial or strong sustained effort is available."
      : "Qualifying evidence is too thin: needs a race within 180 days, or at least two strong efforts in different weeks within 120 days including one that converts reliably to the target distance.";
    return { method: { ...base, reasons: [reason] }, cause, dispersion: null, quality: "insufficient" as const, flags: [] as string[], seconds: null };
  }
  const total = rows.reduce((s, r) => s + r.weight, 0);
  const meanLog = rows.reduce((s, r) => s + r.weight * Math.log(r.equivalentSeconds), 0) / total;
  const seconds = Math.exp(meanLog);
  const dispersion = rows.length > 1 ? weightedMad(rows.map(r => Math.log(r.equivalentSeconds)), rows.map(r => r.weight)) : null;
  const { contradictory, spread, quality } = qualityAndFlags(rows, dispersion);
  const flags: string[] = [];
  if (contradictory) flags.push("contradictory_evidence");
  if (rows.some(r => r.isolatedFast)) flags.push("isolated_fast_effort");
  if (ignoredSlower) flags.push("slower_unconfirmed_effort_ignored");
  if (!anchors.length) flags.push("no_race_anchor");
  if (rows.some(r => r.ageDays > EVIDENCE_POLICY.agingDays)) flags.push("aging_evidence");
  if (rows.every(r => r.extrapolationRatio > 1.5)) flags.push("speed_evidence_only");
  const reasons = [`${rows.length} independent ${rows.length === 1 ? "performance" : "performances"} contribute; weights combine quality, a ${P.halfLifeDays}-day recency half-life and extrapolation reliability.`];
  if (contradictory) reasons.push(`Evidence disagrees (spread ${(spread * 100).toFixed(1)}%): treated as provisional.`);
  return { method: { ...base, status: "available" as const, seconds, evidenceCount: rows.length, reasons }, cause: null, dispersion, quality, flags, seconds };
}

function weightedMad(values: number[], weights: number[]): number {
  const total = weights.reduce((s, w) => s + w, 0), mean = values.reduce((s, v, i) => s + v * weights[i], 0) / total;
  return values.reduce((s, v, i) => s + Math.abs(v - mean) * weights[i], 0) / total;
}

export interface CapacityOptions { targetDistanceMeters?: number; exponent?: number; qualification?: EvidenceQualification }

export function estimatePerformanceCapacity(input: Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">,
  options: CapacityOptions = {}): PerformanceCapacityResult {
  const target = options.targetDistanceMeters ?? HALF_MARATHON_METERS;
  const exponent = options.exponent ?? CAPACITY_POLICY.defaultExponent;
  const qualification = options.qualification ?? qualifyPerformanceEvidence(input);
  const supported = CAPACITY_POLICY.supportedTargetsMeters.some(t => Math.abs(t - target) <= CAPACITY_POLICY.targetToleranceMeters);
  const shell = { version: CAPACITY_VERSION, researchStatus: "experimental_provisional" as const, validated: false as const, asOf: input.asOf,
    asOfDate: qualification.asOfDate, targetDistanceMeters: target, qualification, exponent, assumptions: ASSUMPTIONS };
  const dates = qualification.independent.map(i => i.date).sort();
  const dataThrough = dates.at(-1) ?? null;
  if (!supported || !(exponent >= 1 && exponent <= 1.2)) {
    return { ...shell, dataThrough, status: "unavailable", unavailableCause: supported ? "invalid_input" : "unsupported_distance", seconds: null, methods: [],
      evidenceQuality: "insufficient", dispersionFraction: null, flags: [],
      reasons: [supported ? "The distance exponent must lie between 1.00 and 1.20." : "Only 5K, 10K and half-marathon targets are supported: extrapolating endurance evidence beyond the half marathon is not justified."] };
  }
  const A = methodA(qualification.independent, target, exponent), B = methodB(qualification.independent, target), C = methodC(qualification, target, exponent);
  const available = C.method.status === "available";
  const provisional = available && (C.quality === "limited" || C.flags.includes("contradictory_evidence"));
  return { ...shell, dataThrough, status: !available ? "unavailable" : provisional ? "provisional" : "available",
    unavailableCause: C.cause, seconds: C.seconds, methods: [A, B, C.method], evidenceQuality: C.quality, dispersionFraction: C.dispersion,
    flags: C.flags, reasons: C.method.reasons };
}

export { EVIDENCE_POLICY };
