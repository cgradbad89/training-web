import { describe, it, expect } from "vitest";
import {
  classifyWeekLoad,
  buildWeeklyLoadModel,
  stepWeekIndex,
  WEEKLY_LOAD_WEEKS_BACK,
} from "@/utils/weeklyLoad";
import { type HealthWorkout } from "@/types/healthWorkout";

// Wednesday 2026-06-10 local → current Monday = 2026-06-08.
const NOW = new Date(2026, 5, 10, 12, 0, 0);

/** Minimal HealthWorkout; stored trainingLoadV2 drives resolveDisplayLoad.
 *  load: null + avgHeartRate: null → resolveDisplayLoad returns null. */
function mkWorkout(
  id: string,
  date: Date,
  load: number | null,
  isRunLike = true
): HealthWorkout {
  return {
    workoutId: id,
    name: isRunLike ? "Run" : "Functional Strength",
    activityType: isRunLike
      ? "HKWorkoutActivityTypeRunning"
      : "HKWorkoutActivityTypeFunctionalStrengthTraining",
    displayType: isRunLike ? "Run" : "Strength",
    startDate: date,
    endDate: date,
    durationSeconds: 1800,
    sourceName: "Apple Watch",
    isRunLike,
    hasRoute: false,
    syncedAt: date,
    calories: 0,
    avgHeartRate: null,
    distanceMiles: isRunLike ? 3 : 0,
    distanceMeters: null,
    avgPaceSecPerMile: null,
    avgSpeedMPS: null,
    hrDriftPct: null,
    cadenceSPM: null,
    efficiencyRaw: null,
    efficiencyScore: null,
    elevationGainM: null,
    trainingLoadV2: load,
  };
}

describe("classifyWeekLoad", () => {
  const MEDIAN = 200;

  it("classifies each band", () => {
    expect(classifyWeekLoad(100, MEDIAN)).toBe("below"); // 50%
    expect(classifyWeekLoad(200, MEDIAN)).toBe("typical"); // 100%
    expect(classifyWeekLoad(260, MEDIAN)).toBe("above"); // 130%
    expect(classifyWeekLoad(320, MEDIAN)).toBe("wellAbove"); // 160%
  });

  it("exact boundary values: 75% → typical, 115% → typical, 145% → above", () => {
    expect(classifyWeekLoad(150, MEDIAN)).toBe("typical"); // exactly 75%
    expect(classifyWeekLoad(149.9, MEDIAN)).toBe("below"); // just under
    expect(classifyWeekLoad(230, MEDIAN)).toBe("typical"); // exactly 115%
    expect(classifyWeekLoad(230.1, MEDIAN)).toBe("above"); // just over
    expect(classifyWeekLoad(290, MEDIAN)).toBe("above"); // exactly 145%
    expect(classifyWeekLoad(290.1, MEDIAN)).toBe("wellAbove"); // just over
  });

  it("zero-median guard: no division blowup, returns 'typical'", () => {
    expect(classifyWeekLoad(0, 0)).toBe("typical");
    expect(classifyWeekLoad(500, 0)).toBe("typical");
    expect(classifyWeekLoad(500, -1)).toBe("typical");
  });
});

describe("buildWeeklyLoadModel", () => {
  it("weekly totals sum runs AND workouts via resolveDisplayLoad; null loads on rows, skipped in totals", () => {
    const workouts = [
      mkWorkout("run-1", new Date(2026, 5, 9), 50, true), // Tue this week
      mkWorkout("wkt-1", new Date(2026, 5, 8), 30, false), // Mon this week
      mkWorkout("run-null", new Date(2026, 5, 9, 18), null, true), // no load
    ];
    const model = buildWeeklyLoadModel(workouts, 185, 60, NOW);
    const current = model.weeks[model.weeks.length - 1];

    expect(current.weekStart).toBe("2026-06-08");
    expect(current.total).toBe(80); // 50 + 30; null skipped, not coerced to 0
    expect(current.activities).toHaveLength(3); // null-load row still listed
    expect(
      current.activities.find((a) => a.id === "run-null")!.load
    ).toBeNull();
    expect(current.activities.find((a) => a.id === "wkt-1")!.kind).toBe(
      "workout"
    );
  });

  it("series spans exactly 16 weeks oldest → newest with zero-activity weeks present", () => {
    const workouts = [mkWorkout("only", new Date(2026, 5, 9), 50)];
    const model = buildWeeklyLoadModel(workouts, 185, 60, NOW);

    expect(model.weeks).toHaveLength(WEEKLY_LOAD_WEEKS_BACK);
    expect(model.weeks[model.weeks.length - 1].weekStart).toBe("2026-06-08");
    const dates = model.weeks.map((w) => w.weekStart);
    expect(dates).toEqual([...dates].sort());
    // Every prior week is an explicit zero-activity entry.
    expect(
      model.weeks.slice(0, -1).every((w) => w.total === 0 && w.activities.length === 0)
    ).toBe(true);
  });

  it("median: zero-activity weeks excluded; in-progress current week excluded", () => {
    const workouts = [
      // Completed weeks (gaps between them = zero-activity weeks).
      mkWorkout("a", new Date(2026, 5, 2), 100), // week of Jun 1
      mkWorkout("b", new Date(2026, 4, 19), 300), // week of May 18
      // Current in-progress week — huge total that would skew the median.
      mkWorkout("now", new Date(2026, 5, 9), 1000), // week of Jun 8
    ];
    const model = buildWeeklyLoadModel(workouts, 185, 60, NOW);
    // Median over completed non-empty weeks only: [100, 300] → 200.
    expect(model.medianWeekly).toBe(200);
  });

  it("median ignores weeks older than 6 months", () => {
    const workouts = [
      mkWorkout("recent", new Date(2026, 5, 2), 100), // inside window
      mkWorkout("ancient", new Date(2025, 0, 6), 900), // ~17 months ago
    ];
    const model = buildWeeklyLoadModel(workouts, 185, 60, NOW);
    expect(model.medianWeekly).toBe(100);
  });

  it("activities within a week are newest first", () => {
    const workouts = [
      mkWorkout("mon", new Date(2026, 5, 8), 10),
      mkWorkout("wed", new Date(2026, 5, 10), 10),
      mkWorkout("tue", new Date(2026, 5, 9), 10),
    ];
    const model = buildWeeklyLoadModel(workouts, 185, 60, NOW);
    const current = model.weeks[model.weeks.length - 1];
    expect(current.activities.map((a) => a.id)).toEqual([
      "wed",
      "tue",
      "mon",
    ]);
  });

  it("no baseline: medianWeekly is 0 when no completed weeks have activity", () => {
    const workouts = [mkWorkout("now", new Date(2026, 5, 9), 100)];
    const model = buildWeeklyLoadModel(workouts, 185, 60, NOW);
    expect(model.medianWeekly).toBe(0);
  });
});

describe("stepWeekIndex (navigation bounds)", () => {
  it("cannot navigate before the oldest week (index 0)", () => {
    expect(stepWeekIndex(0, -1, 16)).toBe(0);
    expect(stepWeekIndex(1, -1, 16)).toBe(0);
  });

  it("cannot navigate past the current week (last index)", () => {
    expect(stepWeekIndex(15, 1, 16)).toBe(15);
    expect(stepWeekIndex(14, 1, 16)).toBe(15);
  });

  it("steps normally inside the bounds and handles empty week lists", () => {
    expect(stepWeekIndex(7, 1, 16)).toBe(8);
    expect(stepWeekIndex(7, -1, 16)).toBe(6);
    expect(stepWeekIndex(3, 1, 0)).toBe(0);
  });
});
