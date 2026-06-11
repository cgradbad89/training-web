import { describe, it, expect } from "vitest";
import {
  computeWeekScore,
  daysElapsedInWeek,
  isScheduledThroughToday,
  proRatedLoadTarget,
  weekScoreBasisLabel,
  type WeekScoreInput,
} from "@/utils/weekScore";

/**
 * Pro-rated Week Score — the score is computed against the plan scheduled
 * THROUGH TODAY, not the full week. These tests cover the helper math and the
 * end-to-end component scoring for mid-week / rest-day / full-week scenarios.
 */

// A known Monday week start (local midnight). daysElapsedInWeek only counts
// from the given start, so the actual weekday is irrelevant to its math.
const MON = new Date(2026, 5, 8); // Mon Jun 8, 2026
const plus = (n: number) => new Date(2026, 5, 8 + n);

describe("daysElapsedInWeek", () => {
  it("counts the week-start day itself as day 1", () => {
    expect(daysElapsedInWeek(MON, MON)).toBe(1);
  });

  it("counts today as a full day mid-week (Wed = 3)", () => {
    expect(daysElapsedInWeek(MON, plus(2))).toBe(3);
  });

  it("is 7 on the final day (Sun)", () => {
    expect(daysElapsedInWeek(MON, plus(6))).toBe(7);
  });

  it("clamps a fully-elapsed past week to 7", () => {
    expect(daysElapsedInWeek(MON, plus(20))).toBe(7);
  });

  it("clamps a future week to 0", () => {
    expect(daysElapsedInWeek(MON, plus(-1))).toBe(0);
  });

  it("ignores time-of-day (counts calendar days)", () => {
    const wedEvening = new Date(2026, 5, 10, 23, 30); // Wed 23:30
    expect(daysElapsedInWeek(MON, wedEvening)).toBe(3);
  });
});

describe("isScheduledThroughToday", () => {
  it("includes entries on or before today's weekday", () => {
    // daysElapsed = 3 (through Wed): Mon(1), Tue(2), Wed(3) count; Thu(4)+ don't
    expect(isScheduledThroughToday(1, 3)).toBe(true);
    expect(isScheduledThroughToday(3, 3)).toBe(true);
    expect(isScheduledThroughToday(4, 3)).toBe(false);
    expect(isScheduledThroughToday(7, 3)).toBe(false);
  });

  it("excludes everything when no days have elapsed", () => {
    expect(isScheduledThroughToday(1, 0)).toBe(false);
  });
});

describe("proRatedLoadTarget (load fallback path)", () => {
  it("scales the weekly baseline by daysElapsed/7", () => {
    expect(proRatedLoadTarget(350, 3)).toBeCloseTo(150, 6);
    expect(proRatedLoadTarget(350, 7)).toBe(350); // full week == baseline
  });

  it("is 0 with no baseline or no days elapsed (→ 100% credit)", () => {
    expect(proRatedLoadTarget(0, 5)).toBe(0);
    expect(proRatedLoadTarget(350, 0)).toBe(0);
  });
});

describe("weekScoreBasisLabel", () => {
  it("names today's weekday mid-week", () => {
    expect(weekScoreBasisLabel(3)).toBe("vs plan through Wed");
    expect(weekScoreBasisLabel(1)).toBe("vs plan through Mon");
  });
  it("reads as full-week on the last day", () => {
    expect(weekScoreBasisLabel(7)).toBe("vs full-week plan");
  });
  it("reads as upcoming for a future week", () => {
    expect(weekScoreBasisLabel(0)).toBe("Upcoming week");
  });
});

