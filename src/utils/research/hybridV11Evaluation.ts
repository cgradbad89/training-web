/**
 * Phase 3Y — RESEARCH-ONLY offline comparison of hybrid v1.1 against official v2, HR-enhanced v1, hybrid v1 and the two race-day
 * forecasts. Never imported by live code (test-enforced); read-only; aggregates only (no workout identifiers in any output).
 *
 * As in `hybridEvaluation.ts`, the kinds of evidence are kept APART and never merged into one score:
 *   availability · evidence coverage · numerical sensitivity · stability · chronological correctness · physiological plausibility ·
 *   historical outcome error (only where QUALIFIED outcomes exist) · independent accuracy (`NOT EVALUABLE` below the unchanged
 *   MIN_QUALIFIED_OUTCOMES_FOR_ACCURACY). No coefficient is selected with an outcome that is then scored; the thresholds of v1.1
 *   were set from the evidence-model reasoning in `evidenceCombination.ts` and the synthetic scenarios, not tuned to this athlete.
 */
import type { HealthWorkout } from "@/types/healthWorkout";
import type { HrStreamSummary } from "@/types/hybridPerformance";
import type { RacePerformanceInput } from "@/types/racePerformance";
import type { Vo2Entry } from "../vo2History";
import { estimateCurrentHalfMarathon, type CurrentHalfEstimate } from "../experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "../hrEnhancedPerformance";
import { estimateHybridHalfMarathon } from "../performance/hybridPerformance";
import { estimateHybridHalfMarathonV11, type HybridV11Options } from "../performance/hybridPerformanceV11";
import { performanceLocalDate } from "../performanceEvidence";
import { truncateAsOf } from "./hybridEvaluation";

type Input = Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">;
export interface V11Extra { vo2Entries?: readonly Vo2Entry[]; streamSummaries?: Readonly<Record<string, HrStreamSummary>> }
const secondsOf = (e: CurrentHalfEstimate) => e.baselineSeconds === null || e.finishMinutes === null ? null : e.baselineSeconds + e.adjustmentSeconds;

export interface VersionRow {
  asOf: string; asOfDate: string;
  officialSeconds: number | null; hrEnhancedSeconds: number | null; hybridV1Seconds: number | null; hybridV11Seconds: number | null;
  v1Status: string; v11Status: string; v11Cause: string | null; v11Confidence: string | null;
  raceShare: number; recentShare: number; independentObservations: number; latestRaceAgeDays: number | null; raceDominance: string;
  displacementSeconds: number | null; physiologyAdjustmentSeconds: number; enduranceAdjustmentSeconds: number;
  segmentsQualified: number; flags: string[]; conflicts: string[]; leakageExcluded: number;
}

/** Chronological: only completed workouts known at the instant; later VO₂ is dropped. */
export function compareVersionsAsOf(input: Input, asOf: string, extra: V11Extra = {}, options: Partial<HybridV11Options> = {}): VersionRow {
  const t = truncateAsOf(input, asOf);
  const base: Input = { races: t.races, workouts: t.workouts, overrides: t.overrides, asOf, timeZone: t.timeZone };
  const day = performanceLocalDate(asOf, input.timeZone);
  const vo2Entries = extra.vo2Entries?.filter(e => e.date <= day);
  const official = estimateCurrentHalfMarathon(base);
  const hr = estimateHrEnhancedHalfMarathon(base, { official });
  const v1 = estimateHybridHalfMarathon(base, { official, hrEnhanced: hr, vo2Entries });
  const v11 = estimateHybridHalfMarathonV11(base, { official, hrEnhanced: hr, vo2Entries, streamSummaries: extra.streamSummaries, hybridV1: v1,
    vo2Load: vo2Entries ? "loaded" : "not_requested", streamLoad: extra.streamSummaries ? "loaded" : "not_requested", ...options });
  const i = v11.influence;
  return { asOf, asOfDate: day, officialSeconds: secondsOf(official), hrEnhancedSeconds: hr.candidateSeconds ?? null, hybridV1Seconds: v1.seconds, hybridV11Seconds: v11.seconds,
    v1Status: v1.status, v11Status: v11.status, v11Cause: v11.unavailableCause, v11Confidence: v11.confidence, raceShare: i.raceShare, recentShare: i.recentShare,
    independentObservations: i.independentObservations, latestRaceAgeDays: i.latestRaceAgeDays, raceDominance: i.raceDominance, displacementSeconds: i.displacementSeconds,
    physiologyAdjustmentSeconds: i.physiologyAdjustmentSeconds, enduranceAdjustmentSeconds: i.enduranceAdjustmentSeconds, segmentsQualified: v11.qualification.segments.qualified,
    flags: v11.flags, conflicts: v11.conflicts.map(c => c.id), leakageExcluded: t.excluded };
}

