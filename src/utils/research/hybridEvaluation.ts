/**
 * Phase 3T.1 — RESEARCH-ONLY offline evaluation of the Phase 3Q–3S models next to the official estimate.
 * Never imported by live code (test-enforced); read-only; aggregates only (no workout ids in outputs).
 *
 * Six kinds of evidence are kept APART and never merged into one score:
 *   1 engineering correctness   (the unit tests, not this module)
 *   2 availability and coverage (how often each model can speak, with what evidence)
 *   3 numerical sensitivity     (leave-one-out, day-to-day steps)
 *   4 physiological plausibility (bounds and agreement between independent signals)
 *   5 historical as-of behaviour (strict chronological replay; later data cannot enter)
 *   6 independent predictive accuracy — ONLY against independent qualified outcomes, and `NOT EVALUABLE`
 *     below MIN_QUALIFIED_OUTCOMES_FOR_ACCURACY. No coefficient is selected with an outcome that is then scored.
 */
import type { HealthWorkout } from "@/types/healthWorkout";
import type { RacePerformanceInput } from "@/types/racePerformance";
import { estimateCurrentHalfMarathon, type CurrentHalfEstimate } from "../experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "../hrEnhancedPerformance";
import { estimateHybridHalfMarathon, type HybridOptions } from "../performance/hybridPerformance";
import { performanceLocalDate } from "../performanceEvidence";
import type { Vo2Entry } from "../vo2History";
import { MIN_QUALIFIED_OUTCOMES_FOR_ACCURACY, type QualifiedOutcome } from "./signalEvaluation";

type Input = Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">;
export type ModelId = "official_v2" | "hr_enhanced_v1" | "capacity_A_race_equivalence" | "capacity_B_critical_speed" | "capacity_C_recent_demonstrated" | "hybrid_v1";

export interface ModelPoint {
  id: ModelId;
  available: boolean;
  status: string;
  seconds: number | null;
  /** The evidence families this model actually used at this instant (not what it could use). */
  evidenceUsed: string[];
  reason: string;
  cause?: string | null;
}
export interface EvaluationRow { asOf: string; asOfDate: string; models: ModelPoint[]; leakageExcluded: { workouts: number }; hybridFlags: string[]; independentEvidence: number }

const secondsOf = (e: CurrentHalfEstimate) => e.baselineSeconds === null || e.finishMinutes === null ? null : e.baselineSeconds + e.adjustmentSeconds;

/** Only completed workouts known at the instant; later weather/VO₂ are dropped (the live estimators enforce the same). */
export function truncateAsOf(input: Input, asOf: string): Input & { excluded: number } {
  const cutoff = Date.parse(asOf);
  const known = input.workouts.filter(w => w.endDate.getTime() <= cutoff && w.syncedAt.getTime() <= cutoff);
  return { ...input, workouts: known, asOf, excluded: input.workouts.length - known.length };
}

export function evaluateModelsAsOf(input: Input, asOf: string, extra: { vo2Entries?: readonly Vo2Entry[] } = {}): EvaluationRow {
  const t = truncateAsOf(input, asOf);
  const base: Input = { races: t.races, workouts: t.workouts, overrides: t.overrides, asOf, timeZone: t.timeZone };
  const day = performanceLocalDate(asOf, input.timeZone);
  const vo2Entries = extra.vo2Entries?.filter(e => e.date <= day);
  const official = estimateCurrentHalfMarathon(base);
  const hr = estimateHrEnhancedHalfMarathon(base, { official });
  const opts: HybridOptions = { official, hrEnhanced: hr, vo2Entries };
  const hybrid = estimateHybridHalfMarathon(base, opts);
  const capacity = hybrid.capacity;
  const A = capacity.methods[0], B = capacity.methods[1], C = capacity.methods[2];
  const p = (id: ModelId, status: string, seconds: number | null, evidenceUsed: string[], reason: string): ModelPoint =>
    ({ id, available: seconds !== null, status, seconds, evidenceUsed, reason });
  const models: ModelPoint[] = [
    p("official_v2", official.status, secondsOf(official), official.anchor ? ["race_anchor", "training_summary_volume", ...(official.adjustmentMethod === "matched_effort" ? ["matched_effort_pairs"] : [])] : [], official.reason),
    p("hr_enhanced_v1", hr.status, hr.candidateSeconds, hr.candidateSeconds === null ? [] : ["race_anchor", "pace_at_comparable_hr", "training_summary_volume"], hr.fallbackReason ?? ""),
    p("capacity_A_race_equivalence", A.status, A.seconds, A.contributions.map(c => c.kind), A.reasons[0] ?? ""),
    p("capacity_B_critical_speed", B.status, B.seconds, B.criticalSpeed ? ["critical_speed_fit_only"] : [], B.reasons[0] ?? ""),
    p("capacity_C_recent_demonstrated", C.status, C.seconds, [...new Set(C.contributions.map(c => c.kind))], C.reasons[0] ?? ""),
    { ...p("hybrid_v1", hybrid.status, hybrid.seconds, hybrid.contributions.filter(c => c.status === "used").map(c => c.family), hybrid.fallbackReason ?? ""), cause: hybrid.unavailableCause },
  ];
  return { asOf, asOfDate: day, models, leakageExcluded: { workouts: t.excluded }, hybridFlags: hybrid.flags, independentEvidence: capacity.qualification.independent.length };
}

