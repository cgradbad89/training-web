import { describe, expect, it } from "vitest";
import { summarizeHrStream } from "../hrStreamQuality";
import { assessVo2, computeAerobicTrend } from "../aerobicTrend";
import type { HrSample, HrStreamSummary } from "@/types/hybridPerformance";
import type { ResearchRun } from "@/types/workoutRaceResearch";
import { addDays, makeRun, type RunSpec } from "../../__tests__/fixtures/hrEnhancedFixture";

// ── HR streams ───────────────────────────────────────────────────────────────
const stream = (seconds: number, f: (t: number) => number, step = 1): HrSample[] =>
  Array.from({ length: Math.floor(seconds / step) }, (_, i) => ({ t: i * step, bpm: Math.round(f(i * step)) }));
const steady = (t: number) => (t < 480 ? 100 + 50 * (t / 480) : 150 + 1.5 * Math.sin(t / 40));

describe("HR stream quality (3R.1)", () => {
  it("trims the warm-up: the trimmed mean sits near the steady level and above the raw mean", () => {
    const s = summarizeHrStream(stream(3600, steady));
    expect(s.quality).toBe("good");
    expect(s.warmupSeconds!).toBeGreaterThanOrEqual(120); expect(s.warmupSeconds!).toBeLessThanOrEqual(720);
    expect(s.trimmedAvgHr!).toBeGreaterThan(s.rawAvgHr!);
    expect(s.trimmedAvgHr!).toBeGreaterThan(146); expect(s.trimmedAvgHr!).toBeLessThan(152);
    expect(s.stableSegmentSeconds).toBeGreaterThan(1800); expect(s.intervalLike).toBe(false);
  });
  it("reports the post-warm-up HR slope of a rising stream (bpm per 10 minutes)", () => {
    const s = summarizeHrStream(stream(3000, t => (t < 400 ? 100 + 45 * t / 400 : 145 + 8 * (t - 400) / 2600)));
    expect(s.postWarmupSlopeBpmPer10Min!).toBeGreaterThan(1); expect(s.postWarmupSlopeBpmPer10Min!).toBeLessThan(2);
  });
  it("removes invalid samples and isolated spikes", () => {
    const raw = stream(2400, steady);
    raw[900] = { t: 900, bpm: 250 }; raw[1200] = { t: 1200, bpm: 20 }; raw[1500] = { t: 1500, bpm: 215 }; raw[1501] = { t: 1501, bpm: Number.NaN };
    const s = summarizeHrStream(raw);
    expect(s.flags).toContain("invalid_samples_removed"); expect(s.flags).toContain("spikes_removed");
    expect(s.trimmedAvgHr!).toBeLessThan(153);
  });
  it("refuses sparse, gappy, too-short or empty streams instead of guessing", () => {
    expect(summarizeHrStream(stream(3600, steady, 90)).quality).toBe("unusable");
    expect(summarizeHrStream([]).quality).toBe("unusable");
    expect(summarizeHrStream(stream(100, steady)).flags).toContain("too_few_samples");
    expect(summarizeHrStream(stream(200, steady)).flags).toContain("stream_too_short");
    const gappy = stream(3600, steady).filter(s => s.t < 600 || s.t > 2400);
    const g = summarizeHrStream(gappy);
    expect(g.flags).toContain("sampling_gaps"); expect(["limited", "unusable"]).toContain(g.quality);
  });
  it("flags interval-like workouts and withholds a drift slope for them", () => {
    const s = summarizeHrStream(stream(3000, t => (t < 400 ? 110 : (Math.floor((t - 400) / 180) % 2 ? 130 : 172))));
    expect(s.intervalLike).toBe(true); expect(s.quality).toBe("limited"); expect(s.postWarmupSlopeBpmPer10Min).toBeNull();
  });
});

// ── VO₂ corroboration ────────────────────────────────────────────────────────
// A gradual ramp (a real trend has no single large step between consecutive readings).
const vo2 = (recent: number, prior: number, asOf = "2026-11-07") => [51, 45, 39, 33, 21, 15, 9, 3]
  .map((d, i) => ({ date: addDays(asOf, -d), value: prior + (recent - prior) * (i / 7) * 1.5 - (recent - prior) * 0.25 }));

describe("VO₂ corroboration is descriptive only", () => {
  it("reads direction from two 28-day medians and needs enough readings", () => {
    expect(assessVo2(vo2(47, 45), "2026-11-07").direction).toBe("improving");
    expect(assessVo2(vo2(44, 46), "2026-11-07").direction).toBe("declining");
    expect(assessVo2(vo2(45.4, 45), "2026-11-07").direction).toBe("inconclusive");
    expect(assessVo2(undefined, "2026-11-07").direction).toBe("unavailable");
    expect(assessVo2(vo2(47, 45).slice(0, 5), "2026-11-07").direction).toBe("unavailable");
  });
  it("a device discontinuity makes the direction inconclusive and later readings cannot leak", () => {
    const withJump = [...vo2(47, 45), { date: "2026-10-20", value: 40 }];
    expect(assessVo2(withJump, "2026-11-07").direction).toBe("inconclusive");
    expect(assessVo2([...vo2(47, 45), { date: "2026-11-20", value: 10.5 }], "2026-11-07").readings).toBe(8);
  });
});

