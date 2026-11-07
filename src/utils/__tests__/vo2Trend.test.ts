import { describe, expect, it } from "vitest";
import {
  VO2_DISCONTINUITY_ML,
  VO2_STALE_DAYS,
  buildVo2TrendSeries,
  summarizeVo2Trend,
  theilSenSlopePer28d,
} from "../vo2Trend";

const iso = (offset: number) => new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);
const entry = (offset: number, value: number) => ({ date: iso(offset), value });

describe("buildVo2TrendSeries", () => {
  it("suppresses the median until three readings fall in the 28-day window (nothing invented)", () => {
    const { points } = buildVo2TrendSeries([entry(0, 48), entry(5, 49), entry(10, 50), entry(40, 47)]);
    expect(points.map((p) => p.median28)).toEqual([null, null, 49, null]);
    expect(points[3].readingsInWindow).toBe(1);
  });

  it("uses only readings dated on or before each point (no future leakage)", () => {
    const base = [entry(0, 40), entry(7, 42), entry(14, 44)];
    const withFuture = [...base, entry(15, 90), entry(16, 90)];
    const a = buildVo2TrendSeries(base).points[2].median28;
    const b = buildVo2TrendSeries(withFuture).points[2].median28;
    expect(a).toBe(42);
    expect(b).toBe(a);
  });

  it("asOf removes later readings and counts them", () => {
    const series = buildVo2TrendSeries([entry(0, 48), entry(10, 49), entry(20, 50)], { asOf: iso(12) });
    expect(series.points).toHaveLength(2);
    expect(series.excluded.afterAsOf).toBe(1);
  });

  it("window is exactly 28 days: a reading 28 days earlier is outside", () => {
    const { points } = buildVo2TrendSeries([entry(0, 10.5), entry(1, 50), entry(2, 50), entry(28, 50)]);
    expect(points[3].readingsInWindow).toBe(3); // offsets 1, 2, 28 — offset 0 is 28 days back
    expect(points[3].median28).toBe(50);
  });

  it("marks extended gaps and does not bridge them", () => {
    const { points } = buildVo2TrendSeries([entry(0, 48), entry(1, 48), entry(2, 48), entry(40, 48)]);
    expect(points[3].gapBefore).toBe(true);
    expect(points[3].median28).toBeNull();
    expect(points[1].gapBefore).toBe(false);
  });

  it("flags discontinuities at the threshold without altering values", () => {
    const { points } = buildVo2TrendSeries([entry(0, 48), entry(1, 48 + VO2_DISCONTINUITY_ML), entry(2, 48 + VO2_DISCONTINUITY_ML + 0.3)]);
    expect(points.map((p) => p.discontinuity)).toEqual([false, true, false]);
    expect(points[1].value).toBe(50);
  });

  it("excludes invalid, non-finite and implausible values; merges duplicate dates by median", () => {
    const { points, excluded } = buildVo2TrendSeries([
      entry(0, 0), entry(1, -3), entry(2, NaN), entry(3, 480), entry(4, 5),
      { date: "not-a-date", value: 48 }, { date: "2026-13-40", value: 48 },
      entry(5, 46), entry(5, 48), entry(5, 50),
    ] as never);
    expect(excluded.invalid).toBe(7);
    expect(excluded.duplicateDatesMerged).toBe(2);
    expect(points).toHaveLength(1);
    expect(points[0].value).toBe(48);
  });

  it("is order-independent", () => {
    const rows = [entry(0, 48), entry(3, 49), entry(6, 50), entry(9, 47)];
    expect(buildVo2TrendSeries([...rows].reverse())).toEqual(buildVo2TrendSeries(rows));
  });

  it("handles empty input", () => {
    expect(buildVo2TrendSeries([])).toEqual({ points: [], excluded: { invalid: 0, afterAsOf: 0, duplicateDatesMerged: 0 } });
  });
});

describe("summarizeVo2Trend", () => {
  it("reports staleness from the latest reading, not from the series length", () => {
    const series = buildVo2TrendSeries([entry(0, 48), entry(1, 49), entry(2, 50)]);
    expect(summarizeVo2Trend(series, iso(2 + VO2_STALE_DAYS)).stale).toBe(false);
    expect(summarizeVo2Trend(series, iso(2 + VO2_STALE_DAYS + 1)).stale).toBe(true);
  });

  it("derives the reference level from the data rather than a constant", () => {
    const series = buildVo2TrendSeries([entry(0, 44), entry(1, 46), entry(2, 52)]);
    expect(summarizeVo2Trend(series, iso(3)).referenceMedian).toBe(46);
  });

  it("is safe with no readings", () => {
    const summary = summarizeVo2Trend(buildVo2TrendSeries([]), iso(0));
    expect(summary).toMatchObject({ latestDate: null, latestValue: null, daysSinceLatest: null, stale: false, referenceMedian: null });
  });
});

describe("theilSenSlopePer28d (research only)", () => {
  const ramp = Array.from({ length: 12 }, (_, i) => entry(i * 7, 40 + i * 0.5)); // +0.5 per 7 d → +2 per 28 d

  it("recovers a known linear slope", () => {
    expect(theilSenSlopePer28d(ramp, iso(77), { windowDays: 120 })).toBeCloseTo(2, 5);
  });

  it("refuses with too few readings, too short a span, or an internal extended gap", () => {
    expect(theilSenSlopePer28d(ramp.slice(0, 5), iso(28))).toBeNull();
    const dense = Array.from({ length: 10 }, (_, i) => entry(i, 45));
    expect(theilSenSlopePer28d(dense, iso(9))).toBeNull();
    const gapped = [...ramp.slice(0, 6), ...ramp.slice(6).map((e, i) => entry(60 + i * 7, e.value))];
    expect(theilSenSlopePer28d(gapped, iso(140), { windowDays: 200 })).toBeNull();
  });

  it("does not use readings after asOf", () => {
    const withFuture = [...ramp, entry(80, 99), entry(81, 99)];
    expect(theilSenSlopePer28d(withFuture, iso(77), { windowDays: 120 })).toBeCloseTo(2, 5);
  });
});
