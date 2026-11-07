import { describe, expect, it } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import { estimateCurrentHalfMarathon } from "../experimentalCurrentPerformance";
import {
  classifyRunEvidence, computeCurrentHalfRunImpact, formatImpactDelta, type CurrentHalfRunImpact,
} from "../currentHalfRunImpact";
import { currentFixture } from "./fixtures/currentPerformanceFixture";
import { researchRace } from "./fixtures/workoutRaceResearchFixture";
import {
  ANCHOR_RUN_ID, exclusionOverride, fieldOverride, fixtureWithCurrentRuns, improvingNine, minimumThree,
  subsecondSlower, summaryRun, thresholdSix,
} from "./fixtures/currentImpactFixture";

type Input = ReturnType<typeof improvingNine>;
const impact = (input: Input, runId: string) => computeCurrentHalfRunImpact({ ...input, runId });
const estimateOf = (input: Input) => estimateCurrentHalfMarathon(input);
const seconds = (input: Input) => { const e = estimateOf(input); return e.baselineSeconds! + e.adjustmentSeconds; };
function asEstimate(r: CurrentHalfRunImpact) {
  if (r.kind !== "estimate") throw new Error(`expected an estimate comparison, got ${r.kind}`);
  return r;
}

describe("with-run estimate is the Plan Insights estimate", () => {
  it.each([
    ["improving, 9 sessions", improvingNine()],
    ["shared stable fixture", currentFixture()],
    ["shared increased fixture", currentFixture(1.5, 4, 9)],
    ["shared reduced fixture", currentFixture(0.6, 3, 4)],
  ])("matches estimateCurrentHalfMarathon exactly: %s", (_name, input) => {
    const estimate = estimateOf(input);
    const r = impact(input, "base-0-0");
    const withMinutes = r.kind === "unavailable" ? null : r.withMinutes;
    const withSeconds = r.kind === "unavailable" ? null : r.withSeconds;
    expect(withMinutes).toBe(estimate.finishMinutes);
    expect(withSeconds).toBe(estimate.baselineSeconds! + estimate.adjustmentSeconds);
    if (r.kind !== "unavailable") expect(r.version).toBe("experimental-current-hm-v2");
  });

  it("does not mutate the supplied evidence and is deterministic at a fixed evaluation time", () => {
    const input = improvingNine(), before = input.workouts.map(w => w.workoutId).join();
    const first = impact(input, "cur-3-1"), second = impact(input, "cur-3-1");
    expect(second).toEqual(first);
    expect(input.workouts.map(w => w.workoutId).join()).toBe(before);
  });
});

describe("without-run recalculation", () => {
  it("removes exactly the selected eligible run and nothing else", () => {
    const input = improvingNine(), r = asEstimate(impact(input, "cur-3-1"));
    const without = { ...input, workouts: input.workouts.filter(w => w.workoutId !== "cur-3-1") };
    expect(estimateOf(input).eligibleRuns - estimateOf(without).eligibleRuns).toBe(1);
    expect(r.withoutSeconds).toBe(seconds(without));
    expect(r.withoutMinutes).toBe(estimateOf(without).finishMinutes);
    expect(r.deltaSeconds).toBe(r.withSeconds - r.withoutSeconds);
  });

  it("reports a FASTER estimate with the exact signed magnitude when the run supports an improvement", () => {
    const r = asEstimate(impact(improvingNine(), "cur-3-1"));
    expect(r.direction).toBe("faster"); expect(r.deltaSeconds).toBeLessThan(0);
    expect(r.deltaSeconds).toBeCloseTo(-17.947, 2);
    expect(r.withSeconds).toBeLessThan(r.withoutSeconds);
  });

  it("reports a SLOWER estimate, unsuppressed, when the run supports an unfavorable adjustment", () => {
    const input = thresholdSix(), r = asEstimate(impact(input, "cur-2-0"));
    expect(r.direction).toBe("slower"); expect(r.deltaSeconds).toBeCloseTo(10.331, 2);
    expect(r.withSeconds).toBeGreaterThan(r.withoutSeconds);
  });

  it("reports an UNCHANGED estimate, with an exact zero, for a run the model does not move", () => {
    const r = asEstimate(impact(currentFixture(), "base-0-0"));
    expect(r.direction).toBe("unchanged"); expect(r.deltaSeconds).toBe(0);
    expect(r.withMinutes).toBe(r.withoutMinutes);
  });

  it("keeps a positive sub-second influence visible instead of reporting an exact zero", () => {
    const r = asEstimate(impact(subsecondSlower(), "current-3-1"));
    expect(r.direction).toBe("slower"); expect(r.deltaSeconds).toBeGreaterThan(0); expect(r.deltaSeconds).toBeLessThan(1);
    expect(formatImpactDelta(r.deltaSeconds)).toBe("0.9 s");
  });

  it("captures a run that crosses the six-run summary threshold: removing it withholds the whole adjustment", () => {
    const input = thresholdSix(), r = asEstimate(impact(input, "cur-4-0"));
    const withEstimate = estimateOf(input);
    const withoutEstimate = estimateOf({ ...input, workouts: input.workouts.filter(w => w.workoutId !== "cur-4-0") });
    expect(withEstimate.diagnostics.summary).toBe("supported");
    expect(withoutEstimate.diagnostics.summary).toBe("insufficient_coverage");
    expect(withoutEstimate.adjustmentSeconds).toBe(0);
    expect(r.deltaSeconds).toBeCloseTo(withEstimate.adjustmentSeconds, 9);
  });

  it("gives a historical run outside the model's evidence a zero delta and reports its age", () => {
    const r = asEstimate(impact(currentFixture(1.5, 4, 9), "base-0-0"));
    expect(r.deltaSeconds).toBe(0); expect(r.runAgeDays).toBeGreaterThan(100);
  });
});

