import { describe, expect, it } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import { buildComparableEffortFunnel } from "../comparableEffortFunnel";
import { CURRENT_HALF_POLICY, estimateCurrentHalfMarathon } from "../experimentalCurrentPerformance";
import { researchRace, researchRun } from "./fixtures/workoutRaceResearchFixture";

// Phase 3K/3J interaction (B4): newly acquired weather must flow into the unchanged
// v2 model correctly — visible only when fetchedAt ≤ as-of, never altering thresholds
// or the formula, and never rewriting what an earlier instant could see.

const AS_OF = "2026-10-10T16:00:00.000Z";
const LATER = "2026-10-12T16:00:00.000Z";
const BASELINE = ["2026-07-10", "2026-07-17", "2026-07-24", "2026-08-02", "2026-08-09", "2026-08-16"];
const RECENT = ["2026-09-17", "2026-09-19", "2026-09-25", "2026-09-27", "2026-10-02", "2026-10-04"];
const WEATHER = (fetchedAt: string) => ({ tempF: 60, feelsLikeF: 60, humidity: 50, windMph: 3, dewPointF: 45, conditionCode: 1, conditionText: "Clear", fetchedAt });

function input(weather: (date: string) => HealthWorkout["weather"], asOf = AS_OF) {
  const anchor = researchRace("anchor", "2026-08-30", 7871);
  const workouts = [
    anchor.workout,
    ...BASELINE.map((d, i) => researchRun(`b${i}`, d, 600, { weather: weather(d) })),
    ...RECENT.map((d, i) => researchRun(`r${i}`, d, 576, { weather: weather(d) })),
  ];
  return { races: [anchor.race], workouts, overrides: {}, asOf, timeZone: "America/New_York" };
}
const gate = (f: ReturnType<typeof buildComparableEffortFunnel>, name: string) => f.gates.find((g) => g.gate === name)!;

describe("weather acquisition → comparable-effort evidence", () => {
  it("before: runs without weather fail only at the weather gate and the evidence does not contribute", () => {
    const funnel = buildComparableEffortFunnel(input(() => null));
    expect(gate(funnel, "Weather available").surviving).toBe(0);
    expect(gate(funnel, "Weather available").missingData).toBe(gate(funnel, "Weather available").candidates);
    expect(funnel.matchedPairs).toBe(0);
    expect(estimateCurrentHalfMarathon(input(() => null)).adjustmentMethod).not.toBe("matched_effort");
  });

  it("after: weather fetched before the evaluation instant makes the same pairs eligible", () => {
    const after = input((d) => WEATHER(`${d}T20:00:00.000Z`));
    const funnel = buildComparableEffortFunnel(after);
    expect(gate(funnel, "Weather available").surviving).toBe(gate(funnel, "Weather available").candidates);
    expect(funnel.matchedPairs).toBeGreaterThanOrEqual(3);
    expect(estimateCurrentHalfMarathon(after).adjustmentMethod).toBe("matched_effort");
  });

  it("acquisition changes availability only: policy version, anchor and baseline are identical", () => {
    const before = estimateCurrentHalfMarathon(input(() => null));
    const after = estimateCurrentHalfMarathon(input((d) => WEATHER(`${d}T20:00:00.000Z`)));
    expect(after.version).toBe(CURRENT_HALF_POLICY.version);
    expect(after.version).toBe(before.version);
    expect(after.baselineSeconds).toBe(before.baselineSeconds);
    expect(after.anchor?.raceDate).toBe(before.anchor?.raceDate);
  });

  it("retrospective recovery is invisible to earlier instants (fetchedAt after as-of) and visible later", () => {
    const recoveredAt = "2026-10-11T09:00:00.000Z"; // acquired the day after AS_OF, for old runs
    const earlier = buildComparableEffortFunnel(input(() => WEATHER(recoveredAt), AS_OF));
    expect(gate(earlier, "Weather available").surviving).toBe(0);
    expect(earlier.matchedPairs).toBe(0);
    const later = buildComparableEffortFunnel(input(() => WEATHER(recoveredAt), LATER));
    expect(later.matchedPairs).toBeGreaterThanOrEqual(3);
  });

  it("does not loosen thresholds: weather that is acquired but outside tolerance still fails the match gate", () => {
    const funnel = buildComparableEffortFunnel(input((d) => WEATHER(`${d}T20:00:00.000Z`) && {
      ...WEATHER(`${d}T20:00:00.000Z`), tempF: d < "2026-08-30" ? 78 : 55,
    }));
    expect(gate(funnel, "Weather available").surviving).toBeGreaterThan(0);
    expect(gate(funnel, "Weather match").surviving).toBe(0);
    expect(funnel.matchedPairs).toBe(0);
  });
});
