/**
 * Which heart-rate streams are worth reading? Only those that can influence the physiological model.
 *
 * The aerobic trend (`computeAerobicTrend`) regresses pace on heart rate over the last 112 days using steady, outdoor,
 * route-bearing runs of 20–120 minutes that are not races or hard-labelled sessions. A stream for any other workout can
 * never change the result, so it is never fetched. Of the eligible runs that have a recorded stream (`hasHRStream`), at most
 * `maxRuns` are chosen EVENLY across the window (deterministic stratified selection by date): selecting only the newest runs
 * would pair trimmed HR with recent runs and untrimmed HR with old ones — a time-correlated bias the trend would read as
 * a fitness change. The remaining runs are offset-calibrated in `computeAerobicTrend` ("calibrated" stream policy).
 *
 * Pure and deterministic; no I/O.
 */
import type { ResearchRun } from "@/types/workoutRaceResearch";
import { shiftPerformanceDate } from "@/utils/performanceEvidence";
import { AEROBIC_TREND_POLICY } from "./aerobicTrend";

export const STREAM_SELECTION_POLICY = Object.freeze({ maxRuns: 16 });

export interface StreamCandidate {
  workoutId: string;
  date: string;
  durationSeconds: number;
  /** Changes whenever the parent workout record changes, so a corrected workout is re-hydrated rather than served stale. */
  cacheKey: string;
}

const hardLabel = (s: string) => /tempo|interval|race|fartlek|hill repeat/i.test(s);
const indoorLabel = (s: string) => /treadmill|indoor/i.test(s);

/** Mirrors the eligibility filter of `computeAerobicTrend` (a unit test asserts the two agree). */
export function isTrendEligibleRun(r: ResearchRun, raceWorkoutIds: ReadonlySet<string>, start: string, end: string): boolean {
  const P = AEROBIC_TREND_POLICY, w = r.workout;
  return r.date >= start && r.date <= end && !raceWorkoutIds.has(w.workoutId) && !hardLabel(w.displayType ?? "") && w.hasRoute && !indoorLabel(w.displayType ?? "")
    && w.durationSeconds >= P.minimumDurationSeconds && w.durationSeconds <= P.maximumDurationSeconds
    && r.paceSecondsPerMile >= P.minimumPaceSecondsPerMile && r.paceSecondsPerMile <= P.maximumPaceSecondsPerMile && w.distanceMiles <= P.maximumDistanceMiles
    && Number.isFinite(w.avgHeartRate) && w.avgHeartRate! >= P.validHrMin && w.avgHeartRate! <= P.validHrMax;
}

export function selectStreamCandidates(input: { runs: readonly ResearchRun[]; raceWorkoutIds: ReadonlySet<string>; asOfDate: string; maxRuns?: number }): { candidates: StreamCandidate[]; eligible: number; withStream: number } {
  const P = AEROBIC_TREND_POLICY, max = input.maxRuns ?? STREAM_SELECTION_POLICY.maxRuns;
  const end = shiftPerformanceDate(input.asOfDate, -1), start = shiftPerformanceDate(end, -(P.windowDays - 1));
  const eligible = input.runs.filter(r => isTrendEligibleRun(r, input.raceWorkoutIds, start, end));
  const withStream = eligible.filter(r => r.workout.hasHRStream === true)
    .sort((a, b) => a.date.localeCompare(b.date) || a.workout.workoutId.localeCompare(b.workout.workoutId));
  const picked = withStream.length <= max ? withStream
    : Array.from({ length: max }, (_, k) => withStream[Math.round(k * (withStream.length - 1) / (max - 1))]);
  const unique = [...new Map(picked.map(r => [r.workout.workoutId, r])).values()];
  return { eligible: eligible.length, withStream: withStream.length, candidates: unique.map(r => ({ workoutId: r.workout.workoutId, date: r.date,
    durationSeconds: r.workout.durationSeconds,
    cacheKey: `${r.workout.workoutId}:${r.workout.syncedAt.getTime()}:${r.workout.updatedAt?.getTime() ?? 0}:${Math.round(r.workout.durationSeconds)}` })) };
}