// ── Aerobic trend ───────────────────────────────────────────────────────────
const AS_OF = "2026-11-07T17:00:00.000Z", AS_OF_DATE = "2026-11-07";
interface TrendOpts { g?: number; noise?: number; hrDrift?: number; tempTrend?: number | null; tempEffect?: number; n?: number; mutate?: (s: RunSpec, i: number) => RunSpec; withWeather?: boolean }
function trendRuns(o: TrendOpts = {}): ResearchRun[] {
  const n = o.n ?? 36, g = o.g ?? 0, noise = o.noise ?? 0.008;
  const out: ResearchRun[] = [];
  for (let i = 0; i < n; i++) {
    const date = addDays("2026-07-18", Math.floor(i * 111 / (n - 1)));
    const t = (Date.parse(date) - Date.parse("2026-11-06")) / 86_400_000 / 28;
    const hr = 148 + Math.round(6 * (((i * 7919) % 13) - 6) / 6) + (o.hrDrift ?? 0) * (i / n);
    const temp = o.tempTrend === null ? null : 55 + (o.tempTrend ?? 0) * (i / n) + (((i * 31) % 7) - 3);
    const pace = 600 * Math.exp(-0.006 * (hr - 148)) * Math.exp(g * t) * Math.exp((o.tempEffect ?? 0) * ((temp ?? 55) - 55)) * (1 + noise * (((i * 104729) % 11) - 5) / 5);
    let spec: RunSpec = { id: `t${i}`, date, pace, hr, minutes: 40 + (i % 4) * 5, tempF: o.withWeather === false ? null : temp, climbPerMile: 8 + (i % 5) };
    if (o.mutate) spec = o.mutate(spec, i);
    const w = makeRun(spec);
    out.push({ workout: w, date, paceSecondsPerMile: w.durationSeconds / w.distanceMiles, recordedType: spec.type ?? "Run" });
  }
  return out;
}
const run = (runs: ResearchRun[], extra: Partial<Parameters<typeof computeAerobicTrend>[0]> = {}) =>
  computeAerobicTrend({ runs, raceWorkoutIds: new Set(), asOf: AS_OF, asOfDate: AS_OF_DATE, ...extra });