export interface V11ReplaySummary {
  instants: number;
  availability: { v1: number; v11: number };
  v11Status: Record<string, number>; v11Causes: Record<string, number>;
  dayToDay: { maxStepSeconds: number; meanStepSeconds: number; maxStepFraction: number } | null;
  v1DayToDay: { maxStepSeconds: number; meanStepSeconds: number } | null;
  differencesVsV1: { n: number; meanSeconds: number | null; maxAbsSeconds: number | null; v11FasterShare: number | null };
  raceShare: { first: number | null; last: number | null; min: number | null; max: number | null };
  rows: VersionRow[];
}
const steps = (s: (number | null)[]) => s.slice(1).flatMap((x, i) => x !== null && s[i] !== null ? [Math.abs(x - s[i]!)] : []);

export function replayV11(input: Input, instants: readonly string[], extra: V11Extra = {}): V11ReplaySummary {
  const rows = instants.map(i => compareVersionsAsOf(input, i, extra));
  const v11 = rows.map(r => r.hybridV11Seconds), v1 = rows.map(r => r.hybridV1Seconds);
  const st = steps(v11), s1 = steps(v1);
  const count = (k: (r: VersionRow) => string | null) => rows.reduce<Record<string, number>>((a, r) => { const v = k(r); return v ? { ...a, [v]: (a[v] ?? 0) + 1 } : a; }, {});
  const diffs = rows.flatMap(r => r.hybridV11Seconds !== null && r.hybridV1Seconds !== null ? [r.hybridV11Seconds - r.hybridV1Seconds] : []);
  const shares = rows.filter(r => r.hybridV11Seconds !== null).map(r => r.raceShare);
  const ref = v11.find((s): s is number => s !== null) ?? 7870;
  return { instants: rows.length, availability: { v1: v1.filter(x => x !== null).length, v11: v11.filter(x => x !== null).length },
    v11Status: count(r => r.v11Status), v11Causes: count(r => r.v11Cause),
    dayToDay: st.length ? { maxStepSeconds: Math.max(...st), meanStepSeconds: st.reduce((a, b) => a + b, 0) / st.length, maxStepFraction: Math.max(...st) / ref } : null,
    v1DayToDay: s1.length ? { maxStepSeconds: Math.max(...s1), meanStepSeconds: s1.reduce((a, b) => a + b, 0) / s1.length } : null,
    differencesVsV1: { n: diffs.length, meanSeconds: diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null, maxAbsSeconds: diffs.length ? Math.max(...diffs.map(Math.abs)) : null,
      v11FasterShare: diffs.length ? diffs.filter(d => d < 0).length / diffs.length : null },
    raceShare: { first: shares[0] ?? null, last: shares.at(-1) ?? null, min: shares.length ? Math.min(...shares) : null, max: shares.length ? Math.max(...shares) : null }, rows };
}

/** Leave-one-run-out over recent runs and over each independent evidence item (workout identifiers are used internally, never returned). */
export function leaveOneOutV11(input: Input, extra: V11Extra = {}, recentDays = 56) {
  const opts = { vo2Entries: extra.vo2Entries, streamSummaries: extra.streamSummaries };
  const full = estimateHybridHalfMarathonV11(input, opts);
  const cutoff = Date.parse(performanceLocalDate(input.asOf, input.timeZone) + "T00:00:00Z") - recentDays * 86_400_000;
  const raceRuns = new Set(input.races.flatMap(r => r.actualRunId ? [r.actualRunId] : []));
  const evidenceIds = new Set(full.qualification.independent.flatMap(i => i.workoutId ? [i.workoutId] : []));
  const ids = input.workouts.filter((w: HealthWorkout) => w.isRunLike && !raceRuns.has(w.workoutId) && (w.startDate.getTime() >= cutoff || evidenceIds.has(w.workoutId))).map(w => w.workoutId);
  const shifts: number[] = [];
  let flips = 0, maxEvidence = 0;
  for (const id of ids) {
    const h = estimateHybridHalfMarathonV11({ ...input, workouts: input.workouts.filter(w => w.workoutId !== id) }, opts);
    if ((h.seconds === null) !== (full.seconds === null)) { flips++; continue; }
    if (h.seconds !== null && full.seconds !== null) { const s = Math.abs(h.seconds - full.seconds); shifts.push(s); if (evidenceIds.has(id)) maxEvidence = Math.max(maxEvidence, s); }
  }
  shifts.sort((a, b) => a - b);
  const max = shifts.at(-1) ?? 0;
  return { runsTested: ids.length, maxAbsShiftSeconds: max, p90AbsShiftSeconds: shifts.length ? shifts[Math.floor(0.9 * (shifts.length - 1))] : null,
    maxEvidenceItemShiftSeconds: maxEvidence, availabilityFlips: flips, maxShiftFraction: full.seconds ? max / full.seconds : null };
}