describe("unsupported and unavailable states", () => {
  it("shows the current estimate but no comparison when removal drops below the three-run minimum", () => {
    const input = minimumThree(), r = impact(input, "cur-5-0");
    expect(estimateOf(input).finishMinutes).not.toBeNull();
    if (r.kind !== "unsupported") throw new Error(r.kind);
    expect(r.withMinutes).toBe(estimateOf(input).finishMinutes);
    expect(r.reason).toContain("At least three completed training runs");
  });

  it("reports an expired race anchor, with the model's exact 180-day boundary", () => {
    const last = estimateOf({ ...improvingNine(), asOf: "2027-02-26T16:00:00.000Z" });
    const first = estimateOf({ ...improvingNine(), asOf: "2027-02-27T16:00:00.000Z" });
    expect(last.anchor).not.toBeNull(); expect(first.anchor).toBeNull();
    const r = impact({ ...improvingNine(), asOf: "2027-02-27T16:00:00.000Z" }, "cur-3-1");
    if (r.kind !== "unavailable") throw new Error(r.kind);
    expect(r.cause).toBe("anchor_expired"); expect(r.reason).toContain("181 days old"); expect(r.reason).toContain("180 days");
  });

  it("reports a missing race anchor when races exist but none is usable", () => {
    const input = { ...improvingNine(), overrides: exclusionOverride(ANCHOR_RUN_ID) }, r = impact(input, "cur-3-1");
    if (r.kind !== "unavailable") throw new Error(r.kind);
    expect(r.cause).toBe("no_anchor"); expect(r.reason).toContain("No usable race anchor");
  });

  it("reports no race context when no race records are loaded", () => {
    const r = impact({ ...improvingNine(), races: [] }, "cur-3-1");
    if (r.kind !== "unavailable") throw new Error(r.kind);
    expect(r.cause).toBe("no_races");
  });

  it("reports insufficient evidence when an anchor exists but recent training is absent", () => {
    const input = fixtureWithCurrentRuns([]), r = impact(input, "base-0-0");
    if (r.kind !== "unavailable") throw new Error(r.kind);
    expect(r.cause).toBe("insufficient_evidence"); expect(r.reason).toContain("At least three completed training runs");
  });
});