export interface ReplaySummary {
  instants: number;
  availability: Record<ModelId, { available: number; share: number }>;
  hybridStatus: Record<string, number>;
  hybridUnavailableCauses: Record<string, number>;
  hybridDayToDay: { maxStepSeconds: number; meanStepSeconds: number; maxStepFractionOfRace: number } | null;
  differencesVsOfficial: { n: number; meanSeconds: number | null; maxAbsSeconds: number | null; hybridFasterShare: number | null };
  rows: EvaluationRow[];
}

export function replay(input: Input, instants: readonly string[], extra: { vo2Entries?: readonly Vo2Entry[] } = {}): ReplaySummary {
  const rows = instants.map(i => evaluateModelsAsOf(input, i, extra));
  const ids = rows[0]?.models.map(m => m.id) ?? [];
  const availability = Object.fromEntries(ids.map(id => {
    const n = rows.filter(r => r.models.find(m => m.id === id)!.available).length;
    return [id, { available: n, share: rows.length ? n / rows.length : 0 }];
  })) as ReplaySummary["availability"];
  const hybrid = rows.map(r => r.models.find(m => m.id === "hybrid_v1")!);
  const hybridStatus: Record<string, number> = {};
  for (const h of hybrid) hybridStatus[h.status] = (hybridStatus[h.status] ?? 0) + 1;
  const seq = hybrid.map(h => h.seconds);
  const steps = seq.slice(1).flatMap((s, i) => s !== null && seq[i] !== null ? [Math.abs(s - seq[i]!)] : []);
  const diffs = rows.flatMap(r => { const h = r.models.find(m => m.id === "hybrid_v1")!, o = r.models.find(m => m.id === "official_v2")!; return h.seconds !== null && o.seconds !== null ? [h.seconds - o.seconds] : []; });
  const refSeconds = seq.find((s): s is number => s !== null) ?? 7870;
  const causes: Record<string, number> = {};
  for (const h of hybrid) if (h.cause) causes[h.cause] = (causes[h.cause] ?? 0) + 1;
  return { instants: rows.length, availability, hybridStatus, hybridUnavailableCauses: causes,
    hybridDayToDay: steps.length ? { maxStepSeconds: Math.max(...steps), meanStepSeconds: steps.reduce((a, b) => a + b, 0) / steps.length, maxStepFractionOfRace: Math.max(...steps) / refSeconds } : null,
    differencesVsOfficial: { n: diffs.length, meanSeconds: diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null,
      maxAbsSeconds: diffs.length ? Math.max(...diffs.map(Math.abs)) : null, hybridFasterShare: diffs.length ? diffs.filter(d => d < 0).length / diffs.length : null }, rows };
}

/** Leave-one-out over recent runs and over each independent evidence item: how much does any single workout move the hybrid? */
export function hybridLeaveOneOut(input: Input, recentDays = 56) {
  const full = estimateHybridHalfMarathon(input);
  const cutoff = Date.parse(performanceLocalDate(input.asOf, input.timeZone) + "T00:00:00Z") - recentDays * 86_400_000;
  const raceRuns = new Set(input.races.flatMap(r => r.actualRunId ? [r.actualRunId] : []));
  const evidenceIds = new Set(full.capacity.qualification.independent.flatMap(i => i.workoutId ? [i.workoutId] : []));
  const ids = input.workouts.filter((w: HealthWorkout) => w.isRunLike && !raceRuns.has(w.workoutId) && (w.startDate.getTime() >= cutoff || evidenceIds.has(w.workoutId))).map(w => w.workoutId);
  let maxShift = 0, flips = 0, tested = 0, maxEvidenceShift = 0;
  const shifts: number[] = [];
  for (const id of ids) {
    const h = estimateHybridHalfMarathon({ ...input, workouts: input.workouts.filter(w => w.workoutId !== id) });
    tested++;
    if ((h.seconds === null) !== (full.seconds === null)) { flips++; continue; }
    if (h.seconds !== null && full.seconds !== null) {
      const s = Math.abs(h.seconds - full.seconds); shifts.push(s); maxShift = Math.max(maxShift, s);
      if (evidenceIds.has(id)) maxEvidenceShift = Math.max(maxEvidenceShift, s);
    }
  }
  shifts.sort((a, b) => a - b);
  return { runsTested: tested, maxAbsShiftSeconds: maxShift, p90AbsShiftSeconds: shifts.length ? shifts[Math.floor(0.9 * (shifts.length - 1))] : null,
    maxEvidenceItemShiftSeconds: maxEvidenceShift, availabilityFlips: flips,
    maxShiftFraction: full.seconds ? maxShift / full.seconds : null };
}

