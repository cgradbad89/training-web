import { describe, it, expect } from "vitest";
import { computeGoalProgress } from "../goalProgress";
import { type RunningGoal, type GoalMetric } from "@/types/goal";
import { type HealthWorkout } from "@/types/healthWorkout";

// ─── Builders ───────────────────────────────────────────────────────────────

function makeGoal(
  metric: GoalMetric,
  target: number,
  startDate: string,
  endDate: string
): RunningGoal {
  return {
    id: "g1",
    label: "Test goal",
    metric,
    target,
    startDate,
    endDate,
    isActive: true,
    // Timestamps are not read by computeGoalProgress.
    createdAt: null as never,
    updatedAt: null as never,
  };
}

function makeRun(
  dateStr: string,
  opts: { miles?: number; seconds?: number } = {}
): HealthWorkout {
  return {
    startDate: new Date(`${dateStr}T12:00:00`),
    distanceMiles: opts.miles ?? 0,
    durationSeconds: opts.seconds ?? 0,
  } as unknown as HealthWorkout;
}

const day = (s: string) => new Date(`${s}T12:00:00`);

// ─── Tests ────────────────────────────────────────────────────────────────

describe("computeGoalProgress — actual aggregation", () => {
  it("distance: sums distanceMiles for in-range runs, excludes out-of-range", () => {
    const goal = makeGoal("distance", 20, "2026-05-01", "2026-05-31");
    const runs = [
      makeRun("2026-04-30", { miles: 5 }), // before range — excluded
      makeRun("2026-05-01", { miles: 4 }), // boundary — included
      makeRun("2026-05-15", { miles: 6 }),
      makeRun("2026-05-31", { miles: 3 }), // boundary — included
      makeRun("2026-06-01", { miles: 9 }), // after range — excluded
    ];
    const p = computeGoalProgress(goal, runs, day("2026-05-31"));
    expect(p.actual).toBeCloseTo(13, 5); // 4 + 6 + 3
  });

  it("time: sums durationSeconds for in-range runs", () => {
    const goal = makeGoal("time", 3600, "2026-05-01", "2026-05-31");
    const runs = [makeRun("2026-05-10", { seconds: 1200 }), makeRun("2026-05-12", { seconds: 900 })];
    const p = computeGoalProgress(goal, runs, day("2026-05-20"));
    expect(p.actual).toBe(2100);
  });

  it("count: counts in-range runs", () => {
    const goal = makeGoal("count", 10, "2026-05-01", "2026-05-31");
    const runs = [makeRun("2026-05-02"), makeRun("2026-05-09"), makeRun("2026-06-02")];
    const p = computeGoalProgress(goal, runs, day("2026-05-15"));
    expect(p.actual).toBe(2);
  });

  it("empty runs → actual 0, percent 0", () => {
    const goal = makeGoal("distance", 20, "2026-05-01", "2026-05-31");
    const p = computeGoalProgress(goal, [], day("2026-05-15"));
    expect(p.actual).toBe(0);
    expect(p.percent).toBe(0);
  });
});

describe("computeGoalProgress — status by date range", () => {
  it("upcoming when today < startDate", () => {
    const goal = makeGoal("distance", 20, "2026-05-01", "2026-05-31");
    const p = computeGoalProgress(goal, [], day("2026-04-15"));
    expect(p.status).toBe("upcoming");
    expect(p.paceStatus).toBe("upcoming");
    expect(p.daysElapsed).toBe(0);
    expect(p.daysTotal).toBe(31);
  });

  it("completed when today > endDate (daysElapsed = daysTotal)", () => {
    const goal = makeGoal("distance", 20, "2026-05-01", "2026-05-31");
    const p = computeGoalProgress(goal, [makeRun("2026-05-10", { miles: 25 })], day("2026-06-10"));
    expect(p.status).toBe("completed");
    expect(p.paceStatus).toBe("completed");
    expect(p.daysElapsed).toBe(p.daysTotal);
    expect(p.percent).toBeCloseTo(125, 5); // true % reported even when complete
  });

  it("active when startDate <= today <= endDate", () => {
    const goal = makeGoal("distance", 30, "2026-05-01", "2026-05-31");
    const p = computeGoalProgress(goal, [], day("2026-05-16"));
    expect(p.status).toBe("active");
    expect(p.daysElapsed).toBe(16);
  });
});

describe("computeGoalProgress — paceStatus (active)", () => {
  // 30-day goal, target 30 mi → expected 1 mi/day. Day 15 → expected 15.
  const goal = makeGoal("distance", 30, "2026-05-01", "2026-05-30");

  it("ahead when actual >= expected * 1.02", () => {
    const runs = [makeRun("2026-05-05", { miles: 20 })]; // expected ~15, actual 20
    const p = computeGoalProgress(goal, runs, day("2026-05-15"));
    expect(p.paceStatus).toBe("ahead");
  });

  it("behind when actual <= expected * 0.98", () => {
    const runs = [makeRun("2026-05-05", { miles: 5 })]; // expected ~15, actual 5
    const p = computeGoalProgress(goal, runs, day("2026-05-15"));
    expect(p.paceStatus).toBe("behind");
  });

  it("on_track when actual is right around expected", () => {
    const runs = [makeRun("2026-05-05", { miles: 15 })]; // expected 15, actual 15
    const p = computeGoalProgress(goal, runs, day("2026-05-15"));
    expect(p.paceStatus).toBe("on_track");
  });
});

describe("computeGoalProgress — guards", () => {
  it("single-day range → daysTotal 1, no divide-by-zero", () => {
    const goal = makeGoal("count", 1, "2026-05-10", "2026-05-10");
    const p = computeGoalProgress(goal, [makeRun("2026-05-10")], day("2026-05-10"));
    expect(p.daysTotal).toBe(1);
    expect(p.daysElapsed).toBe(1);
    expect(Number.isFinite(p.percent)).toBe(true);
    expect(p.actual).toBe(1);
  });
});