describe("selected workout is not training evidence", () => {
  it("holds the qualifying race's own run fixed instead of removing the anchor or inventing one", () => {
    const input = improvingNine(), plain = estimateOf(input), r = impact(input, ANCHOR_RUN_ID);
    if (r.kind !== "not_evidence") throw new Error(r.kind);
    expect(r.runStatus).toBe("race_evidence"); expect(r.isAnchorRun).toBe(true);
    expect(r.withMinutes).toBe(plain.finishMinutes); expect(r.withSeconds).toBe(plain.baselineSeconds! + plain.adjustmentSeconds);
    expect(r.reason).toContain("held fixed");
  });

  it("treats any other race-linked run as race evidence, not as the anchor", () => {
    const old = researchRace("older-half", "2026-03-01", 8100), base = improvingNine();
    const input = { ...base, races: [...base.races, old.race], workouts: [...base.workouts, old.workout] };
    const r = impact(input, old.workout.workoutId);
    if (r.kind !== "not_evidence") throw new Error(r.kind);
    expect(r.runStatus).toBe("race_evidence"); expect(r.isAnchorRun).toBe(false);
  });

  it("never reintroduces a user-excluded run", () => {
    const base = improvingNine(), input = { ...base, overrides: exclusionOverride("cur-3-1") };
    const r = impact(input, "cur-3-1");
    if (r.kind !== "not_evidence") throw new Error(r.kind);
    expect(r.runStatus).toBe("excluded");
    expect(r.withMinutes).toBe(estimateOf(input).finishMinutes);
    expect(estimateOf(input).eligibleRuns).toBe(estimateOf(base).eligibleRuns - 1);
  });

  it("classifies a non-running activity", () => {
    const base = improvingNine(), workouts = base.workouts.map(w => w.workoutId === "cur-3-1" ? { ...w, isRunLike: false } : w);
    const r = impact({ ...base, workouts }, "cur-3-1");
    if (r.kind !== "not_evidence") throw new Error(r.kind);
    expect(r.runStatus).toBe("not_running");
  });

  it.each([
    ["zero distance", { distanceMiles: 0 }],
    ["missing duration", { durationSeconds: Number.NaN }],
  ])("classifies invalid or missing workout metrics (%s) without throwing", (_name, patch: Partial<HealthWorkout>) => {
    const base = improvingNine(), workouts = base.workouts.map(w => w.workoutId === "cur-3-1" ? { ...w, ...patch } : w);
    const r = impact({ ...base, workouts }, "cur-3-1");
    if (r.kind !== "not_evidence") throw new Error(r.kind);
    expect(r.runStatus).toBe("invalid_metrics");
  });

  it("counts one copy of a duplicated activity; the repeated copy is the ineligible one", () => {
    const base = improvingNine(), original = base.workouts.find(w => w.workoutId === "cur-3-1")!;
    const input = { ...base, workouts: [...base.workouts, { ...original, workoutId: "cur-3-1-dup" }] };
    expect(estimateOf(input).eligibleRuns).toBe(estimateOf(base).eligibleRuns);
    const dup = impact(input, "cur-3-1-dup");
    if (dup.kind !== "not_evidence") throw new Error(dup.kind);
    expect(dup.runStatus).toBe("duplicate");
    expect(impact(input, "cur-3-1").kind).toBe("estimate");
  });

  it("reports a run absent from the loaded history as having no influence", () => {
    const r = impact(improvingNine(), "not-in-loaded-history");
    if (r.kind !== "not_evidence") throw new Error(r.kind);
    expect(r.runStatus).toBe("not_loaded");
  });
});

describe("canonical overrides", () => {
  it("evaluates a duration/distance override exactly as the estimator does, and isolates that overridden run", () => {
    const base = improvingNine();
    const input = { ...base, overrides: fieldOverride("cur-3-1", { distanceMilesOverride: 7, durationSecondsOverride: 7 * 600 }) };
    const r = asEstimate(impact(input, "cur-3-1"));
    expect(r.withSeconds).toBe(seconds(input));
    expect(r.withSeconds).not.toBe(seconds(base));
    expect(r.withoutSeconds).toBe(seconds({ ...input, workouts: input.workouts.filter(w => w.workoutId !== "cur-3-1") }));
  });

  it("reports an implausible override pace as zero influence rather than an invented effect", () => {
    const base = improvingNine();
    const input = { ...base, overrides: fieldOverride("cur-3-1", { distanceMilesOverride: 120 }) };
    const r = asEstimate(impact(input, "cur-3-1"));
    expect(r.deltaSeconds).toBe(0);
  });
});

describe("evaluation instant and local-date boundaries", () => {
  const edge = (id: string, iso: string) => { const w = summaryRun(id, "2026-10-01", 5);
    w.startDate = new Date(iso); w.endDate = new Date(w.startDate.getTime() + w.durationSeconds * 1000);
    w.syncedAt = new Date(w.endDate.getTime() + 1000); return w; };

  it("attributes runs to the US-Eastern calendar day across the November DST change", () => {
    const base = improvingNine();
    const input = { ...base, asOf: "2026-11-02T04:30:00.000Z", workouts: [...base.workouts,
      edge("edge-after-midnight", "2026-11-01T04:30:00.000Z"), edge("edge-before-midnight", "2026-11-01T03:30:00.000Z")] };
    expect(asEstimate(impact(input, "edge-after-midnight")).runAgeDays).toBe(0);
    expect(asEstimate(impact(input, "edge-before-midnight")).runAgeDays).toBe(1);
  });

  it("is stable for a fixed evaluation time and never reads the wall clock", () => {
    const input = improvingNine(), results = [0, 1, 2].map(() => JSON.stringify(impact(input, "cur-4-1")));
    expect(new Set(results).size).toBe(1);
  });
});

describe("selector pinning and delta formatting", () => {
  it("classification uses the estimator's own selection (counts reconcile with eligibleRuns)", () => {
    const input = { ...improvingNine(), overrides: exclusionOverride("cur-2-0") };
    const eligible = input.workouts.filter(w => ["training_evidence", "race_evidence"].includes(classifyRunEvidence({ ...input, runId: w.workoutId })));
    expect(eligible.length).toBe(estimateOf(input).eligibleRuns);
  });

  it.each([
    [0, "0 s"], [0.01, "<0.1 s"], [0.945, "0.9 s"], [3.362, "3.4 s"], [17.947, "18 s"], [59.6, "1:00"], [125, "2:05"],
  ])("formats a %s second difference as %s", (value, expected) => expect(formatImpactDelta(value)).toBe(expected));
});
