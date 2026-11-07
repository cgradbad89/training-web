import { describe, expect, it } from "vitest";
import {
  buildEfficiencyBaseline,
  computeEfficiencyScore,
  scoreWorkoutsEfficiency,
  type EfficiencyWorkout,
} from "../efficiencyScore";
import { computeHRReserve, hasValidHrAnchors } from "../hrReserve";

// Phase 3L regression: Training Load V2 refuses to score when maxHr ≤ restingHr,
// but the efficiency path did not, so the settings page (which validates max and
// resting independently: 100–230 and 30–120) could yield NaN / sign-flipped %HRR.

const NOW = Date.UTC(2026, 10, 1);
const day = (n: number) => new Date(NOW - n * 86_400_000);
const runs: EfficiencyWorkout[] = Array.from({ length: 8 }, (_, i) => ({
  workoutId: `r${i}`, startDate: day(i + 1), distanceMiles: 5, durationSeconds: 2700,
  avgPaceSecPerMile: 540 + i * 5, avgHeartRate: 140 + i, cadenceSPM: 170,
}));

describe("hasValidHrAnchors", () => {
  it.each([
    [60, 190, true], [100, 100, false], [110, 100, false], [NaN, 190, false], [60, Infinity, false], [60, 61, true],
  ])("rest=%s max=%s → %s", (rest, max, expected) => {
    expect(hasValidHrAnchors(rest, max)).toBe(expected);
  });

  it("documents why the guard is needed: the raw helper yields NaN for an equal pair", () => {
    expect(Number.isNaN(computeHRReserve(100, 100, 100))).toBe(true);
  });
});

describe("efficiency score with invalid HR anchors", () => {
  it("builds no baseline when maxHr equals restingHr", () => {
    const baseline = buildEfficiencyBaseline(runs, new Date(NOW), 100, 100);
    expect(baseline.runCount).toBe(0);
  });

  it("builds no baseline when maxHr is below restingHr", () => {
    expect(buildEfficiencyBaseline(runs, new Date(NOW), 120, 100).runCount).toBe(0);
  });

  it("never returns a scored result with a NaN %HRR", () => {
    const valid = buildEfficiencyBaseline(runs, new Date(NOW), 60, 190);
    const result = computeEfficiencyScore({
      avgPaceSecPerMile: 540, avgHeartRate: 100, cadenceSPM: 170, restingHr: 100, maxHr: 100, baseline: valid,
    });
    expect(result.status).toBe("building_baseline");
    expect(result.score).toBeNull();
    expect(result.hrrPct).toBeNull();
  });

  it("scores nothing for the whole history under an invalid pair", () => {
    const scores = scoreWorkoutsEfficiency(runs, 100, 90);
    for (const result of scores.values()) {
      expect(result.status).toBe("building_baseline");
      expect(Number.isNaN(result.hrrPct as number)).toBe(false);
    }
  });

  it("leaves valid-anchor behavior unchanged", () => {
    const scores = scoreWorkoutsEfficiency(runs, 60, 190);
    expect([...scores.values()].some((r) => r.status === "scored")).toBe(true);
  });
});
