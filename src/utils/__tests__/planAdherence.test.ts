import { describe, expect, it } from "vitest";
import { buildPlanAdherence } from "@/utils/planAdherence";
import { type RunningPlan, type PlannedRunEntry } from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function runEntry(
  weekIndex: number,
  weekday: number,
  distanceMiles: number,
  id: string
): PlannedRunEntry {
  return {
    id,
    weekIndex,
    weekday,
    dayOfWeek: weekday - 1,
    distanceMiles,
    runType: "outdoor",
  };
}

// 3-week plan starting Mon 2026-01-19. Each week: a single planned run on
// Monday (weekday 1).
function makePlan(): RunningPlan {
  return {
    id: "plan1",
    name: "Test Plan",
    planType: "running",
    startDate: "2026-01-19",
    status: "completed",
    isActive: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    weeks: [
      { weekNumber: 1, entries: [runEntry(0, 1, 5, "w1-mon")] },
      { weekNumber: 2, entries: [runEntry(1, 1, 6, "w2-mon")] },
      { weekNumber: 3, entries: [runEntry(2, 1, 7, "w3-mon")] },
    ],
  };
}

// Minimal HealthWorkout — only the fields the util reads.
function run(
  startISO: string,
  distanceMiles: number,
  durationSeconds: number
): HealthWorkout {
  return {
    workoutId: `run-${startISO}`,
    isRunLike: true,
    startDate: new Date(startISO),
    distanceMiles,
    durationSeconds,
    avgHeartRate: null,
    trainingLoadV2: null,
  } as unknown as HealthWorkout;
}

// Weeks: W1 Mon 1/19, W2 Mon 1/26, W3 Mon 2/2. UTC-noon timestamps keep the
// calendar day stable regardless of the test runner's timezone.
const W1_RUN = run("2026-01-19T12:00:00Z", 5, 5 * 600); // 10:00/mi, matches W1 plan
const W2_RUN = run("2026-01-26T12:00:00Z", 6, 6 * 660); // 11:00/mi, matches W2 plan
// W3 has NO actual run.

describe("buildPlanAdherence — full span", () => {
  it("totals planned/actual miles and runs across ALL weeks", () => {
    const r = buildPlanAdherence(makePlan(), [W1_RUN, W2_RUN], {
      maxHr: 185,
    });
    expect(r.weeks).toHaveLength(3); // full span — week 3 included despite no run
    expect(r.totalPlannedMiles).toBeCloseTo(18, 5); // 5 + 6 + 7
    expect(r.totalActualMiles).toBeCloseTo(11, 5); // 5 + 6 + 0
    expect(r.totalPlannedRuns).toBe(3);
    expect(r.totalCompletedRuns).toBe(2); // W1 + W2 matched, W3 unmatched
  });

  it("counts weeksHitTarget at the 85% threshold", () => {
    const r = buildPlanAdherence(makePlan(), [W1_RUN, W2_RUN], { maxHr: 185 });
    // W1: 5/5 = 100% hit; W2: 6/6 = 100% hit; W3: 0/7 = miss.
    expect(r.weeksHitTarget).toBe(2);
  });

  it("computes per-week avg pace (null when no runs that week)", () => {
    const r = buildPlanAdherence(makePlan(), [W1_RUN, W2_RUN], { maxHr: 185 });
    expect(r.weeks[0].avgPaceSecPerMile).toBeCloseTo(600, 5); // 10:00/mi
    expect(r.weeks[1].avgPaceSecPerMile).toBeCloseTo(660, 5); // 11:00/mi
    expect(r.weeks[2].avgPaceSecPerMile).toBeNull(); // no run in W3
  });

  it("computes overall avg pace weighted across the span", () => {
    const r = buildPlanAdherence(makePlan(), [W1_RUN, W2_RUN], { maxHr: 185 });
    // (5*600 + 6*660) / (5 + 6) = (3000 + 3960) / 11 = 632.72…
    expect(r.overallAvgPaceSecPerMile).toBeCloseTo(6960 / 11, 5);
  });

  it("overall avg pace is null for a plan with no runs", () => {
    const r = buildPlanAdherence(makePlan(), [], { maxHr: 185 });
    expect(r.overallAvgPaceSecPerMile).toBeNull();
    expect(r.totalActualMiles).toBe(0);
    expect(r.totalCompletedRuns).toBe(0);
  });
});

