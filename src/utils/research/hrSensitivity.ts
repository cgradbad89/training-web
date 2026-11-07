/**
 * Phase 3O — RESEARCH-ONLY sensitivity and robustness measurements for the HR-enhanced estimate.
 * Never imported by live code (test-enforced). Aggregates only: no workout identifiers in outputs.
 */
import type { HealthWorkout } from "@/types/healthWorkout";
import type { RacePerformanceInput } from "@/types/racePerformance";
import { estimateCurrentHalfMarathon } from "../experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon, HR_ENHANCED_POLICY } from "../hrEnhancedPerformance";
import type { HrSignalPolicy } from "../hrEffortSignal";

type Input = Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">;
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(p * (s.length - 1))] : null; };

export interface PointResult { status: string; candidateSeconds: number | null; differenceSeconds: number | null; contrastPercent: number | null; strength: number }
export function point(input: Input, signalPolicy?: Partial<HrSignalPolicy>): PointResult {
  const r = estimateHrEnhancedHalfMarathon(input, { signalPolicy });
  return { status: r.status, candidateSeconds: r.candidateSeconds, differenceSeconds: r.differenceSeconds,
    contrastPercent: r.signal?.contrast.shrunkPercent ?? null, strength: r.signal?.strength.combined ?? 0 };
}

/** Leave-one-out over every supporting run (removed one at a time): the largest change any single workout causes. */
export function leaveOneOut(input: Input): { runsTested: number; maxAbsCandidateShiftSeconds: number; p90AbsCandidateShiftSeconds: number | null;
  /** Shift in (candidate − official): the part attributable to the HR evidence alone. */
  maxAbsHrAttributableShiftSeconds: number; maxAbsOfficialShiftSeconds: number; maxAbsContrastShiftPoints: number; availabilityFlips: number } {
  const base = point(input), baseOfficial = estimateCurrentHalfMarathon(input);
  const baseOfficialSeconds = baseOfficial.baselineSeconds === null ? 0 : baseOfficial.baselineSeconds + baseOfficial.adjustmentSeconds;
  const est = estimateHrEnhancedHalfMarathon(input);
  const ids = new Set<string>();
  // Candidates: every run-like workout inside either window (the signal reports counts only, so test all plausible contributors).
  // Race-linked workouts are anchors, not training: removing one changes the anchor, which is a different question.
  const raceRuns = new Set(input.races.flatMap(r => r.actualRunId ? [r.actualRunId] : []));
  for (const w of input.workouts) if (w.isRunLike && !raceRuns.has(w.workoutId)) ids.add(w.workoutId);
  const shifts: number[] = []; let maxHr = 0; let maxOfficial = 0, maxContrast = 0, flips = 0, tested = 0;
  for (const id of ids) {
    const rest = input.workouts.filter((w: HealthWorkout) => w.workoutId !== id);
    const p = point({ ...input, workouts: rest });
    const o = estimateCurrentHalfMarathon({ ...input, workouts: rest });
    tested++;
    const a = base.candidateSeconds ?? est.officialSeconds ?? 0, b = p.candidateSeconds ?? (o.baselineSeconds === null ? 0 : o.baselineSeconds + o.adjustmentSeconds);
    shifts.push(Math.abs(a - b));
    maxHr = Math.max(maxHr, Math.abs((base.differenceSeconds ?? 0) - (p.differenceSeconds ?? 0)));
    maxOfficial = Math.max(maxOfficial, Math.abs(baseOfficialSeconds - (o.baselineSeconds === null ? 0 : o.baselineSeconds + o.adjustmentSeconds)));
    if (base.contrastPercent !== null && p.contrastPercent !== null) maxContrast = Math.max(maxContrast, Math.abs(base.contrastPercent - p.contrastPercent));
    if ((base.status === "unavailable") !== (p.status === "unavailable")) flips++;
  }
  return { runsTested: tested, maxAbsCandidateShiftSeconds: Math.max(0, ...shifts), p90AbsCandidateShiftSeconds: q(shifts, 0.9),
    maxAbsHrAttributableShiftSeconds: maxHr, maxAbsOfficialShiftSeconds: maxOfficial, maxAbsContrastShiftPoints: maxContrast, availabilityFlips: flips };
}

export const POLICY_PERTURBATIONS: { name: string; policy: Partial<HrSignalPolicy> }[] = [
  { name: "band ±5 bpm", policy: { supportHalfWidthBpm: 5 } },
  { name: "band ±12 bpm", policy: { supportHalfWidthBpm: 12 } },
  { name: "recent window 28 d", policy: { recentDays: 28, recentFullWeightDays: 21 } },
  { name: "recent window 56 d", policy: { recentDays: 56, recentFullWeightDays: 42 } },
  { name: "noise multiplier 0.5", policy: { noiseMultiplier: 0.5 } },
  { name: "noise multiplier 1.5", policy: { noiseMultiplier: 1.5 } },
  { name: "min 4 runs/period", policy: { minimumRunsPerPeriod: 4 } },
  { name: "min 7 runs/period", policy: { minimumRunsPerPeriod: 7 } },
  { name: "partial weather factor 0.25", policy: { weatherPartialFactor: 0.25 } },
  { name: "partial weather factor 0.75", policy: { weatherPartialFactor: 0.75 } },
  { name: "full-strength HR diff 1 bpm", policy: { fullStrengthHrDifferenceBpm: 1 } },
  { name: "full-strength HR diff 3 bpm", policy: { fullStrengthHrDifferenceBpm: 3 } },
  { name: "consistency 0.5", policy: { consistencyShare: 0.5 } },
  { name: "consistency 0.8", policy: { consistencyShare: 0.8 } },
];
export function policySensitivity(input: Input) {
  const base = point(input);
  return { base, variants: POLICY_PERTURBATIONS.map(v => { const p = point(input, v.policy);
    return { name: v.name, status: p.status, candidateSeconds: p.candidateSeconds, shiftSeconds: p.candidateSeconds !== null && base.candidateSeconds !== null ? p.candidateSeconds - base.candidateSeconds : null,
      availabilityChanged: (p.status === "unavailable") !== (base.status === "unavailable"), directionChanged: Math.sign(p.contrastPercent ?? 0) !== Math.sign(base.contrastPercent ?? 0) }; }) };
}

/** Daily as-of series: coverage, suppression frequency and day-to-day volatility. */
export function dailySeries(input: Input, dates: readonly string[]) {
  const rows = dates.map(asOf => { const p = point({ ...input, asOf }); const o = estimateCurrentHalfMarathon({ ...input, asOf });
    return { asOf, ...p, officialSeconds: o.baselineSeconds === null ? null : o.baselineSeconds + o.adjustmentSeconds }; });
  const diffs = rows.map(r => r.differenceSeconds ?? 0);
  const steps = diffs.slice(1).map((d, i) => Math.abs(d - diffs[i]));
  const avail = rows.filter(r => r.status !== "unavailable").length;
  const directional = rows.filter(r => r.status === "available").length;
  return { rows, days: rows.length, availableDays: avail, directionalDays: directional, suppressedDays: rows.length - avail,
    maxAbsDifferenceSeconds: Math.max(0, ...diffs.map(Math.abs)), maxDayToDayStepSeconds: Math.max(0, ...steps), meanDayToDayStepSeconds: steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : 0 };
}
export const HR_ENHANCED_BOUNDS = { capFraction: HR_ENHANCED_POLICY.maximumDifferenceFraction };