describe("computeWeekScore — pro-rated against plan through today", () => {
  it("mid-week ON-TRACK through Wednesday → 100", () => {
    // Through Wed: 10 mi scheduled & done, 1 session scheduled & done, load at
    // 120% of the pro-rated baseline (350 × 3/7 = 150 → 180).
    const input: WeekScoreInput = {
      actualMiles: 10,
      plannedMiles: 10,
      thisWeekTotalLoad: 180,
      avgWeeklyLoad: 350,
      sessionsCompleted: 1,
      sessionsPlanned: 1,
      daysElapsed: 3,
    };
    const r = computeWeekScore(input);
    expect(r.runScore).toBe(40);
    expect(r.workoutScore).toBe(25);
    expect(r.loadScore).toBe(35);
    expect(r.total).toBe(100);
    expect(r.label).toBe("Excellent week");
    expect(r.basisLine).toBe("vs plan through Wed");
  });

  it("mid-week BEHIND → low score from each component", () => {
    const input: WeekScoreInput = {
      actualMiles: 3, // of 10 scheduled through today
      plannedMiles: 10,
      thisWeekTotalLoad: 30, // of 150 pro-rated target
      avgWeeklyLoad: 350,
      sessionsCompleted: 0, // of 2 scheduled through today
      sessionsPlanned: 2,
      daysElapsed: 3,
    };
    const r = computeWeekScore(input);
    expect(r.runScore).toBe(12); // round(0.3 × 40)
    expect(r.workoutScore).toBe(0);
    expect(r.loadScore).toBe(6); // round((0.2/1.2) × 35)
    expect(r.total).toBe(18);
    expect(r.total).toBeLessThan(50);
  });

  it("Monday rest day with nothing scheduled → all components 100% (no baseline)", () => {
    const input: WeekScoreInput = {
      actualMiles: 0,
      plannedMiles: 0, // rest day: nothing scheduled through today
      thisWeekTotalLoad: 0,
      avgWeeklyLoad: 0, // no baseline → load also full credit
      sessionsCompleted: 0,
      sessionsPlanned: 0, // nothing scheduled through today
      daysElapsed: 1,
    };
    const r = computeWeekScore(input);
    expect(r.runScore).toBe(40);
    expect(r.workoutScore).toBe(25);
    expect(r.loadScore).toBe(35);
    expect(r.total).toBe(100);
    expect(r.basisLine).toBe("vs plan through Mon");
  });

  it("rest day with a baseline present still gives run/workout full credit", () => {
    const input: WeekScoreInput = {
      actualMiles: 0,
      plannedMiles: 0, // nothing scheduled → 100%
      thisWeekTotalLoad: 0,
      avgWeeklyLoad: 350, // baseline exists → load IS scored (and behind)
      sessionsCompleted: 0,
      sessionsPlanned: 0, // nothing scheduled → 100%
      daysElapsed: 1,
    };
    const r = computeWeekScore(input);
    expect(r.runScore).toBe(40);
    expect(r.workoutScore).toBe(25);
    expect(r.loadScore).toBe(0); // 0 of (350 × 1/7) = behind
  });

  it("load fallback: scores load-to-date against weeklyBaseline × daysElapsed/7", () => {
    const input: WeekScoreInput = {
      actualMiles: 0,
      plannedMiles: 0,
      thisWeekTotalLoad: 75, // of 350 × 3/7 = 150 → 50% → 0.5/1.2
      avgWeeklyLoad: 350,
      sessionsCompleted: 0,
      sessionsPlanned: 0,
      daysElapsed: 3,
    };
    const r = computeWeekScore(input);
    expect(r.loadScore).toBe(15); // round((0.5/1.2) × 35)
  });

  it("full week complete: pro-rated (daysElapsed=7) equals the full-week result", () => {
    const base = {
      actualMiles: 30,
      plannedMiles: 40,
      thisWeekTotalLoad: 320,
      avgWeeklyLoad: 350,
      sessionsCompleted: 3,
      sessionsPlanned: 4,
    };
    const r = computeWeekScore({ ...base, daysElapsed: 7 });
    // On the last day the load denominator is the un-pro-rated baseline,
    // so every component matches the original full-week formula.
    expect(r.runScore).toBe(Math.round((30 / 40) * 40)); // 30
    expect(r.loadScore).toBe(
      Math.round((Math.min(320 / 350, 1.2) / 1.2) * 35)
    ); // 27
    expect(r.workoutScore).toBe(Math.round((3 / 4) * 25)); // 19
    expect(r.total).toBe(76);
    expect(r.basisLine).toBe("vs full-week plan");
  });

  it("a partial mid-week beats the same numbers scored against the full week", () => {
    // Same actuals; pro-rating (smaller denominators) scores higher than the
    // old full-week denominators would — the core fix.
    const actuals = {
      actualMiles: 12,
      thisWeekTotalLoad: 150,
      avgWeeklyLoad: 350,
      sessionsCompleted: 1,
    };
    const proRated = computeWeekScore({
      ...actuals,
      plannedMiles: 12, // scheduled through Wed
      sessionsPlanned: 1, // scheduled through Wed
      daysElapsed: 3,
    });
    const fullWeek = computeWeekScore({
      ...actuals,
      plannedMiles: 40, // full week
      sessionsPlanned: 4, // full week
      daysElapsed: 7,
    });
    expect(proRated.total).toBeGreaterThan(fullWeek.total);
  });
});