export interface PlausibilityCheck { name: string; pass: boolean; detail: string }
/** Physiological-plausibility screens on one row. A pass is the absence of an implausible result, not accuracy. */
export function plausibility(row: EvaluationRow, bounds = { minSpeed: 1.0, maxSpeed: 7.5, maxFractionFromRaceEquivalent: 0.1 }): PlausibilityCheck[] {
  const h = row.models.find(m => m.id === "hybrid_v1")!, c = row.models.find(m => m.id === "capacity_C_recent_demonstrated")!, o = row.models.find(m => m.id === "official_v2")!;
  const checks: PlausibilityCheck[] = [];
  if (h.seconds === null) return [{ name: "hybrid_available", pass: true, detail: `unavailable (${h.status}); nothing to screen` }];
  const speed = 21097.5 / h.seconds;
  checks.push({ name: "plausible_speed", pass: speed >= bounds.minSpeed && speed <= bounds.maxSpeed, detail: `${speed.toFixed(2)} m/s` });
  if (c.seconds !== null) checks.push({ name: "hybrid_within_3pct_of_capacity_base", pass: Math.abs(h.seconds / c.seconds - 1) <= 0.03 + 1e-9, detail: `${((h.seconds / c.seconds - 1) * 100).toFixed(2)}%` });
  if (o.seconds !== null) checks.push({ name: "hybrid_within_10pct_of_official", pass: Math.abs(h.seconds / o.seconds - 1) <= bounds.maxFractionFromRaceEquivalent, detail: `${((h.seconds / o.seconds - 1) * 100).toFixed(2)}%` });
  return checks;
}

export type OutcomeScore =
  | { status: "NOT EVALUABLE"; qualifiedOutcomes: number; required: number; reason: string }
  | { status: "DESCRIPTIVE ONLY"; qualifiedOutcomes: number; required: number; models: { id: ModelId; scored: number; meanAbsoluteErrorSeconds: number | null; meanSignedErrorSeconds: number | null }[]; note: string };

/** Signed error = predicted − actual (positive = predicted too slow). Rows only score outcomes strictly later than their as-of date. */
export function scoreModelsAgainstOutcomes(rows: readonly EvaluationRow[], outcomes: readonly QualifiedOutcome[]): OutcomeScore {
  const qualified = outcomes.filter(o => o.qualified && o.finishSeconds > 0);
  const required = MIN_QUALIFIED_OUTCOMES_FOR_ACCURACY;
  if (qualified.length < required) return { status: "NOT EVALUABLE", qualifiedOutcomes: qualified.length, required,
    reason: `${qualified.length} independent qualified outcome(s); at least ${required} are required before any error statistic is reported. Outcomes that informed any coefficient cannot count as validation.` };
  const errors = new Map<ModelId, number[]>();
  for (const r of rows) {
    const target = qualified.filter(o => o.raceDate > r.asOfDate).sort((a, b) => a.raceDate.localeCompare(b.raceDate))[0];
    if (!target) continue;
    for (const m of r.models) if (m.seconds !== null) errors.set(m.id, [...(errors.get(m.id) ?? []), m.seconds - target.finishSeconds]);
  }
  return { status: "DESCRIPTIVE ONLY", qualifiedOutcomes: qualified.length, required,
    models: [...errors].map(([id, e]) => ({ id, scored: e.length, meanAbsoluteErrorSeconds: e.reduce((s, x) => s + Math.abs(x), 0) / e.length, meanSignedErrorSeconds: e.reduce((s, x) => s + x, 0) / e.length })),
    note: "Rows share outcomes and are dependent; no ranking, winner or significance claim is made." };
}
