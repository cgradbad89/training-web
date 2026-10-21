import { describe, expect, it } from "vitest";
import type { EffectivePerformanceWorkout, PerformanceCoverage } from "@/types/performanceAnalysis";
import { summarizeEndurancePreparation } from "@/utils/endurancePreparation";

function run(workoutId: string, startedAt = "2026-10-20T12:00:00Z", overrides: Partial<EffectivePerformanceWorkout> = {}): EffectivePerformanceWorkout {
  return {
    workoutId, startedAt, endedAt: new Date(Date.parse(startedAt) + 3600_000).toISOString(),
    availableAt: null, completion: "completed", excluded: false, isRun: true,
    runKind: "outdoor", distanceMeters: 5000, durationSeconds: 3600,
    averageHrBpm: null, ascentMeters: null,
    environment: { temperatureF: null, dewPointF: null, windMph: null },
    parentDigest: `parent-${workoutId}`, telemetry: { state: "unknown", contentDigest: null, verification: "unverified" },
    provenance: { source: "synthetic", sourceId: workoutId, notes: [] }, limitations: [],
    ...overrides,
  };
}

const coverage: PerformanceCoverage = {
  window: { startDate: "2025-01-01", endDate: "2027-12-31" },
  workouts: "complete", telemetry: "unknown", deviceVo2: "unknown", expectedWorkoutCount: null, limitations: [],
};

function summarize(workouts: readonly EffectivePerformanceWorkout[], options: Partial<Parameters<typeof summarizeEndurancePreparation>[0]> = {}) {
  return summarizeEndurancePreparation({
    workouts, asOf: "2026-10-21T14:00:00Z", timeZone: "America/New_York",
    observationDays: 180, longRunDefinitionMeters: 12874.752, coverage, ...options,
  });
}

