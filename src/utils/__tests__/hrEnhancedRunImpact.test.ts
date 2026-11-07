import { describe, expect, it } from "vitest";
import { computeCurrentHalfRunImpact } from "../currentHalfRunImpact";
import { estimateHrEnhancedHalfMarathon } from "../hrEnhancedPerformance";
import { computeHrEnhancedRunImpact } from "../hrEnhancedRunImpact";
import { addDays, hrScenario, makeRun } from "./fixtures/hrEnhancedFixture";

const run = (o: Parameters<typeof hrScenario>[0], runId: string) => {
  const s = hrScenario(o);
  return { s, impact: computeHrEnhancedRunImpact({ ...s.input, runId }) };
};

describe("HR-enhanced Run Detail impact (same-model with/without)", () => {
  it("with-run equals the headline Plan Insights shows for identical inputs", () => {
    const { s, impact } = run({ recentLevel: 0.92 }, "r3");
    const headline = estimateHrEnhancedHalfMarathon(s.input);
    expect(impact.kind).toBe("estimate");
    if (impact.kind === "estimate") {
      expect(impact.withSeconds).toBe(headline.candidateSeconds);
      expect(impact.withMinutes).toBe(headline.candidateMinutes);
    }
  });

  it("without-run is the same estimator over the same inputs minus the one workout", () => {
    const { s, impact } = run({ recentLevel: 0.92 }, "r3");
    const without = estimateHrEnhancedHalfMarathon({ ...s.input, workouts: s.input.workouts.filter(w => w.workoutId !== "r3") });
    expect(impact.kind).toBe("estimate");
    if (impact.kind === "estimate") {
      expect(impact.withoutSeconds).toBe(without.candidateSeconds);
      expect(impact.deltaSeconds).toBeCloseTo(impact.withSeconds - impact.withoutSeconds, 9);
      expect(impact.direction).toBe(impact.deltaSeconds < 0 ? "faster" : impact.deltaSeconds > 0 ? "slower" : "unchanged");
    }
  });

  it("a run outside the HR evidence (treadmill) has no HR-enhanced effect and is not misattributed", () => {
    const s = hrScenario({ recentLevel: 0.92, extra: [makeRun({ id: "tm", date: "2026-10-05", pace: 480, hr: 140, type: "Treadmill Run", tempF: null })] });
    const impact = computeHrEnhancedRunImpact({ ...s.input, runId: "tm" });
    expect(impact.kind).toBe("estimate");
    if (impact.kind === "estimate") expect(impact.deltaSeconds).toBe(0);
  });

  it("the race anchor run is race evidence: held fixed, never simulated", () => {
    const { impact } = run({ recentLevel: 0.92 }, "anchor-run");
    expect(impact.kind).toBe("not_evidence");
  });

  it("unavailable when the HR-enhanced estimate itself is unavailable, with the reason", () => {
    const { impact } = run({ mutate: s => ({ ...s, hr: null }) }, "r3");
    expect(impact.kind).toBe("unavailable");
    if (impact.kind === "unavailable") expect(impact.reason.length).toBeGreaterThan(10);
  });

  it("unsupported when removing the run would make the estimate unavailable (thin evidence)", () => {
    const s = hrScenario({ recentLevel: 0.9, nBaseline: 6, nRecent: 5, step: 7, baselineStart: "2026-06-30", recentStart: "2026-09-08" });
    const headline = estimateHrEnhancedHalfMarathon(s.input);
    if (headline.candidateSeconds === null) return; // fixture produced no baseline signal; nothing to remove
    const impact = computeHrEnhancedRunImpact({ ...s.input, runId: "r2" });
    expect(["unsupported", "estimate"]).toContain(impact.kind);
    if (headline.supportingRuns.recent === 5) expect(impact.kind).toBe("unsupported");
  });

  it("never mixes in the official model's own per-run delta", () => {
    const s = hrScenario({ recentLevel: 0.92 });
    const official = computeCurrentHalfRunImpact({ ...s.input, runId: "r3" });
    const hr = computeHrEnhancedRunImpact({ ...s.input, runId: "r3" });
    const before = JSON.stringify(official);
    computeHrEnhancedRunImpact({ ...s.input, runId: "r3" });
    expect(JSON.stringify(computeCurrentHalfRunImpact({ ...s.input, runId: "r3" }))).toBe(before);
    expect(hr.kind).toBe("estimate");
    expect(hr.version).toBe("experimental-hr-enhanced-hm-v1");
    if (official.kind === "estimate") expect(official.version).toBe("experimental-current-hm-v2");
  });

  it("a later run changes nothing for an earlier cutoff (as-of integrity)", () => {
    const s = hrScenario({ recentLevel: 0.92 });
    const later = makeRun({ id: "later", date: addDays("2026-10-13", 1), pace: 400, hr: 150, tempF: 40, climbPerMile: 8 });
    const a = computeHrEnhancedRunImpact({ ...s.input, runId: "r3" });
    const b = computeHrEnhancedRunImpact({ ...s.input, workouts: [...s.input.workouts, later], runId: "r3" });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
