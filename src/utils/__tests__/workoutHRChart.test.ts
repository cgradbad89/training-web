import { describe, expect, it } from "vitest";

import {
  buildHRChartData,
  formatElapsedMMSS,
  HR_CHART_MAX_POINTS,
} from "@/utils/workoutHRChart";

const BASE = Date.parse("2024-01-01T00:00:00Z");

/** Build `count` samples `dtSec` apart, hr chosen per `hrAt(i)`. */
function buildSamples(
  count: number,
  hrAt: (i: number) => number,
  dtSec = 1
): { timestamp: string; hr: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(BASE + i * dtSec * 1000).toISOString(),
    hr: hrAt(i),
  }));
}

describe("buildHRChartData", () => {
  it("returns [] when fewer than 2 valid samples remain", () => {
    expect(buildHRChartData([])).toEqual([]);
    expect(buildHRChartData(buildSamples(1, () => 150))).toEqual([]);
    // Two samples but one is out-of-range → only 1 valid → [].
    expect(
      buildHRChartData([
        { timestamp: new Date(BASE).toISOString(), hr: 150 },
        { timestamp: new Date(BASE + 1000).toISOString(), hr: 300 },
      ])
    ).toEqual([]);
  });

  it("filters out-of-range HR (≥220 / ≤40 dropped, in-range kept)", () => {
    const samples = [
      { timestamp: new Date(BASE).toISOString(), hr: 0 }, // dropped
      { timestamp: new Date(BASE + 1000).toISOString(), hr: 150 }, // keep
      { timestamp: new Date(BASE + 2000).toISOString(), hr: 300 }, // dropped
      { timestamp: new Date(BASE + 3000).toISOString(), hr: 175 }, // keep
      { timestamp: new Date(BASE + 4000).toISOString(), hr: 40 }, // keep (boundary)
      { timestamp: new Date(BASE + 5000).toISOString(), hr: 220 }, // keep (boundary)
    ];
    const out = buildHRChartData(samples);
    expect(out.map((d) => d.hr)).toEqual([150, 175, 40, 220]);
    expect(out.every((d) => d.hr >= 40 && d.hr <= 220)).toBe(true);
  });

  it("timeSec starts at 0 and is monotonic non-decreasing (re-sorts if needed)", () => {
    // Deliberately out of order — must sort ascending by time.
    const samples = [
      { timestamp: new Date(BASE + 2000).toISOString(), hr: 160 },
      { timestamp: new Date(BASE).toISOString(), hr: 150 },
      { timestamp: new Date(BASE + 1000).toISOString(), hr: 155 },
    ];
    const out = buildHRChartData(samples);
    expect(out[0].timeSec).toBe(0);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].timeSec).toBeGreaterThanOrEqual(out[i - 1].timeSec);
    }
    // First (earliest) sample's hr leads after the sort.
    expect(out[0].hr).toBe(150);
    expect(out.map((d) => d.timeSec)).toEqual([0, 1, 2]);
  });

  it("downsamples dense streams to ≤ MAX_CHART_POINTS and keeps the last point", () => {
    // 1000 valid samples → stride 4 → ≤300, last retained.
    const n = 1000;
    const samples = buildSamples(n, (i) => 120 + (i % 50)); // all in-range
    const out = buildHRChartData(samples);
    expect(out.length).toBeLessThanOrEqual(HR_CHART_MAX_POINTS);
    expect(out.length).toBeGreaterThan(1);
    // Last datum corresponds to the final sample (elapsed = n-1 sec).
    expect(out[out.length - 1].timeSec).toBe(n - 1);
    expect(out[out.length - 1].hr).toBe(120 + ((n - 1) % 50));
  });

  it("leaves sub-threshold streams unstrided (≤300 passes through unchanged)", () => {
    const samples = buildSamples(250, () => 150);
    const out = buildHRChartData(samples);
    expect(out.length).toBe(250);
  });
});

describe("formatElapsedMMSS", () => {
  it("formats seconds as m:ss with zero-padded seconds", () => {
    expect(formatElapsedMMSS(0)).toBe("0:00");
    expect(formatElapsedMMSS(9)).toBe("0:09");
    expect(formatElapsedMMSS(65)).toBe("1:05");
    expect(formatElapsedMMSS(600)).toBe("10:00");
    expect(formatElapsedMMSS(-5)).toBe("0:00"); // clamps negatives
  });
});