describe("summarizeEndurancePreparation", () => {
  it("retains completed summary-only runs without requiring HR or complete telemetry", () => {
    const result = summarize([run("one"), run("two", "2026-10-19T12:00:00Z", {
      distanceMeters: 15000, durationSeconds: 5400, telemetry: { state: "pending", contentDigest: null, verification: "unverified" },
    })]);
    expect(result.recent).toEqual({ meters: 20000, seconds: 9000, runCount: 2, runDays: 2, runsPerWeek: 0.5 });
    expect(result.longestRecentRun).toEqual({ workoutId: "two", date: "2026-10-19", meters: 15000, seconds: 5400 });
    expect(result.longRunCount).toBe(1);
  });

  it("counts two distinct workouts on one day as two runs and one running day", () => {
    const result = summarize([run("morning"), run("evening", "2026-10-20T20:00:00Z")]);
    expect(result.recent.runCount).toBe(2);
    expect(result.recent.runDays).toBe(1);
  });

  it("deduplicates identical records and excludes ambiguous conflicting versions", () => {
    const source = run("same");
    expect(summarize([source, { ...source }]).recent.runCount).toBe(1);
    const conflicted = summarize([source, { ...source, distanceMeters: 7000 }]);
    expect(conflicted.recent.runCount).toBeNull();
    expect(conflicted.limitations.join(" ")).toMatch(/Conflicting records/);
  });

  it("uses effective corrected values while excluding non-runs, exclusions and unfinished summaries", () => {
    const result = summarize([
      run("corrected", undefined, { distanceMeters: 1609.344, durationSeconds: 600 }),
      run("excluded", undefined, { excluded: true, distanceMeters: 30000 }),
      run("bike", undefined, { isRun: false, distanceMeters: 50000 }),
      run("unfinished", undefined, { completion: "incomplete" }),
      run("unresolved", undefined, { completion: "unknown" }),
    ]);
    expect(result.recent.meters).toBe(1609.344);
    expect(result.recent.seconds).toBe(600);
    expect(result.recent.runCount).toBe(1);
    expect(result.weekly.at(-1)?.miles).toBe(1);
    expect(result.weekly.at(-1)?.coverage).toBe("partial");
  });

  it("rejects nonfinite, zero, negative and invalid-timestamp physical summaries", () => {
    const result = summarize([
      run("nan", undefined, { distanceMeters: NaN }),
      run("infinite", undefined, { durationSeconds: Infinity }),
      run("zero", undefined, { distanceMeters: 0 }),
      run("negative", undefined, { durationSeconds: -1 }),
      run("bad-time", undefined, { endedAt: "not-an-instant" }),
      run("backwards", undefined, { endedAt: "2026-10-19T12:00:00Z" }),
    ]);
    expect(result.recent.meters).toBeNull();
    expect(result.longRunCount).toBeNull();
    expect(result.consistency.completeWeeks).toBe(0);
  });

  it("excludes future completion and known future or invalid availability", () => {
    const result = summarize([
      run("future-completion", "2026-10-21T13:30:00Z"),
      run("later-sync", undefined, { availableAt: "2026-10-21T15:00:00Z" }),
      run("invalid-sync", undefined, { availableAt: "invalid" }),
      run("at-cutoff", "2026-10-21T13:00:00Z", { availableAt: "2026-10-21T14:00:00Z" }),
    ]);
    expect(result.recent.runCount).toBe(1);
    expect(result.longestRecentRun?.workoutId).toBe("at-cutoff");
  });

  it("retains unknown availability as a limitation without inventing historical certainty", () => {
    expect(summarize([run("legacy")]).limitations.join(" ")).toMatch(/prior availability cannot be verified/);
  });

  it("keeps verified empty counts at zero and unknown empty counts null", () => {
    expect(summarize([]).recent).toEqual({ meters: 0, seconds: 0, runCount: 0, runDays: 0, runsPerWeek: 0 });
    expect(summarize([]).longRunCount).toBe(0);
    const unknown = summarize([], { coverage: { ...coverage, workouts: "unknown" } });
    expect(unknown.recent).toEqual({ meters: null, seconds: null, runCount: null, runDays: null, runsPerWeek: null });
    expect(unknown.longRunCount).toBeNull();
    expect(unknown.consistency).toEqual({ completeWeeks: 0, weeksWithRuns: 0, fraction: null });
    const partial = summarize([run("observed")], { coverage: { ...coverage, workouts: "partial" } });
    expect(partial.recent.runCount).toBe(1);
    expect(partial.longRunCount).toBeNull();
  });

  it("does not certify zeros outside the explicitly supplied coverage window", () => {
    const result = summarize([], { coverage: { ...coverage, window: { startDate: "2026-10-01", endDate: "2026-10-21" } } });
    expect(result.recent.runCount).toBeNull();
    expect(result.weekly[0].coverage).toBe("unknown");
    expect(result.weekly.at(-1)?.coverage).toBe("complete");
  });

  it("uses inclusive local 28/56-day windows and a bounded 180-day weekly history", () => {
    const result = summarize([
      run("start-recent", "2026-09-24T04:00:00Z", { distanceMeters: 13000 }),
      run("before-recent", "2026-09-24T03:00:00Z", { distanceMeters: 14000 }),
      run("start-long", "2026-08-27T04:00:00Z", { distanceMeters: 15000 }),
      run("before-long", "2026-08-27T03:00:00Z", { distanceMeters: 16000 }),
      run("before-scope", "2026-04-24T12:00:00Z", { distanceMeters: 17000 }),
    ]);
    expect(result.recentWindow).toEqual({ startDate: "2026-09-24", endDate: "2026-10-21" });
    expect(result.longRunWindow).toEqual({ startDate: "2026-08-27", endDate: "2026-10-21" });
    expect(result.recent.runCount).toBe(1);
    expect(result.longRunCount).toBe(3);
    expect(result.weekly.length).toBeLessThanOrEqual(27);
    expect(result.weekly[0].window.startDate).toBe("2026-04-25");
  });

  it("uses the explicit timezone at local-day boundaries", () => {
    const result = summarize([run("local-evening", "2026-10-21T01:00:00Z")], { asOf: "2026-10-21T02:00:00Z" });
    expect(result.recentWindow.endDate).toBe("2026-10-20");
    expect(result.longestRecentRun?.date).toBe("2026-10-20");
    const tokyo = summarize([run("tokyo-morning", "2026-10-20T23:00:00Z")], {
      asOf: "2026-10-21T02:00:00Z", timeZone: "Asia/Tokyo",
    });
    expect(tokyo.longestRecentRun?.date).toBe("2026-10-21");
  });

  it.each([
    ["2026-03-09T14:00:00Z", "2026-02-10", "2026-03-08T06:30:00Z", "2026-03-02"],
    ["2026-11-02T14:00:00Z", "2026-10-06", "2026-11-01T05:30:00Z", "2026-10-26"],
  ])("keeps calendar dates and Monday buckets through DST at %s", (asOf, startDate, startedAt, expectedMonday) => {
    const result = summarize([run("dst", startedAt)], { asOf });
    expect(result.recentWindow.startDate).toBe(startDate);
    expect(result.weekly.find((week) => week.runCount === 1)?.weekStart).toBe(expectedMonday);
  });

  it("measures consistency only across fully covered completed calendar weeks", () => {
    const result = summarize([run("week-one", "2026-10-07T12:00:00Z"), run("current", "2026-10-20T12:00:00Z")], { observationDays: 17 });
    expect(result.weekly.map((week) => week.partialWeek)).toEqual([false, false, true]);
    expect(result.consistency).toEqual({ completeWeeks: 2, weeksWithRuns: 1, fraction: 0.5 });
    expect(summarize([], { asOf: "2026-10-25T23:00:00Z", observationDays: 7 }).weekly[0].partialWeek).toBe(true);
  });

  it("clips recent windows to a shorter observation scope and keeps results deterministic without mutation", () => {
    const inputs = [run("b", "2026-10-20T12:00:00Z"), run("a", "2026-10-19T12:00:00Z")];
    const before = JSON.stringify(inputs);
    const result = summarize(Object.freeze(inputs), { observationDays: 7 });
    expect(result.recentWindow.startDate).toBe("2026-10-15");
    expect(result.recent.runsPerWeek).toBe(2);
    expect(summarize([...inputs].reverse(), { observationDays: 7 })).toEqual(result);
    expect(JSON.stringify(inputs)).toBe(before);
  });

  it("keeps limitations deterministic across reordered duplicates and distinct invalid source cases", () => {
    const source = run("summary", undefined, { limitations: ["First recorded limitation."] });
    const sources = [
      source,
      { ...source, limitations: ["Second recorded limitation."] },
      run("invalid", undefined, { distanceMeters: NaN }),
      run("later", undefined, { availableAt: "2026-10-21T15:00:00Z" }),
    ];
    const forward = summarize(sources);
    expect(summarize([...sources].reverse())).toEqual(forward);
    expect(forward.limitations).toContain("First recorded limitation.");
    expect(forward.limitations).toContain("Second recorded limitation.");
    expect(forward.limitations).toEqual([...forward.limitations].sort());
  });

  it("rejects unsupported scope sizes and invalid long-run thresholds", () => {
    expect(() => summarize([], { observationDays: 181 })).toThrow(/observationDays/);
    expect(() => summarize([], { longRunDefinitionMeters: NaN })).toThrow(/longRunDefinitionMeters/);
    expect(() => summarize([], { coverage: { ...coverage, window: { startDate: "2026-02-30", endDate: "2026-10-21" } } })).toThrow(/coverage/);
  });
});
