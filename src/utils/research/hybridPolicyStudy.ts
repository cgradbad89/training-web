/**
 * RESEARCH-ONLY toolkit for the "keep Hybrid v1.2 simple" policy study (2026-11-08). Never imported by live code (test-enforced).
 * It calls the SHIPPED estimators unchanged and wraps them; no production formula, constant, threshold or stored record is altered.
 *
 * Owner constraints this file is built to respect (see docs/hybrid-v1.2-policy-study.md):
 *  - subjective effort ("about 80 %", "about 90 %") is HISTORICAL INFORMATION ONLY: no function here reads an effort percentage, and the
 *    only effort-dependent input is the existing categorical `maximal | nonmaximal | unknown` attestation;
 *  - effort is never converted to a time, never discounted, no slider, no coefficient;
 *  - exactly one alternative to the strict-maximal policy is evaluated (`nonmaximal_lower_bound`, below).
 */
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { estimateHybridHalfMarathonV11 } from "../performance/hybridPerformanceV11";
import type { HybridV11Estimate } from "@/types/hybridPerformanceV11";
import { buildRaceEvidence } from "../racePerformance";

export interface StudyInput { races: Race[]; workouts: HealthWorkout[]; overrides: Record<string, WorkoutOverride>; asOf: string; timeZone: string }

const round = (n: number | null | undefined, k = 1) => (n === null || n === undefined ? null : Math.round(n * 10 ** k) / 10 ** k);
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Every calendar date from `from` to `to` inclusive. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ─── the one alternative policy ───────────────────────────────────────────────

export type RacePolicy = "strict_maximal" | "nonmaximal_lower_bound";

/**
 * Races whose confirmation attests `effort: "nonmaximal"` and that production otherwise accepts (valid, available, consistent after
 * reconciliation, same race identity). Only the CATEGORICAL attestation is read.
 */
export function nonmaximalRaceIds(input: StudyInput): string[] {
  return buildRaceEvidence(input)
    .filter(e => e.effort === "nonmaximal" && e.status !== "inconsistent" && e.status !== "insufficient_evidence" && e.availableAsOf && e.finishSeconds !== null && e.distanceMeters !== null)
    .map(e => e.raceId);
}

/**
 * RESEARCH TRANSFORM: the same input with those races' effort attestation read as `maximal`. Nothing else (time, distance, conditions) changes.
 * Limitation: only the legacy `performanceEvidence` confirmation shape is rewritten; a race carrying a saved `confirmationHistory` revision is
 * left as is (so the alternative then equals the strict policy for it — it can never invent evidence).
 */
export function readNonmaximalAsAchievable(input: StudyInput, ids: readonly string[]): StudyInput {
  const set = new Set(ids);
  return { ...input, races: input.races.map(r => set.has(r.id) && r.performanceEvidence && !r.confirmationHistory
    ? { ...r, performanceEvidence: { ...r.performanceEvidence, effort: "maximal" as const } }
    : r) };
}

export interface PolicyResult {
  policy: RacePolicy;
  status: HybridV11Estimate["status"];
  seconds: number | null;
  confidence: HybridV11Estimate["confidence"];
  /** `nonmaximal_lower_bound` only: the number is bounded by an achieved-but-not-maximal time. */
  lowerBoundOnly: boolean;
  /** Which evidence class produced the number. */
  source: "strict_evidence" | "nonmaximal_race" | "none";
  nonmaximalRaces: number;
  strictSeconds: number | null;
  asIfAchievableSeconds: number | null;
}

/**
 * The single alternative: a confirmed-nonmaximal race is evidence of what was ACHIEVED, i.e. an upper bound on the athlete's maximal time.
 *   - it is admitted exactly as the shipped model admits a confirmed race (same σ, same physiology/endurance terms) — no discount, no effort scaling;
 *   - it can only make the estimate FASTER than the strict estimate, never slower: result = min(strict, with-race);
 *   - when nothing else qualifies it stands alone and the result is labelled `lowerBoundOnly`, provisional, confidence `low`.
 * With no nonmaximal-attested race the function returns the strict production estimate unchanged.
 */
