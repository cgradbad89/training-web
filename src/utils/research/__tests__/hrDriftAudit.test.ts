import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessStoredHrDrift, computeHrDrift, type HrSample } from "../hrDriftAudit";

const T0 = 1_800_000_000;
/** 1 Hz-ish samples every `step` seconds for `minutes`. */
function series(minutes: number, hrAt: (sec: number) => number, step = 5): HrSample[] {
  const out: HrSample[] = [];
  for (let s = 0; s <= minutes * 60; s += step) out.push({ t: T0 + s, hr: hrAt(s) });
  return out;
}

describe("computeHrDrift", () => {
  it("is zero for constant heart rate", () => {
    const r = computeHrDrift(series(40, () => 150));
    expect(r.status).toBe("ok");
    expect(r.driftPct).toBeCloseTo(0, 6);
    expect(r.coverage).toBeGreaterThan(0.99);
  });

  it("recovers a known step: first half 140, second half 154 → +10 %", () => {
    const r = computeHrDrift(series(40, (s) => (s < 1200 ? 140 : 154)));
    expect(r.driftPct).toBeCloseTo(10, 1);
    expect(r.firstHalfAvg).toBeCloseTo(140, 0);
    expect(r.secondHalfAvg).toBeCloseTo(154, 0);
  });

  it("is invariant to the epoch offset (no wall-clock dependence)", () => {
    const a = computeHrDrift(series(30, (s) => 140 + s / 120));
    const shifted = series(30, (s) => 140 + s / 120).map((x) => ({ ...x, t: x.t + 86_400 * 400 }));
    expect(computeHrDrift(shifted).driftPct).toBeCloseTo(a.driftPct as number, 9);
  });

  it("is order-independent and excludes implausible artifacts instead of averaging them", () => {
    const samples = series(40, () => 150);
    const spiked = [...samples.slice(0, 100), { t: T0 + 3, hr: 0 }, { t: T0 + 4, hr: 255 }, ...samples.slice(100)];
    const r = computeHrDrift([...spiked].reverse());
    expect(r.artifactSamples).toBe(2);
    expect(r.driftPct).toBeCloseTo(0, 6);
  });

  it("warm-up trimming removes the ramp that inflates short-run drift", () => {
    // Optical lock/warm-up: ramps 100→150 over 10 min, then flat. A 30-min run.
    const hr = (s: number) => (s < 600 ? 100 + (s / 600) * 50 : 150);
    const raw = computeHrDrift(series(30, hr));
    const trimmed = computeHrDrift(series(30, hr), { warmupSec: 600, minDurationSec: 600, minSamples: 30 });
    expect(raw.driftPct as number).toBeGreaterThan(5);
    expect(trimmed.driftPct as number).toBeCloseTo(0, 6);
  });

  it("refuses short windows (device contract: 20 minutes)", () => {
    const r = computeHrDrift(series(15, () => 150));
    expect(r.status).toBe("insufficient_duration");
    expect(r.driftPct).toBeNull();
  });

  it("refuses sparse streams", () => {
    const r = computeHrDrift(series(40, () => 150, 60));
    expect(r.status).toBe("insufficient_samples");
  });

  it("refuses a stream with a long hole rather than inventing the missing minutes", () => {
    const samples = series(40, () => 150).filter((s) => s.t < T0 + 600 || s.t > T0 + 1800);
    const r = computeHrDrift(samples, { startSec: T0, endSec: T0 + 2400 });
    expect(r.status).toBe("gap_dominated");
    expect(r.maxGapSec).toBeGreaterThan(1000);
    expect(r.driftPct).toBeNull();
  });

  it("handles empty, NaN and degenerate input", () => {
    expect(computeHrDrift([]).status).toBe("insufficient_samples");
    expect(computeHrDrift([{ t: NaN, hr: 150 }]).status).toBe("insufficient_samples");
    expect(computeHrDrift([{ t: T0, hr: 150 }, { t: T0, hr: 151 }]).status).toBe("no_window");
  });

  it("respects an explicit workout window (pause/outside samples ignored)", () => {
    const samples = [...series(40, () => 150), ...series(10, () => 190).map((s) => ({ ...s, t: s.t + 4000 }))];
    const r = computeHrDrift(samples, { startSec: T0, endSec: T0 + 2400 });
    expect(r.driftPct).toBeCloseTo(0, 6);
  });
});

describe("assessStoredHrDrift", () => {
  it("passes an ordinary value", () => {
    expect(assessStoredHrDrift({ hrDriftPct: 4.2, durationSeconds: 3000, distanceMiles: 5 })).toEqual({ present: true, usable: true, flags: [] });
  });
  it("flags implausible magnitudes as unusable", () => {
    const a = assessStoredHrDrift({ hrDriftPct: 40.8, durationSeconds: 1440, distanceMiles: 2.7 });
    expect(a.usable).toBe(false);
    expect(a.flags).toContain("implausible_magnitude");
    expect(assessStoredHrDrift({ hrDriftPct: -43.5, durationSeconds: 1158, distanceMiles: 2 }).usable).toBe(false);
  });
  it("flags values below the device minimum", () => {
    expect(assessStoredHrDrift({ hrDriftPct: 3, durationSeconds: 600, distanceMiles: 1 }).flags).toContain("below_device_minimum");
    expect(assessStoredHrDrift({ hrDriftPct: 3, durationSeconds: 600, distanceMiles: 2.5 }).flags).not.toContain("below_device_minimum");
  });
  it("marks negative drift beyond noise and warm-up-dominated short runs without discarding them", () => {
    const a = assessStoredHrDrift({ hrDriftPct: -8, durationSeconds: 2000, distanceMiles: 4 });
    expect(a.flags).toEqual(["negative_beyond_noise", "warmup_dominated"]);
    expect(a.usable).toBe(true);
  });
  it("treats null/NaN as absent", () => {
    expect(assessStoredHrDrift({ hrDriftPct: null, durationSeconds: 3000 }).present).toBe(false);
    expect(assessStoredHrDrift({ hrDriftPct: NaN, durationSeconds: 3000 }).present).toBe(false);
  });
});

describe("research isolation", () => {
  it("no live module imports the research directory", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (path.includes("/research") || path.includes("__tests__") || path.includes("node_modules")) continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && /from ["']@\/utils\/research\//.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    walk(join(process.cwd(), "src"));
    expect(offenders).toEqual([]);
  });
});
