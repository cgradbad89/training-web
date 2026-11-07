import { describe, expect, it } from "vitest";
import type { HrSample, HrStreamSummary } from "@/types/hybridPerformance";
import type { HealthWorkout } from "@/types/healthWorkout";
import { selectResearchRuns } from "@/utils/workoutRaceResearch";
import { computeAerobicTrend } from "../aerobicTrend";
import { summarizeHrStream } from "../hrStreamQuality";
import { isTrendEligibleRun, selectStreamCandidates } from "../hrStreamSelection";
import { estimateHybridHalfMarathon } from "../hybridPerformance";
import { estimateHybridHalfMarathonV11 } from "../hybridPerformanceV11";
import { athleteV11 } from "../../__tests__/fixtures/hybridV11Fixture";
import { makeRun } from "../../__tests__/fixtures/hybridFixture";

const jit = (i: number) => (((i * 7919) % 13) - 6) / 6;
/** Pace depends on heart rate (−0.6 % per bpm) so that a heart-rate bias CAN masquerade as a fitness change. */
function physiologicalAthlete(o: { streamed?: (w: HealthWorkout, i: number) => boolean } = {}) {
  const a = athleteV11({ raceDate: "2026-09-20", envelope: false });
  let i = 0;
  const workouts = a.workouts.map(w => {
    if (!w.workoutId.startsWith("ord-")) return w;
    const hr = 146 + Math.round(6 * jit(i++ + 5)), pace = 620 * Math.exp(-0.006 * (hr - 146));
    return { ...w, avgHeartRate: hr, avgPaceSecPerMile: pace, distanceMiles: w.durationSeconds / pace, distanceMeters: w.durationSeconds / pace * 1609.344, hasHRStream: o.streamed ? o.streamed(w, i) : undefined };
  });
  return { ...a, workouts };
}
const summary = (parentHr: number, delta: number, extra: Partial<HrStreamSummary> = {}): HrStreamSummary => ({
  version: "hr-stream-quality-v1", quality: "good", flags: [], samples: 1500, medianGapSeconds: 1, coverageFraction: 1, warmupSeconds: 240,
  trimmedAvgHr: parentHr + delta, rawAvgHr: parentHr, stableSegmentSeconds: 1500, postWarmupSlopeBpmPer10Min: 0, intervalLike: false, ...extra });
const trendOf = (a: ReturnType<typeof physiologicalAthlete>, streams?: Record<string, HrStreamSummary>) => {
  const e = estimateHybridHalfMarathonV11(a, { streamSummaries: streams, streamLoad: streams ? "loaded" : "not_requested" });
  return e.physiology!;
};

describe("trimmed HR on a time-correlated SUBSET of runs must not create a trend", () => {
  const a = physiologicalAthlete();
  const recentHalf = Object.fromEntries(a.workouts.filter(w => w.workoutId.startsWith("ord-") && w.startDate >= new Date("2026-09-15T00:00:00Z"))
    .map(w => [w.workoutId, summary(w.avgHeartRate!, 3)]));
  it("v1's policy (mixed trimmed/untrimmed) reads the trimming offset as a fitness improvement; the calibrated policy does not", () => {
    const none = trendOf(a).slopePer28d!;
    const v1 = estimateHybridHalfMarathon(a, { streamSummaries: recentHalf }).physiology!.slopePer28d!;
    const cal = trendOf(a, recentHalf);
    expect(Math.abs(v1 - none)).toBeGreaterThan(0.004);                        // the bias exists…
    expect(Math.abs(cal.slopePer28d! - none)).toBeLessThan(0.0015);            // …and the calibration removes it
    expect(cal.hrSource).toBe("stream_trimmed_mixed"); expect(cal.streams!.calibrationOffsetBpm).toBeCloseTo(3, 6);
  });
  it("without enough streamed runs no offset is applied and the disclosure says so", () => {
    const few = Object.fromEntries(Object.entries(recentHalf).slice(0, 3));
    const t = trendOf(a, few);
    expect(t.streams!.calibrationOffsetBpm).toBeNull(); expect(t.streams!.used).toBe(3);
  });
});