/** Leave-one-calendar-week-out over the last `weeks` weeks. */
export function leaveOneWeekOutV11(input: Input, extra: V11Extra = {}, weeks = 8) {
  const opts = { vo2Entries: extra.vo2Entries, streamSummaries: extra.streamSummaries };
  const full = estimateHybridHalfMarathonV11(input, opts);
  const end = Date.parse(performanceLocalDate(input.asOf, input.timeZone) + "T00:00:00Z");
  const shifts: number[] = []; let flips = 0;
  for (let k = 0; k < weeks; k++) {
    const hi = end - k * 7 * 86_400_000, lo = hi - 7 * 86_400_000;
    const h = estimateHybridHalfMarathonV11({ ...input, workouts: input.workouts.filter(w => !(w.startDate.getTime() >= lo && w.startDate.getTime() < hi)) }, opts);
    if ((h.seconds === null) !== (full.seconds === null)) { flips++; continue; }
    if (h.seconds !== null && full.seconds !== null) shifts.push(Math.abs(h.seconds - full.seconds));
  }
  return { weeksTested: weeks, maxAbsShiftSeconds: shifts.length ? Math.max(...shifts) : 0, availabilityFlips: flips, maxShiftFraction: full.seconds && shifts.length ? Math.max(...shifts) / full.seconds : null };
}

/** Assumption sweeps: how much does each defensible assumption move the primary estimate (seconds relative to the policy result)? */
export function sweepsV11(input: Input, extra: V11Extra = {}) {
  const opts = { vo2Entries: extra.vo2Entries, streamSummaries: extra.streamSummaries };
  const base = estimateHybridHalfMarathonV11(input, opts);
  const delta = (o: Partial<HybridV11Options>) => { const e = estimateHybridHalfMarathonV11(input, { ...opts, ...o }); return e.seconds === null || base.seconds === null ? null : e.seconds - base.seconds; };
  const stripWeather = { ...input, workouts: input.workouts.map(w => ({ ...w, weather: null })) };
  const noWx = estimateHybridHalfMarathonV11(stripWeather, opts);
  const readiness = [0.3, 0.5, 0.7, 0.9].map(r => ({ readiness: r, deltaSeconds: delta({ readinessOverride: r }) }));
  return {
    commonModeEfforts: { halved: delta({ combinationParams: { commonModeRecent: 0.0075 } }), doubled: delta({ combinationParams: { commonModeRecent: 0.03 } }) },
    commonModeRace: { halved: delta({ combinationParams: { commonModeRace: 0.005 } }), doubled: delta({ combinationParams: { commonModeRace: 0.02 } }) },
    ageDrift: { half: delta({ combinationParams: { driftPerSqrtMonth: 0.005 } }), double: delta({ combinationParams: { driftPerSqrtMonth: 0.02 } }) },
    measurementUncertainty: { minus25pct: delta({ combinationParams: { measurementScale: 0.75 } }), plus25pct: delta({ combinationParams: { measurementScale: 1.25 } }) },
    withoutSustainedSegments: delta({ combinationParams: { excludeKinds: ["sustained_segment"] } }),
    racesOnly: delta({ combinationParams: { excludeKinds: ["whole_run_effort", "sustained_segment", "labelled_race_run"] } }),
    vo2SourceAvailability: { withoutVo2DeltaSeconds: (() => { const e = estimateHybridHalfMarathonV11(input, { ...opts, vo2Entries: undefined }); return e.seconds === null || base.seconds === null ? null : e.seconds - base.seconds; })() },
    streamHrVersusAverageHr: (() => { const e = estimateHybridHalfMarathonV11(input, { ...opts, streamSummaries: undefined }); return { deltaSeconds: e.seconds === null || base.seconds === null ? null : base.seconds - e.seconds,
      trendSlopePctPer28dWithStreams: base.physiology?.slopePer28d == null ? null : base.physiology.slopePer28d * 100, trendSlopePctPer28dWithout: e.physiology?.slopePer28d == null ? null : e.physiology.slopePer28d * 100 }; })(),
    weatherMissingness: { available: noWx.seconds !== null, deltaSeconds: noWx.seconds !== null && base.seconds !== null ? noWx.seconds - base.seconds : null, flags: noWx.physiology?.flags ?? [] },
    forecastReadinessResponse: readiness,
  };
}
