import { describe, it, expect } from "vitest";
import {
  isWeekScoreReady,
  computeWeekScore,
  type WeekScoreReadiness,
  type WeekScoreInput,
} from "@/utils/weekScore";

/**
 * Week Score LOADING GATE — the predicate deciding "still loading" vs "ready
 * to score". Kept separate from the scoring math (weekScoreProRated /
 * weekScoreBreakdown tests): this only verifies the readiness predicate and
 * its interaction with the zero-denominator → 100% rule that the gate exists
 * to hide while data loads.
 */

const ALL_LOADED: WeekScoreReadiness = {
  workoutsLoaded: true,
  plansLoaded: true,
  settingsLoaded: true,
};

describe("isWeekScoreReady", () => {
  it("is ready only when every source has loaded", () => {
    expect(isWeekScoreReady(ALL_LOADED)).toBe(true);
  });

  it("is NOT ready while the workouts snapshot is still loading", () => {
    expect(isWeekScoreReady({ ...ALL_LOADED, workoutsLoaded: false })).toBe(
      false
    );
  });

  it("is NOT ready while plans are still loading", () => {
    expect(isWeekScoreReady({ ...ALL_LOADED, plansLoaded: false })).toBe(false);
  });

  it("is NOT ready while settings are still loading", () => {
    expect(isWeekScoreReady({ ...ALL_LOADED, settingsLoaded: false })).toBe(
      false
    );
  });

  it("is NOT ready when nothing has loaded yet", () => {
    expect(
      isWeekScoreReady({
        workoutsLoaded: false,
        plansLoaded: false,
        settingsLoaded: false,
      })
    ).toBe(false);
  });
});

describe("readiness vs genuinely zero-scheduled week", () => {
  // A real rest-day / nothing-scheduled-yet week: all sources loaded, but the
  // plan has nothing due, so denominators are 0 and every component scores
  // 100% by the zero-denominator rule. This must still read as READY (the
  // on-track result shows) — readiness is about "fetch resolved", not "has
  // data". The gate must not swallow this legitimate case.
  const zeroScheduled: WeekScoreInput = {
    actualMiles: 0,
    plannedMiles: 0,
    thisWeekTotalLoad: 0,
    avgWeeklyLoad: 0,
    sessionsCompleted: 0,
    sessionsPlanned: 0,
    daysElapsed: 3,
  };

  it("treats a loaded-but-empty week as ready (NOT loading)", () => {
    expect(isWeekScoreReady(ALL_LOADED)).toBe(true);
  });

  it("renders the on-track score for a real zero-scheduled week once loaded", () => {
    const r = computeWeekScore(zeroScheduled);
    // Zero denominators → full credit on every component → 100.
    expect(r.total).toBe(100);
    expect(r.runScore).toBe(40);
    expect(r.loadScore).toBe(35);
    expect(r.workoutScore).toBe(25);
  });
});

describe("loading→loaded transition never exposes a false perfect score", () => {
  // The flash scenario: the workouts snapshot has resolved (miles + load are
  // real) but the plan fetch has NOT, so plannedMiles/sessionsPlanned are
  // still 0. Without the gate, computeWeekScore would read a near-perfect
  // score because the unloaded plan zeroes the run/workout denominators.
  const midFlashInput: WeekScoreInput = {
    actualMiles: 4, // real, modest mileage already logged
    plannedMiles: 0, // plan not loaded yet → zero denominator
    thisWeekTotalLoad: 120,
    avgWeeklyLoad: 300, // a real baseline → load is genuinely behind
    sessionsCompleted: 0,
    sessionsPlanned: 0, // plan not loaded yet → zero denominator
    daysElapsed: 3,
  };

  it("would score a misleadingly high total if rendered mid-flash", () => {
    // Documents WHY the gate is needed: run + workout read 100% off zero
    // denominators, inflating the total well above the true mid-week score.
    const r = computeWeekScore(midFlashInput);
    expect(r.runScore).toBe(40); // false full credit
    expect(r.workoutScore).toBe(25); // false full credit
    expect(r.total).toBeGreaterThan(75); // "Strong"/"Excellent" — misleading
  });

  it("gates the card while plans are still loading, so the flash never shows", () => {
    expect(
      isWeekScoreReady({
        workoutsLoaded: true, // snapshot in
        plansLoaded: false, // plans NOT in yet → still loading
        settingsLoaded: true,
      })
    ).toBe(false);
  });
});
