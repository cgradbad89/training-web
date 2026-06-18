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

// ── Pipeline ordering: smooth-before-decimate (RunOverlayChart) ──────────────
// The overlay chart's pace jitter was an ORDERING bug in the caller, not in
// rollingAverage: it stride-decimated the series to MAX_CHART_POINTS BEFORE
// smoothing, so the post-decimation spacing (~duration/200s) exceeded the 25s
// window's half-width and each window collapsed to ~1 sample on long runs.
// These tests pin the principle — smooth the full ~1Hz array first, THEN
// decimate — directly, independent of the React component.
const MAX_CHART_POINTS = 200; // mirrors RunOverlayChart

/** Stride-decimation identical to RunOverlayChart: every stride-th point + the last. */
function decimate<T>(arr: T[], max = MAX_CHART_POINTS): T[] {
  if (arr.length <= max) return arr;
  const stride = Math.ceil(arr.length / max);
  return arr.filter((_, i) => i % stride === 0 || i === arr.length - 1);
}

/** Mean absolute first-difference — a simple jaggedness metric (higher = jitterier). */
const meanAbsFirstDiff = (xs: (number | null)[]): number => {
  const v = xs.filter((x): x is number => x != null);
  if (v.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < v.length; i++) sum += Math.abs(v[i] - v[i - 1]);
  return sum / (v.length - 1);
};

describe("rollingAverage — smooth-before-decimate ordering (RunOverlayChart)", () => {
  it("smoothing the full ~1Hz array then decimating is far smoother than decimating then smoothing (long run)", () => {
    // ~2500 samples at 1Hz ≈ a >42min run: a smooth underlying pace trend with
    // high-frequency ±40 sec/mi GPS jitter on top, timestamps 1s apart.
    const N = 2500;
    const time = ts(N);
    const raw = Array.from(
      { length: N },
      (_, i) => 540 + 60 * Math.sin(i / 300) + (i % 2 === 0 ? -40 : 40)
    );

    // Path A (old/bug): decimate to ~200, THEN smooth the sparse array.
    const pathA = rollingAverage(decimate(raw), 25, decimate(time));

    // Path B (new/fix): smooth the full 2500, THEN decimate the smooth curve.
    const pathB = decimate(rollingAverage(raw, 25, time));

    // Both render the same number of points (≤ MAX_CHART_POINTS).
    expect(pathA.length).toBe(pathB.length);
    expect(pathB.length).toBeLessThanOrEqual(MAX_CHART_POINTS);

    const jaggedA = meanAbsFirstDiff(pathA);
    const jaggedB = meanAbsFirstDiff(pathB);

    // Sanity: Path A still carries heavy jitter — smoothing was a no-op once the
    // points were ~13s apart, wider than the 12.5s half-window.
    expect(jaggedA).toBeGreaterThan(10);
    // The fix: Path B is materially smoother — well under half Path A's jaggedness.
    expect(jaggedB).toBeLessThan(jaggedA * 0.5);
  });

  it("short series (< MAX_CHART_POINTS): both orders are identical (no decimation occurs)", () => {
    // 150 samples → never decimated, so smooth-then-decimate == decimate-then-smooth.
    const N = 150;
    const time = ts(N);
    const raw = Array.from(
      { length: N },
      (_, i) => 540 + 60 * Math.sin(i / 30) + (i % 2 === 0 ? -40 : 40)
    );

    const pathA = rollingAverage(decimate(raw), 25, decimate(time));
    const pathB = decimate(rollingAverage(raw, 25, time));

    expect(pathA).toHaveLength(N);
    expect(pathB).toHaveLength(N);
    expect(pathA).toEqual(pathB);
  });
});
