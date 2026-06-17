import { describe, it, expect } from "vitest";
import { rollingAverage } from "../smoothSeries";

// Timestamps 1s apart so a 25s window covers the whole short series.
const ts = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("rollingAverage", () => {
  it("leaves a constant series unchanged", () => {
    const values = [600, 600, 600, 600, 600];
    expect(rollingAverage(values, 25, ts(5))).toEqual([600, 600, 600, 600, 600]);
  });

  it("smooths a spike toward its neighbors", () => {
    const values = [600, 600, 1200, 600, 600];
    const out = rollingAverage(values, 25, ts(5));
    const mid = out[2]!;
    // Spike is pulled down toward the neighbor level, not left at 1200.
    expect(mid).toBeGreaterThan(600);
    expect(mid).toBeLessThan(1200);
    expect(mid).toBeCloseTo(720, 5); // (600*4 + 1200) / 5
  });

  it("skips null inputs in the average", () => {
    const out = rollingAverage([600, null, 800], 25, ts(3));
    // Each window averages only the finite values (600 and 800) → 700.
    expect(out[0]).toBeCloseTo(700, 5);
    expect(out[2]).toBeCloseTo(700, 5);
    expect(out.every((v) => v == null || Number.isFinite(v))).toBe(true);
  });

  it("yields null for an all-null window (preserves line breaks)", () => {
    expect(rollingAverage([null, null, null], 25, ts(3))).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("falls back to a fixed-count window when timestamps are unusable", () => {
    // All-equal timestamps → not increasing → fixed-count path.
    const out = rollingAverage([600, 1200, 600], 25, [5, 5, 5]);
    expect(out.every((v) => v != null && Number.isFinite(v))).toBe(true);
  });

  it("empty series → empty output (no crash)", () => {
    expect(rollingAverage([], 25, [])).toEqual([]);
  });

  it("window larger than the whole series → every point becomes the series mean", () => {
    // 3 samples spanning 2s, smoothed with a 600s window: every window covers
    // the entire series, so each output is the overall mean.
    const out = rollingAverage([500, 700, 900], 600, ts(3));
    expect(out).toHaveLength(3);
    for (const v of out) expect(v).toBeCloseTo(700, 5);
  });

  it("single-element series → unchanged", () => {
    expect(rollingAverage([640], 25, [0])).toEqual([640]);
  });
});

// ── Elevation series smoothing (RunOverlayChart ELEV_SMOOTH_WINDOW_SEC = 20) ──
// Elevation feeds the overlay chart's altitude Area. It is always finite
// (altitude defaults to 0 in docToRoutePoint), so a valid series must keep its
// length and never gain a null after the light 20s smooth.
const sumAbsDiff = (xs: number[]) =>
  xs.slice(1).reduce((acc, x, i) => acc + Math.abs(x - xs[i]), 0);

describe("rollingAverage — elevation series (20s window)", () => {
  const ELEV_WINDOW = 20; // mirrors RunOverlayChart's ELEV_SMOOTH_WINDOW_SEC

  it("smooths a noisy climb locally while preserving the overall trend", () => {
    // 40 points, 1s apart (span 39s) so the 20s window is LOCAL, not whole-series:
    // a linear climb (+2 ft/pt) with alternating ±5 ft GPS jitter on top.
    const elevFt = Array.from(
      { length: 40 },
      (_, i) => 100 + i * 2 + (i % 2 === 0 ? 5 : -5)
    );
    const out = rollingAverage(elevFt, ELEV_WINDOW, ts(elevFt.length));

    // Length preserved; no nulls introduced for valid (all-finite) input.
    expect(out).toHaveLength(elevFt.length);
    expect(out.every((v) => v != null && Number.isFinite(v))).toBe(true);

    // Overall climb is preserved (end well above start) — not flattened.
    expect(out[out.length - 1]!).toBeGreaterThan(out[0]!);

    // Jitter is damped: the smoothed trace is far less jagged than the raw one.
    expect(sumAbsDiff(out as number[])).toBeLessThan(sumAbsDiff(elevFt));
  });

  it("series shorter than the window → same length, no nulls (every point = mean)", () => {
    // 4 points spanning 3s vs a 20s window: each window covers the whole series,
    // so every output equals the series mean.
    const elevFt = [200, 210, 190, 220];
    const out = rollingAverage(elevFt, ELEV_WINDOW, ts(elevFt.length));

    expect(out).toHaveLength(elevFt.length);
    expect(out.every((v) => v != null && Number.isFinite(v))).toBe(true);

    const mean = (200 + 210 + 190 + 220) / 4;
    for (const v of out) expect(v!).toBeCloseTo(mean, 5);
  });

  it("output length always equals input length (no nulls for valid input)", () => {
    for (const n of [1, 5, 20, 60]) {
      const elevFt = Array.from({ length: n }, (_, i) => 100 + i);
      const out = rollingAverage(elevFt, ELEV_WINDOW, ts(n));
      expect(out).toHaveLength(n);
      expect(out.every((v) => v != null && Number.isFinite(v))).toBe(true);
    }
  });
});
