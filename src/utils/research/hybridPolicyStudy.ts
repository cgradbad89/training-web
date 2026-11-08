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
import { isDemonstratedRaceEvidence } from "../performance/evidenceQualification";

export interface StudyInput { races: Race[]; workouts: HealthWorkout[]; overrides: Record<string, WorkoutOverride>; asOf: string; timeZone: string }

const round = (n: number | null | undefined, k = 1) => (n === null || n === undefined ? null : Math.round(n * 10 ** k) / 10 ** k);
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Every calendar date from `from` to `to` inclusive. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ─── the one alternative policy (now the production policy; kept here as the comparison harness) ───

export type RacePolicy = "strict_maximal" | "nonmaximal_lower_bound";

/** Races production now treats as demonstrated performance: confirmed hard/nonmaximal races that passed every integrity check. */
export function nonmaximalRaceIds(input: StudyInput): string[] {
  const ids = new Set(buildRaceEvidence(input).filter(isDemonstratedRaceEvidence).map(e => e.raceId));
  return [...ids];
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
}

/**
 * `strict_maximal` runs the shipped v1.1 with the demonstrated-race policy switched off (`strictMaximalOnly`); `nonmaximal_lower_bound` runs the
 * shipped default. With no hard/nonmaximal-attested race the two are identical. Neither reads an effort percentage.
 */
export function estimateWithPolicy(input: StudyInput, policy: RacePolicy, options: Parameters<typeof estimateHybridHalfMarathonV11>[1] = {}): PolicyResult {
  const strict = estimateHybridHalfMarathonV11(input, { ...options, strictMaximalOnly: true });
  const ids = nonmaximalRaceIds(input);
  const e = policy === "strict_maximal" ? strict : estimateHybridHalfMarathonV11(input, { ...options, strictMaximalOnly: false });
  const used = e.demonstrated.basis !== "maximal_or_recorded_evidence";
  return { policy, status: e.status, seconds: round(e.seconds), confidence: e.confidence, lowerBoundOnly: used, nonmaximalRaces: policy === "strict_maximal" ? 0 : ids.length,
    source: e.seconds === null ? "none" : used ? "nonmaximal_race" : "strict_evidence", strictSeconds: round(strict.seconds) };
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
