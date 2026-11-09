/**
 * RESEARCH-ONLY offline evaluation of the four-distance Hybrid v1.1 current-fitness estimator. Never imported by live code
 * (test-enforced); read-only; aggregates only (no workout ids in outputs).
 *
 * Kept APART, never merged into one score:
 *   1 coverage        how often each distance can speak, and with what status/confidence
 *   2 stability       day-to-day steps per distance (a routine easy run must not move an estimate)
 *   3 consistency     implied cross-distance scaling exponents (an implausible optimism/pessimism screen)
 *   4 as-of behaviour strict chronological replay; later data cannot enter
 *   5 accuracy        ONLY against independent qualified outcomes of the SAME distance, and `NOT EVALUABLE` below
 *                     MIN_QUALIFIED_OUTCOMES_FOR_ACCURACY per distance. Small samples are never presented as proof.
 * No coefficient is selected with an outcome that is then scored.
 */
import type { RacePerformanceInput } from "@/types/racePerformance";
import { performanceLocalDate } from "../performanceEvidence";
import { computeCurrentFitness, type CurrentFitness, type CurrentFitnessOptions } from "../performance/hybridCurrentFitness";
import { HYBRID_TARGETS, type HybridTargetId } from "../performance/hybridTargetProfiles";
import { MIN_QUALIFIED_OUTCOMES_FOR_ACCURACY } from "./signalEvaluation";
import { truncateAsOf } from "./hybridEvaluation";

type Input = Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">;

export interface TargetPoint { id: HybridTargetId; status: string; confidence: string | null; seconds: number | null; paceSecondsPerMile: number | null }
export interface FitnessReplayRow { asOf: string; asOfDate: string; targets: TargetPoint[]; impliedExponents: number[]; consistent: boolean; leakageExcluded: number }

/** One as-of evaluation: later workouts (not yet ended/synced) are dropped before ANY estimator sees them. */
export function evaluateFitnessAsOf(input: Input, asOf: string, options: CurrentFitnessOptions = {}): { row: FitnessReplayRow; fitness: CurrentFitness } {
  const t = truncateAsOf(input, asOf);
  const fitness = computeCurrentFitness({ races: t.races, workouts: t.workouts, overrides: t.overrides, asOf, timeZone: t.timeZone }, options);
  return { fitness, row: { asOf, asOfDate: performanceLocalDate(asOf, input.timeZone), leakageExcluded: t.excluded,
    targets: fitness.rows.map(r => ({ id: r.id, status: r.status, confidence: r.confidence, seconds: r.estimate.seconds, paceSecondsPerMile: r.paceSecondsPerMile })),
    impliedExponents: fitness.consistency.pairs.map(p => p.impliedExponent), consistent: fitness.consistency.consistent } };
}

export function replayFitness(input: Input, instants: readonly string[], options: CurrentFitnessOptions = {}): FitnessReplayRow[] {
  return instants.map(asOf => evaluateFitnessAsOf(input, asOf, options).row);
}

export interface TargetStability {
  id: HybridTargetId;
  days: number; available: number; availabilityShare: number;
  /** Largest and mean absolute day-to-day relative change between consecutive AVAILABLE days. */
  maxStepFraction: number | null; meanStepFraction: number | null;
  statusChanges: number;
}
export function stabilityMetrics(rows: readonly FitnessReplayRow[]): TargetStability[] {
  return HYBRID_TARGETS.map(t => {
    const series = rows.map(r => r.targets.find(x => x.id === t.id)!);
    const steps: number[] = [];
    let prev: number | null = null, changes = 0;
    series.forEach((p, i) => {
      if (p.seconds !== null && prev !== null) steps.push(Math.abs(p.seconds - prev) / prev);
      if (p.seconds !== null) prev = p.seconds;
      if (i > 0 && p.status !== series[i - 1].status) changes++;
    });
    const available = series.filter(p => p.seconds !== null).length;
    return { id: t.id, days: series.length, available, availabilityShare: series.length ? available / series.length : 0,
      maxStepFraction: steps.length ? Math.max(...steps) : null, meanStepFraction: steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : null, statusChanges: changes };
  });
}

export interface DistanceOutcome { raceDate: string; distanceId: HybridTargetId; finishSeconds: number; qualified: boolean }
export type DistanceScore =
  | { id: HybridTargetId; status: "NOT EVALUABLE"; qualifiedOutcomes: number; required: number; reason: string }
  | { id: HybridTargetId; status: "DESCRIPTIVE ONLY"; qualifiedOutcomes: number; required: number; scored: number; meanAbsoluteErrorFraction: number; meanSignedErrorFraction: number; note: string };

/** Signed error = (predicted − actual) / actual (positive = predicted too slow). A row is scored only against a later outcome of the same distance. */
export function scoreFitnessAgainstOutcomes(rows: readonly FitnessReplayRow[], outcomes: readonly DistanceOutcome[]): DistanceScore[] {
  const required = MIN_QUALIFIED_OUTCOMES_FOR_ACCURACY;
  return HYBRID_TARGETS.map((t): DistanceScore => {
    const qualified = outcomes.filter(o => o.distanceId === t.id && o.qualified && o.finishSeconds > 0);
    if (qualified.length < required) return { id: t.id, status: "NOT EVALUABLE", qualifiedOutcomes: qualified.length, required,
      reason: `${qualified.length} independent qualified ${t.label} outcome(s); at least ${required} are required before any error statistic is reported.` };
    const errors: number[] = [];
    for (const r of rows) {
      const point = r.targets.find(x => x.id === t.id)!;
      if (point.seconds === null) continue;
      const target = qualified.filter(o => o.raceDate > r.asOfDate).sort((a, b) => a.raceDate.localeCompare(b.raceDate))[0];
      if (target) errors.push((point.seconds - target.finishSeconds) / target.finishSeconds);
    }
    return { id: t.id, status: "DESCRIPTIVE ONLY", qualifiedOutcomes: qualified.length, required, scored: errors.length,
      meanAbsoluteErrorFraction: errors.length ? errors.reduce((s, e) => s + Math.abs(e), 0) / errors.length : NaN,
      meanSignedErrorFraction: errors.length ? errors.reduce((s, e) => s + e, 0) / errors.length : NaN,
      note: "Rows share outcomes and are dependent; no ranking, winner or significance claim is made." };
  });
}

/**
 * Simpler baselines for the SAME outcome, for context (never a "winner"): the unadjusted Riegel conversion (exponent 1.06) of the single most
 * recent qualified race before the as-of date. Returns null when no race exists.
 */
export function riegelBaselineSeconds(races: readonly { date: string; distanceMeters: number; seconds: number }[], asOfDate: string, targetMeters: number, exponent = 1.06): number | null {
  const prior = races.filter(r => r.date < asOfDate).sort((a, b) => b.date.localeCompare(a.date))[0];
  return prior ? prior.seconds * Math.pow(targetMeters / prior.distanceMeters, exponent) : null;
}
