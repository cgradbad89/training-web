import { describe, it, expect } from "vitest";
import {
  computeWeekScore,
  buildWeekScoreBreakdown,
  type WeekScoreInput,
  RUN_MAX_POINTS,
  LOAD_MAX_POINTS,
  WORKOUT_MAX_POINTS,
} from "@/utils/weekScore";

// daysElapsed: 7 ⇒ full week elapsed, so these full-week fixtures keep their
// pre-pro-rating expectations (pro-rated == full-week on the last day).
const MID: WeekScoreInput = {
  actualMiles: 24,
  plannedMiles: 40,
  thisWeekTotalLoad: 300,
  avgWeeklyLoad: 350,
  sessionsCompleted: 2,
  sessionsPlanned: 4,
  daysElapsed: 7,
};

const MAXED: WeekScoreInput = {
  actualMiles: 40,
  plannedMiles: 40,
  thisWeekTotalLoad: 1000, // >> 120% of baseline → capped at full
  avgWeeklyLoad: 350,
  sessionsCompleted: 4,
  sessionsPlanned: 4,
  daysElapsed: 7,
};

const NOTHING_DONE: WeekScoreInput = {
  actualMiles: 0,
  plannedMiles: 40,
  thisWeekTotalLoad: 0,
  avgWeeklyLoad: 350,
  sessionsCompleted: 0,
  sessionsPlanned: 4,
  daysElapsed: 7,
};

const NO_PLANS: WeekScoreInput = {
  actualMiles: 12,
  plannedMiles: 0, // no run plan → full credit
  thisWeekTotalLoad: 50,
  avgWeeklyLoad: 0, // no baseline → full credit
  sessionsCompleted: 0,
  sessionsPlanned: 0, // no workout plan → full credit
  daysElapsed: 7,
};

describe("buildWeekScoreBreakdown", () => {
  it("INVARIANT: earnedPoints sum to the breakdown total AND the displayed score", () => {
    for (const input of [MID, MAXED, NOTHING_DONE, NO_PLANS]) {
      const b = buildWeekScoreBreakdown(input);
      const sum = b.components.reduce((s, c) => s + c.earnedPoints, 0);
      const displayed = computeWeekScore(input).total;
      expect(sum).toBe(b.total);
      expect(b.total).toBe(displayed);
    }
  });

  it("maxed week → 40 + 35 + 25 = 100", () => {
    const b = buildWeekScoreBreakdown(MAXED);
    expect(b.components.map((c) => c.earnedPoints)).toEqual([40, 35, 25]);
    expect(b.total).toBe(100);
  });

  it("no-plans week → every component gets full credit (100 total)", () => {
    const b = buildWeekScoreBreakdown(NO_PLANS);
    expect(b.total).toBe(100);
    expect(b.components.every((c) => c.earnedPoints === c.maxPoints)).toBe(true);
    expect(b.components.map((c) => c.target)).toEqual([0, 0, 0]);
  });

  it("nothing-done week → run/workout 0; total < 100", () => {
    const b = buildWeekScoreBreakdown(NOTHING_DONE);
    const run = b.components.find((c) => c.key === "run")!;
    const workout = b.components.find((c) => c.key === "workout")!;
    expect(run.earnedPoints).toBe(0);
    expect(workout.earnedPoints).toBe(0);
    expect(b.total).toBeLessThan(100);
  });

  it("each component's earnedPoints respects its maxPoints cap", () => {
    for (const input of [MID, MAXED, NOTHING_DONE, NO_PLANS]) {
      for (const c of buildWeekScoreBreakdown(input).components) {
        expect(c.earnedPoints).toBeGreaterThanOrEqual(0);
        expect(c.earnedPoints).toBeLessThanOrEqual(c.maxPoints);
      }
    }
  });

  it("exposes the three components with correct labels, units, and max points", () => {
    const b = buildWeekScoreBreakdown(MID);
    expect(b.components.map((c) => c.key)).toEqual(["run", "load", "workout"]);
    expect(b.components.map((c) => c.label)).toEqual([
      "Run miles",
      "Training load",
      "Workouts",
    ]);
    expect(b.components.map((c) => c.maxPoints)).toEqual([
      RUN_MAX_POINTS,
      LOAD_MAX_POINTS,
      WORKOUT_MAX_POINTS,
    ]);
    expect(b.components.map((c) => c.unit)).toEqual(["mi", "load", "sessions"]);
  });

  it("passes actual/target through from the input", () => {
    const b = buildWeekScoreBreakdown(MID);
    const run = b.components.find((c) => c.key === "run")!;
    const load = b.components.find((c) => c.key === "load")!;
    const workout = b.components.find((c) => c.key === "workout")!;
    expect([run.actual, run.target]).toEqual([24, 40]);
    expect([load.actual, load.target]).toEqual([300, 350]);
    expect([workout.actual, workout.target]).toEqual([2, 4]);
  });

  it("earnedPoints equal the scorer's per-component scores (no drift)", () => {
    const r = computeWeekScore(MID);
    const b = buildWeekScoreBreakdown(MID);
    expect(b.components.find((c) => c.key === "run")!.earnedPoints).toBe(r.runScore);
    expect(b.components.find((c) => c.key === "load")!.earnedPoints).toBe(r.loadScore);
    expect(b.components.find((c) => c.key === "workout")!.earnedPoints).toBe(
      r.workoutScore,
    );
  });
});
