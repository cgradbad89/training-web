/**
 * Phase 3U — performance-evidence-v1.1: sustained-segment evidence on top of the UNCHANGED v1 qualification.
 *
 * v1 admits only whole-workout efforts (and races) as numerical evidence. A continuous tempo, a progression run, a fast
 * finish or a hard 10 K inside a longer run is therefore invisible: its pace is diluted by the warm-up/easy miles, a
 * `tempo`/`interval` label demotes the whole workout to "ordinary", and the GPS best-effort envelope is descriptive only.
 * That is the main reason a single old race keeps 100 % of the demonstrated-performance base: nothing newer can qualify.
 *
 * v1.1 adds ONE intermediate category, `sustained_segment` — a strong but SUBMAXIMAL lower bound on capability:
 *  - the segment is the host run's best 5 K / 10 K / 10 mi / half (valid, current-version, complete-route GPS);
 *  - it is a portion of the run (< 92 % of its distance; whole-run efforts are handled by v1);
 *  - it is exceptional for THIS athlete (faster than their own trailing-year P10 of segment equivalents AND clearing a margin
 *    over their own median — percentiles alone select the noisy tail of ordinary running, as v1 found);
 *  - the host run's average HR is elevated over the athlete's own median (effort support; a fast segment with ordinary HR is
 *    more likely a downhill/GPS artifact or a fast but easy day);
 *  - not heat-inflated; the host passed the v1 integrity screens (timing, complete route, no owner distance correction).
 * One item per workout (the most reliably extrapolated qualifying distance) and one per local day. A fast segment is
 * never promoted to a maximal test: it enters the combination as a lower bound with its own (larger) uncertainty, and a
 * slower-than-estimate segment is ignored — a slow segment says nothing about capability.
 *
 * Every threshold is an engineering safeguard, not a published constant; none was fitted to any race outcome.
 */
import type { RacePerformanceInput } from "@/types/racePerformance";
import type { PerformanceEvidenceItem } from "@/types/hybridPerformance";
import type { EvidenceItemV11, EvidenceQualificationV11 } from "@/types/hybridPerformanceV11";
import { BEST_EFFORTS_COMPUTATION_VERSION } from "@/utils/fastestMileSegment";
import { performanceLocalDate, shiftPerformanceDate } from "@/utils/performanceEvidence";
import { HALF_MARATHON_METERS, researchRiegelSeconds } from "@/utils/racePerformance";
import { selectResearchRuns } from "@/utils/workoutRaceResearch";
import { CURVE_DISTANCES_M, EVIDENCE_POLICY, quantile, qualifyPerformanceEvidence, timingConsistent, type QualificationOptions } from "./evidenceQualification";

export const SEGMENT_POLICY = Object.freeze({
  version: "performance-evidence-v1.1" as const,
  keys: ["10mi", "half", "10k", "5k"] as const,
  /** Segment must be a PORTION of the run. */
  maximumHostShare: 0.92,
  referenceMinimumRuns: 20,
  speedPercentile: 0.1, speedMargin: 0.05,
  hrSupportBpm: 5,
  maximumHostDistanceMiles: 26.3,
  minimumSegmentSeconds: 8 * 60,
});

type Input = Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">;
type SegmentKey = (typeof SEGMENT_POLICY.keys)[number];
const MILE = 1609.344;
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const indoorLabel = (s: string) => /treadmill|indoor/i.test(s);
const hm = (seconds: number, meters: number) => researchRiegelSeconds(seconds, meters, HALF_MARATHON_METERS);

const toV11 = (i: PerformanceEvidenceItem): EvidenceItemV11 => ({
  clusterId: i.clusterId, workoutId: i.workoutId, raceId: i.raceId, kind: i.kind, tier: i.tier, date: i.date, ageDays: i.ageDays,
  distanceMeters: i.distanceMeters, seconds: i.seconds, avgHeartRate: i.avgHeartRate, tempF: i.tempF,
  weatherMissing: i.kind !== "confirmed_race" && i.kind !== "recorded_race" && i.tempF === null, segment: null, reasons: i.reasons });

const isRace = (i: EvidenceItemV11) => i.kind === "confirmed_race" || i.kind === "recorded_race";
const rankOf = (i: EvidenceItemV11) => (isRace(i) ? 3 : i.kind === "whole_run_effort" || i.kind === "labelled_race_run" ? 2 : 1) * 1e9
  + (i.tier === "confirmed_maximal" ? 1e8 : 0) + i.distanceMeters;