export function estimateWithPolicy(input: StudyInput, policy: RacePolicy, options: Parameters<typeof estimateHybridHalfMarathonV11>[1] = {}): PolicyResult {
  const strict = estimateHybridHalfMarathonV11(input, options);
  const ids = policy === "strict_maximal" ? [] : nonmaximalRaceIds(input);
  const base = { policy, nonmaximalRaces: ids.length, strictSeconds: round(strict.seconds) };
  if (!ids.length) return { ...base, status: strict.status, seconds: round(strict.seconds), confidence: strict.confidence, lowerBoundOnly: false, source: strict.seconds === null ? "none" : "strict_evidence", asIfAchievableSeconds: null };
  const asIf = estimateHybridHalfMarathonV11(readNonmaximalAsAchievable(input, ids), options);
  const a = asIf.seconds, s = strict.seconds;
  if (a === null) return { ...base, status: strict.status, seconds: round(s), confidence: strict.confidence, lowerBoundOnly: false, source: s === null ? "none" : "strict_evidence", asIfAchievableSeconds: null };
  if (s !== null && s <= a) return { ...base, status: strict.status, seconds: round(s), confidence: strict.confidence, lowerBoundOnly: false, source: "strict_evidence", asIfAchievableSeconds: round(a) };
  return { ...base, status: "provisional", seconds: round(a), confidence: "low", lowerBoundOnly: true, source: "nonmaximal_race", asIfAchievableSeconds: round(a) };
}

// ─── daily series and step profile (for the cliff studies) ───────────────────

export interface DayRow {
  date: string; status: string; seconds: number | null; base: number | null; physiologySeconds: number; enduranceSeconds: number;
  readiness: number | null; trendStatus: string; trendRuns: number | null; expiredEvidence: number; observations: number;
  raceShare: number; physiologyInfluence: number;
}

/** Evaluate the shipped v1.1 estimator at 12:00 UTC of every listed date on one full-history athlete (later workouts are excluded by the model's own as-of rule). */
export function dailySeries(input: Omit<StudyInput, "asOf">, dates: readonly string[], options: Parameters<typeof estimateHybridHalfMarathonV11>[1] = {}): DayRow[] {
  return dates.map(date => {
    const e = estimateHybridHalfMarathonV11({ ...input, asOf: `${date}T12:00:00.000Z` }, options);
    const phys = e.contributions.find(c => c.family === "physiological_trend");
    return { date, status: e.status, seconds: round(e.seconds), base: round(e.combination.baseSeconds), physiologySeconds: round(e.influence.physiologyAdjustmentSeconds) ?? 0,
      enduranceSeconds: round(e.influence.enduranceAdjustmentSeconds) ?? 0, readiness: round(e.readiness?.score, 3), trendStatus: e.physiology?.status ?? "none",
      trendRuns: e.physiology?.runs ?? null, expiredEvidence: e.qualification.base.expired.length, observations: e.combination.independentObservations,
      raceShare: round(e.combination.raceShare, 3) ?? 0, physiologyInfluence: round(phys?.influence, 3) ?? 0 };
  });
}

export interface StepProfile {
  days: number; availableDays: number;
  /** Largest absolute day-to-day change between two consecutive AVAILABLE days. */
  maxStepSeconds: number; maxStepDate: string | null;
  stepsOver30s: number; stepsOver60s: number;
  /** Number of times the estimate switched between available/provisional and unavailable. */
  availabilityFlips: number;
  /** Sum of absolute daily changes (total path length), for comparing candidates on the same scenario. */
  pathSeconds: number;
}

export function stepProfile(rows: readonly DayRow[]): StepProfile {
  let max = 0, maxDate: string | null = null, over30 = 0, over60 = 0, flips = 0, path = 0, available = 0;
  for (let i = 0; i < rows.length; i++) {
    const has = rows[i].seconds !== null;
    if (has) available++;
    if (i === 0) continue;
    const prev = rows[i - 1], prevHas = prev.seconds !== null;
    if (has !== prevHas) flips++;
    if (has && prevHas) {
      const d = Math.abs(rows[i].seconds! - prev.seconds!);
      path += d;
      if (d > max) { max = d; maxDate = rows[i].date; }
      if (d > 30) over30++;
      if (d > 60) over60++;
    }
  }
  return { days: rows.length, availableDays: available, maxStepSeconds: round(max) ?? 0, maxStepDate: maxDate, stepsOver30s: over30, stepsOver60s: over60, availabilityFlips: flips, pathSeconds: round(path) ?? 0 };
}

/** Share of one item's day-0 precision that remains at `ageDays`, for a measurement σ and the model's 1 %·√(age/30) drift (analytic; matches `combineEvidence`). */
export function precisionRetained(ageDays: number, measurementSigma: number, driftPerSqrtMonth = 0.01): number {
  const v0 = measurementSigma ** 2, v = v0 + (driftPerSqrtMonth * Math.sqrt(Math.max(0, ageDays) / 30)) ** 2;
  return v0 / v;
}