describe("stream quality classification feeds the steady-state trend", () => {
  const a = physiologicalAthlete();
  const ords = a.workouts.filter(w => w.workoutId.startsWith("ord-") && w.startDate >= new Date("2026-07-20T00:00:00Z"));
  it("interval-like streams are removed from the steady-state regression and counted; v1's policy leaves them in", () => {
    const flagged = Object.fromEntries(ords.slice(0, 4).map(w => [w.workoutId, summary(w.avgHeartRate!, 0, { quality: "limited", intervalLike: true, flags: ["interval_like_structure"], postWarmupSlopeBpmPer10Min: null })]));
    const base = trendOf(a), cal = trendOf(a, flagged);
    expect(cal.streams!.excludedIntervalLike).toBe(4); expect(cal.runs).toBe(base.runs - 4);
    expect(estimateHybridHalfMarathon(a, { streamSummaries: flagged }).physiology!.runs).toBe(base.runs);
  });
  it("an unusable stream is ignored: the run keeps its whole-workout heart rate and is not excluded", () => {
    const bad = Object.fromEntries(ords.slice(0, 4).map(w => [w.workoutId, { ...summary(w.avgHeartRate!, 0), quality: "unusable" as const, trimmedAvgHr: null }]));
    const t = trendOf(a, bad);
    expect(t.runs).toBe(trendOf(a).runs); expect(t.streams!.used).toBe(0); expect(t.hrSource).toBe("parent_average");
  });
  it("real synthetic streams: a warm-up ramp is trimmed, an interval structure is flagged", () => {
    const steady: HrSample[] = Array.from({ length: 2400 }, (_, t) => ({ t, bpm: Math.round(t < 300 ? 100 + 50 * t / 300 : 150 + ((t * 7919) % 5) - 2) }));
    const intervals: HrSample[] = Array.from({ length: 2400 }, (_, t) => ({ t, bpm: t < 300 ? 110 + t / 10 : Math.floor((t - 300) / 60) % 2 ? 176 : 128 }));
    const s = summarizeHrStream(steady), i = summarizeHrStream(intervals);
    expect(s.trimmedAvgHr!).toBeGreaterThan(s.rawAvgHr! + 1.5); expect(s.intervalLike).toBe(false);
    expect(i.intervalLike).toBe(true);
  });
});