export function qualifyEvidenceV11(input: Input, options: QualificationOptions = {}): EvidenceQualificationV11 {
  const P = SEGMENT_POLICY, E = EVIDENCE_POLICY;
  const base = qualifyPerformanceEvidence(input, options);
  const asOfDate = performanceLocalDate(input.asOf, input.timeZone);
  const overrides = input.overrides ?? {};
  const { runs } = selectResearchRuns({ ...input, overrides, capturedAt: input.asOf, source: "owner_parent_export",
    complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
  const raceWorkoutIds = new Set(input.races.flatMap(r => r.actualRunId ? [r.actualRunId] : []));
  const wholeRunClusters = new Set(base.all.map(i => i.clusterId));
  const informativeExcluded: Record<string, number> = {};
  const note = (reason: string) => { informativeExcluded[reason] = (informativeExcluded[reason] ?? 0) + 1; };

  // Athlete-relative references (trailing year; the athlete's own distribution, never settings-derived).
  const refStart = shiftPerformanceDate(asOfDate, -E.referenceDays);
  const usable = (r: (typeof runs)[number]) => {
    const w = r.workout, be = w.bestEfforts;
    return !raceWorkoutIds.has(w.workoutId) && r.date >= refStart && r.date <= asOfDate && !!be
      && be.computedFromRouteComplete === true && be.computationVersion === BEST_EFFORTS_COMPUTATION_VERSION && w.hasRoute && w.routeComplete !== false;
  };
  const refHr = runs.filter(r => !raceWorkoutIds.has(r.workout.workoutId) && r.date >= refStart && r.date <= asOfDate && r.workout.hasRoute
      && !indoorLabel(r.workout.displayType ?? "") && positive(r.workout.avgHeartRate) && r.workout.avgHeartRate >= E.validHrMin && r.workout.avgHeartRate <= E.validHrMax
      && r.workout.durationSeconds >= E.referenceMinimumDurationSeconds && r.workout.durationSeconds <= E.referenceMaximumDurationSeconds)
    .map(r => r.workout.avgHeartRate!);
  const hrMedian = refHr.length >= E.referenceMinimumRuns ? quantile(refHr, 0.5) : null;
  const eqOf = (r: (typeof runs)[number], key: SegmentKey): number | null => {
    const sec = r.workout.bestEfforts?.[key], meters = CURVE_DISTANCES_M[key], miles = meters / MILE;
    if (!positive(sec) || sec < miles * E.minimumPaceSecondsPerMile || sec > miles * 1200) return null;
    return hm(sec, meters);
  };
  const referenceRuns: Record<string, number> = {};
  const threshold: Partial<Record<SegmentKey, number>> = {};
  for (const key of P.keys) {
    const eqs = runs.filter(usable).flatMap(r => { const e = eqOf(r, key); return e === null ? [] : [e]; });
    referenceRuns[key] = eqs.length;
    if (eqs.length >= P.referenceMinimumRuns) {
      const p10 = quantile(eqs, P.speedPercentile)!, med = quantile(eqs, 0.5)!;
      threshold[key] = Math.min(p10, med * (1 - P.speedMargin));
    }
  }

  const segments: EvidenceItemV11[] = [];
  let candidates = 0;
  for (const r of runs) {
    const w = r.workout, id = w.workoutId;
    if (!usable(r) || wholeRunClusters.has(id)) continue;
    // The most reliably extrapolated qualifying distance first (longest key), at most one segment per workout.
    const seg = P.keys.map(key => ({ key, eq: eqOf(r, key), meters: CURVE_DISTANCES_M[key], sec: w.bestEfforts?.[key] as number | null | undefined }))
      .filter(s => s.eq !== null && positive(s.sec) && s.sec >= P.minimumSegmentSeconds && threshold[s.key] !== undefined && s.eq! <= threshold[s.key]!
        && s.meters <= w.distanceMiles * MILE * P.maximumHostShare)
      .sort((a, b) => b.meters - a.meters)[0];
    if (!seg) continue;
    candidates++;
    const age = dayDiff(r.date, asOfDate);
    if (r.paceSecondsPerMile < E.minimumPaceSecondsPerMile || r.paceSecondsPerMile > E.maximumPaceSecondsPerMile || w.distanceMiles > P.maximumHostDistanceMiles) { note("fast_segment_host_implausible"); continue; }
    if (!timingConsistent(w)) { note("fast_segment_host_timing_discrepancy"); continue; }
    const ov = overrides[id];
    if (ov && (ov.distanceMilesOverride != null || ov.durationSecondsOverride != null)) { note("fast_segment_host_owner_corrected"); continue; }
    if (indoorLabel(w.displayType ?? "")) { note("fast_segment_host_indoor"); continue; }
    if (hrMedian === null) { note("fast_segment_no_athlete_hr_reference"); continue; }
    if (!positive(w.avgHeartRate) || w.avgHeartRate < E.validHrMin || w.avgHeartRate > E.validHrMax) { note("fast_segment_host_missing_hr"); continue; }
    if (w.avgHeartRate < hrMedian + P.hrSupportBpm) { note("fast_segment_not_hr_supported"); continue; }
    const tempF = w.weather?.tempF ?? null;
    if (tempF !== null && tempF > E.heatExcludedF) { note("fast_segment_heat_inflated_hr"); continue; }
    if (age > E.maximumAgeDays) { note("fast_segment_expired"); continue; }
    segments.push({ clusterId: id, workoutId: id, raceId: null, kind: "sustained_segment", tier: "strong_unconfirmed", date: r.date, ageDays: age,
      distanceMeters: seg.meters, seconds: seg.sec as number, avgHeartRate: w.avgHeartRate, tempF, weatherMissing: tempF === null,
      segment: { key: seg.key, hostDistanceMeters: w.distanceMiles * MILE, hostSeconds: w.durationSeconds, hostHrAboveMedianBpm: w.avgHeartRate - hrMedian },
      reasons: ["sustained_segment_in_athlete_top_range", ...(tempF === null ? ["weather_missing"] : [])] });
  }

  // Independence: one item per cluster (by construction) and one per local day; races > whole-run efforts > segments.
  const byDate = new Map<string, EvidenceItemV11>();
  const dup = (reason: string) => { informativeExcluded[reason] = (informativeExcluded[reason] ?? 0) + 1; };
  for (const item of [...base.independent.map(toV11), ...segments]) {
    const kept = byDate.get(item.date);
    if (!kept) byDate.set(item.date, item);
    else if (rankOf(item) > rankOf(kept)) { if (kept.kind === "sustained_segment") dup("same_day_duplicate_segment"); byDate.set(item.date, item); }
    else if (item.kind === "sustained_segment") dup("same_day_duplicate_segment");
  }
  const independent = [...byDate.values()].sort((a, b) => a.ageDays - b.ageDays || a.clusterId.localeCompare(b.clusterId));
  return { version: P.version, asOf: input.asOf, asOfDate, independent, base,
    segments: { candidates, qualified: segments.length, referenceRuns }, informativeExcluded };
}