describe("aerobic efficiency trend (3R.3)", () => {
  it("recovers a genuine multiweek improvement and labels it as an observation, not a race-time change", () => {
    const r = run(trendRuns({ g: -0.02 }));
    expect(r.status).toBe("available"); expect(r.classification).toBe("observed_improvement");
    expect(r.slopePer28d!).toBeGreaterThan(-0.03); expect(r.slopePer28d!).toBeLessThan(-0.012);
    expect(r.interpretation.observed[0]).toMatch(/became faster/);
    expect(r.interpretation.notSupported.join(" ")).toMatch(/race-time change/);
    expect(r.interpretation.notSupported.join(" ")).toMatch(/VO₂/);
  });
  it("reports a decline and no change appropriately", () => {
    expect(run(trendRuns({ g: 0.02 })).classification).toBe("observed_decline");
    expect(run(trendRuns({ g: 0 })).classification).toBe("no_detectable_change");
  });
  it("does not mistake a faster pace caused only by a higher heart rate for improvement", () => {
    const r = run(trendRuns({ g: 0, hrDrift: 14 }));
    expect(r.classification).toBe("no_detectable_change");
    expect(Math.abs(r.slopePer28d!)).toBeLessThan(0.012);
  });
  it("adjusts for a heat trend when weather exists, and says it could not when weather is missing", () => {
    const heat = { g: 0, tempTrend: 30, tempEffect: 0.003 };
    const adjusted = run(trendRuns(heat));
    expect(adjusted.weatherAdjustment).toBe("estimated");
    expect(adjusted.classification).toBe("no_detectable_change"); expect(adjusted.covariates.tempPerF!).toBeGreaterThan(0.001);
    const blind = run(trendRuns({ ...heat, withWeather: false }));
    expect(blind.weatherAdjustment).toBe("insufficient_coverage"); expect(blind.flags).toContain("weather_unadjusted");
    expect(blind.interpretation.notSupported.join(" ")).toMatch(/Heat correction/);
    expect(blind.standardError!).toBeGreaterThan(0);
  });
  it("never invents weather: partial coverage below 60% drops the covariate", () => {
    const r = run(trendRuns({ g: -0.02, mutate: (s, i) => (i % 3 === 0 ? s : { ...s, tempF: null }) }));
    expect(r.weatherAdjustment).toBe("insufficient_coverage");
  });
  it("ignores treadmill / no-route runs (counted) and hard-labelled sessions", () => {
    const base = trendRuns({ g: 0 });
    const ruse = trendRuns({ g: 0, mutate: (s, i) => (i % 6 === 0 ? { ...s, type: "Treadmill Run", pace: 420 } : i % 6 === 3 ? { ...s, type: "Tempo Run", pace: 450 } : s) });
    const a = run(base), b = run(ruse);
    expect(b.treadmillOrUnknownSurface).toBeGreaterThan(3); expect(b.classification).toBe("no_detectable_change");
    expect(a.status).toBe("available");
  });
  it("is robust to a single anomalously fast run and to sensor artifacts", () => {
    const clean = run(trendRuns({ g: -0.015 }));
    const odd = run(trendRuns({ g: -0.015, mutate: (s, i) => (i === 30 ? { ...s, pace: s.pace * 0.7 } : i === 12 ? { ...s, hr: 205 } : s) }));
    expect(Math.abs(odd.slopePer28d! - clean.slopePer28d!)).toBeLessThan(0.006);
  });
  it("is unavailable with too few runs, too few weeks, or no heart rate — never a number from thin data", () => {
    expect(run(trendRuns({ n: 12 })).status).toBe("unavailable");
    expect(run(trendRuns({ mutate: s => ({ ...s, hr: null }) })).status).toBe("unavailable");
    const oneWeek = trendRuns({ n: 24 }).map((r, i) => ({ ...r, date: addDays("2026-10-26", i % 7) }));
    const t = run(oneWeek);
    expect(t.status).toBe("unavailable"); expect(t.classification).toBe("unavailable");
  });
  it("a trend produced by one calendar week is not accepted as sustained", () => {
    const runs = trendRuns({ g: 0, noise: 0.004 });
    const week = runs.filter(r => r.date >= "2026-10-26" && r.date <= "2026-11-01");
    const fast = runs.map(r => (week.includes(r) ? { ...r, paceSecondsPerMile: r.paceSecondsPerMile * 0.9, workout: { ...r.workout, durationSeconds: r.workout.durationSeconds * 0.9 } } : r));
    expect(run(fast).classification).not.toBe("observed_improvement");
  });
  it("uses warm-up-trimmed HR when stream summaries exist and marks the source", () => {
    const runs = trendRuns({ g: 0 });
    const summaries: Record<string, HrStreamSummary> = Object.fromEntries(runs.map(r => [r.workout.workoutId,
      { version: "hr-stream-quality-v1", quality: "good", flags: [], samples: 3000, medianGapSeconds: 1, coverageFraction: 1, warmupSeconds: 300,
        trimmedAvgHr: r.workout.avgHeartRate! + 4, rawAvgHr: r.workout.avgHeartRate!, stableSegmentSeconds: 1800, postWarmupSlopeBpmPer10Min: 0.5, intervalLike: false }]));
    expect(run(runs, { streamSummaries: summaries }).hrSource).toBe("stream_trimmed");
    expect(run(runs, { streamSummaries: { [runs[0].workout.workoutId]: summaries[runs[0].workout.workoutId] } }).hrSource).toBe("stream_trimmed_mixed");
    expect(run(runs).hrSource).toBe("parent_average");
  });
  it("VO₂ corroboration agrees, disagrees or stays silent without changing the pace-based classification", () => {
    const runs = trendRuns({ g: -0.02 });
    expect(run(runs, { vo2Entries: vo2(48, 45) }).vo2Corroboration).toBe("agrees");
    const disagree = run(runs, { vo2Entries: vo2(43, 46) });
    expect(disagree.vo2Corroboration).toBe("disagrees"); expect(disagree.classification).toBe("observed_improvement");
    expect(run(runs).vo2Corroboration).toBe("unavailable");
  });
  it("runs after the cutoff, today's run, and weather fetched later never leak in", () => {
    const base = run(trendRuns({ g: -0.02 }));
    const extra = trendRuns({ g: 0 }).map((r, i) => ({ ...r, date: addDays("2026-11-08", i), workout: { ...r.workout, workoutId: `later-${i}` } }));
    const withLater = run([...trendRuns({ g: -0.02 }), ...extra]);
    expect(withLater.slopePer28d).toBeCloseTo(base.slopePer28d!, 12);
    expect(() => run([], { asOf: "soon" })).toThrow(TypeError);
  });
  it("is deterministic and independent of run order", () => {
    const runs = trendRuns({ g: -0.02 });
    expect(JSON.stringify(run([...runs].reverse()))).toBe(JSON.stringify(run(runs)));
  });
});