describe("candidate selection reads only streams that can influence the trend", () => {
  const a = physiologicalAthlete({ streamed: () => true });
  const input = (asOf = a.asOf) => {
    const { runs } = selectResearchRuns({ ...a, asOf, capturedAt: asOf, source: "owner_parent_export", complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
    return { runs, raceWorkoutIds: new Set(a.races.flatMap(r => r.actualRunId ? [r.actualRunId] : [])), asOfDate: asOf.slice(0, 10) };
  };
  it("caps the count and spreads the picks evenly over the window (not just the newest runs)", () => {
    const s = selectStreamCandidates(input());
    expect(s.eligible).toBeGreaterThan(16); expect(s.candidates).toHaveLength(16);
    const dates = s.candidates.map(c => c.date);
    expect([...dates].sort()).toEqual(dates);
    expect(dates[0] < dates.at(-1)!).toBe(true);
    const span = Date.parse(dates.at(-1)!) - Date.parse(dates[0]);
    expect(span).toBeGreaterThan(80 * 86_400_000);                              // covers most of the 112-day window
    const gaps = dates.slice(1).map((d, i) => Date.parse(d) - Date.parse(dates[i]));
    expect(Math.max(...gaps)).toBeLessThan(span / 4);
  });
  it("is deterministic and picks nothing for runs without a recorded stream", () => {
    expect(selectStreamCandidates(input())).toEqual(selectStreamCandidates(input()));
    const none = physiologicalAthlete({ streamed: () => false });
    const { runs } = selectResearchRuns({ ...none, capturedAt: none.asOf, source: "owner_parent_export", complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
    expect(selectStreamCandidates({ runs, raceWorkoutIds: new Set(), asOfDate: "2026-11-07" }).candidates).toEqual([]);
  });
  it("never selects races, structured sessions, treadmill runs, short/long runs, or runs outside the 112-day window", () => {
    const extra: HealthWorkout[] = [
      { ...makeRun({ id: "tempo", date: "2026-10-20", pace: 540, hr: 170, minutes: 45, type: "Tempo Run" }), hasHRStream: true },
      { ...makeRun({ id: "tread", date: "2026-10-21", pace: 600, hr: 150, minutes: 45, type: "Treadmill Run" }), hasHRStream: true },
      { ...makeRun({ id: "short", date: "2026-10-22", pace: 600, hr: 150, minutes: 12 }), hasHRStream: true },
      { ...makeRun({ id: "long", date: "2026-10-23", pace: 600, hr: 150, minutes: 150 }), hasHRStream: true },
      { ...makeRun({ id: "old", date: "2026-05-01", pace: 600, hr: 150, minutes: 45 }), hasHRStream: true },
    ];
    const b = { ...a, workouts: [...a.workouts, ...extra] };
    const { runs } = selectResearchRuns({ ...b, capturedAt: b.asOf, source: "owner_parent_export", complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
    const s = selectStreamCandidates({ runs, raceWorkoutIds: new Set(b.races.flatMap(r => r.actualRunId ? [r.actualRunId] : [])), asOfDate: "2026-11-07", maxRuns: 500 });
    const ids = new Set(s.candidates.map(c => c.workoutId));
    for (const id of ["tempo", "tread", "short", "long", "old"]) expect(ids.has(id)).toBe(false);
    expect(ids.has(a.raceWorkoutId!)).toBe(false);
  });
  it("selection eligibility agrees with the trend's own filter: every run the trend uses is a candidate-eligible run", () => {
    const { runs, raceWorkoutIds } = input();
    const t = trendOf(a);
    const eligible = runs.filter(r => isTrendEligibleRun(r, raceWorkoutIds, "2026-07-18", "2026-11-06")).length;
    expect(eligible).toBeGreaterThanOrEqual(t.runs);
    expect(selectStreamCandidates({ runs, raceWorkoutIds, asOfDate: "2026-11-07", maxRuns: 500 }).candidates.length).toBe(eligible);
  });
  it("a corrected workout record changes its cache key so it is re-hydrated, not served stale", () => {
    const base = selectStreamCandidates(input()).candidates[0];
    const changed = { ...a, workouts: a.workouts.map(w => w.workoutId === base.workoutId ? { ...w, updatedAt: new Date("2026-11-01T00:00:00Z") } : w) };
    const { runs } = selectResearchRuns({ ...changed, capturedAt: changed.asOf, source: "owner_parent_export", complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
    const after = selectStreamCandidates({ runs, raceWorkoutIds: new Set(), asOfDate: "2026-11-07", maxRuns: 500 }).candidates.find(c => c.workoutId === base.workoutId);
    if (after) expect(after.cacheKey).not.toBe(base.cacheKey);
  });
});

describe("the v1 default stream policy is unchanged", () => {
  it("computeAerobicTrend without a policy behaves exactly as v1 did (no streams field, same HR source rule)", () => {
    const a = physiologicalAthlete();
    const { runs } = selectResearchRuns({ ...a, capturedAt: a.asOf, source: "owner_parent_export", complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
    const t = computeAerobicTrend({ runs, raceWorkoutIds: new Set(), asOf: a.asOf, asOfDate: "2026-11-07" });
    expect(t.streams).toBeUndefined(); expect(t.hrSource).toBe("parent_average");
  });
});