describe("buildPlanAdherence — completedRuns requires 'full' quality (85% threshold)", () => {
  it("a partial-quality match (below 85%) still adds its mileage but is not counted as completed", () => {
    // W1 planned 5mi; actual run is only 3mi (60%) — matches (day-proximity
    // gate only) but grades "partial", so it should count toward actualMiles
    // but NOT toward completedRuns.
    const shortRun = run("2026-01-19T12:00:00Z", 3, 3 * 600);
    const r = buildPlanAdherence(makePlan(), [shortRun, W2_RUN], { maxHr: 185 });
    expect(r.weeks[0].actualMiles).toBeCloseTo(3, 5);
    expect(r.weeks[0].completedRuns).toBe(0);
    // W2 (6/6 = 100%) still counts as completed.
    expect(r.totalCompletedRuns).toBe(1);
    // actualMiles total is unaffected by the completion grading — still sums
    // matched + bonus mileage regardless of quality.
    expect(r.totalActualMiles).toBeCloseTo(9, 5); // 3 + 6
  });

  it("a run more than 3mi short of planned (previously unmatched entirely) now still contributes to actualMiles as before, via matching rather than the old bonus-run path", () => {
    // Previously this 4mi-short run would fail to match altogether and instead
    // be picked up as a "bonus" unmatched run within the week range. Now it
    // matches directly (partial quality), so actualMiles is unchanged either way.
    const plan = makePlan();
    const veryShortRun = run("2026-01-19T12:00:00Z", 1, 1 * 600); // planned 5mi, 20%
    const r = buildPlanAdherence(plan, [veryShortRun], { maxHr: 185 });
    expect(r.weeks[0].actualMiles).toBeCloseTo(1, 5);
    expect(r.weeks[0].completedRuns).toBe(0);
  });
});

describe("buildPlanAdherence — throughDate cutoff (Plan Insights parity)", () => {
  it("includes only weeks whose start is on/before throughDate", () => {
    // Cut off mid-plan: only weeks 1 and 2 have started by 2026-01-28.
    const r = buildPlanAdherence(makePlan(), [W1_RUN, W2_RUN], {
      maxHr: 185,
      throughDate: new Date("2026-01-28T00:00:00"),
    });
    expect(r.weeks.map((w) => w.weekNumber)).toEqual([1, 2]);
    expect(r.totalPlannedMiles).toBeCloseTo(11, 5); // 5 + 6 (week 3 excluded)
    expect(r.totalActualMiles).toBeCloseTo(11, 5);
  });

  it("regression: elapsed-only totals differ from full span when a future week exists", () => {
    const full = buildPlanAdherence(makePlan(), [W1_RUN, W2_RUN], { maxHr: 185 });
    const elapsed = buildPlanAdherence(makePlan(), [W1_RUN, W2_RUN], {
      maxHr: 185,
      throughDate: new Date("2026-01-28T00:00:00"),
    });
    expect(full.weeks).toHaveLength(3);
    expect(elapsed.weeks).toHaveLength(2);
    // Planned miles drop by exactly week 3's 7 mi when the cutoff excludes it.
    expect(full.totalPlannedMiles - elapsed.totalPlannedMiles).toBeCloseTo(7, 5);
  });

  it("throughDate on/after the last week includes the whole plan", () => {
    const r = buildPlanAdherence(makePlan(), [W1_RUN, W2_RUN], {
      maxHr: 185,
      throughDate: new Date("2026-03-01T00:00:00"),
    });
    expect(r.weeks).toHaveLength(3);
  });
});
