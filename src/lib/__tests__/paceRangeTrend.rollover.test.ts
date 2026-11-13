import { describe, it, expect } from "vitest";
import { computePaceRangeTrend, windowStartDate, labelFor, type PaceRangeRun } from "@/lib/paceRangeTrend";
import { buildRunAnalysisTrend, type RunAnalysisWorkout } from "@/lib/runAnalysisTrend";
import { toLocalIsoDate } from "@/utils/dates";

const r = (y: number, m: number, d: number): PaceRangeRun => ({
  distanceMiles: 4, durationSeconds: 2400, date: new Date(y, m, d, 12),
});

describe("12-month window across the 2026 → 2027 boundary", () => {
  const now = new Date(2027, 0, 20, 9);
  const runs = [r(2026, 0, 25), r(2026, 5, 10), r(2026, 11, 29), r(2027, 0, 5)];

  it("produces unique, chronologically ordered bucket starts", () => {
    const wk: RunAnalysisWorkout[] = runs.map((x, i) => ({
      workoutId: `w${i}`, date: x.date.toISOString(), distanceMiles: 4, durationSeconds: 2400,
      avgPaceSecPerMile: 600, avgHeartRate: 150, cadenceSPM: 170, activityType: "HKWorkoutActivityTypeRunning",
    }));
    const pts = buildRunAnalysisTrend(wk, "pace", 1, 10, "12m", 65, 175, now);
    const starts = pts.map((p) => p.bucketStartDate);
    expect(starts).toEqual(["2026-01-01", "2026-06-01", "2026-12-01", "2027-01-01"]);
    expect(new Set(starts).size).toBe(starts.length);
    expect([...starts].sort()).toEqual(starts);
  });

  it("labels carry the year so the two Januaries are distinguishable", () => {
    const res = computePaceRangeTrend(runs, 1, 10, "12m", now);
    const labels = res.points.map((p) => p.label);
    expect(labels).toEqual(["Jan '26", "Jun '26", "Dec '26", "Jan '27"]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("weekly labels are unchanged", () => {
    expect(labelFor(new Date(2026, 11, 28), "week")).toBe("Dec 28");
  });

  it("YTD at 2027-01-01 starts at local Jan 1 and drops the Dec 31 evening run", () => {
    const res = computePaceRangeTrend([r(2026, 11, 31), { ...r(2027, 0, 1), date: new Date(2027, 0, 1, 8) }], 1, 10, "ytd", new Date(2027, 0, 1, 0, 30));
    expect(res.totalRunCount).toBe(1);
    expect(res.points.map((p) => p.label)).toEqual(["Jan '27"]);
  });
});

describe("Feb 29, 2028 clamping (windowStartDate)", () => {
  const leapDay = new Date(2028, 1, 29, 10, 15);
  it("12m from 2028-02-29 starts 2027-02-28, not 2027-03-01", () => {
    const d = windowStartDate("12m", leapDay);
    expect(toLocalIsoDate(d)).toBe("2027-02-28");
    expect([d.getHours(), d.getMinutes()]).toEqual([10, 15]);
  });
  it("1m/2m/3m/6m from 2028-02-29", () => {
    expect(toLocalIsoDate(windowStartDate("1m", leapDay))).toBe("2028-01-29");
    expect(toLocalIsoDate(windowStartDate("6m", leapDay))).toBe("2027-08-29");
  });
  it("a Feb 28 2027 run is inside the 12m window and a Feb 27 run is outside", () => {
    const res = computePaceRangeTrend([r(2027, 1, 28), r(2027, 1, 27)], 1, 10, "12m", new Date(2028, 1, 29, 10));
    expect(res.totalRunCount).toBe(1);
  });
  it("month-end overflow no longer leaks: 6m from Aug 31 → Feb 28", () => {
    expect(toLocalIsoDate(windowStartDate("6m", new Date(2026, 7, 31)))).toBe("2026-02-28");
  });
  it("YTD is unaffected", () => {
    expect(toLocalIsoDate(windowStartDate("ytd", leapDay))).toBe("2028-01-01");
  });
});
