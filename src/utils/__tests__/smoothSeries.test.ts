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
});
