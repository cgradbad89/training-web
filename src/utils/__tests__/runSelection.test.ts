import { describe, expect, it } from "vitest";
import { type HealthWorkout } from "@/types/healthWorkout";
import { selectRuns } from "@/utils/runSelection";

function workout(
  workoutId: string,
  overrides: Partial<HealthWorkout> = {}
): HealthWorkout {
  const start = new Date(2026, 2, 26, 6, 0, 0);
  return {
    workoutId,
    name: "Run",
    activityType: "running",
    displayType: "Run",
    startDate: start,
    endDate: new Date(start.getTime() + 3600_000),
    durationSeconds: 3600,
    sourceName: "Apple Watch",
    isRunLike: true,
    hasRoute: false,
    syncedAt: start,
    distanceMiles: 6,
    ...overrides,
  } as unknown as HealthWorkout;
}

describe("selectRuns", () => {
  it("keeps a device run", () => {
    const run = workout("device-run");
    expect(selectRuns([run])).toEqual([run]);
  });

  it("keeps a manual run entry (isRunLike true)", () => {
    const manual = workout("manual_run", {
      entrySource: "manual",
      sourceName: "Manual Entry",
      activityType: "treadmill_running",
      displayType: "Treadmill Run",
    });
    expect(selectRuns([manual])).toEqual([manual]);
  });

  it("drops a manual HIIT that carries a distance", () => {
    const hiit = workout("manual_hiit", {
      entrySource: "manual",
      sourceName: "Manual Entry",
      activityType: "high_intensity_interval_training",
      displayType: "HIIT",
      isRunLike: false,
      distanceMiles: 9.99,
      durationSeconds: 3600,
    });
    expect(selectRuns([hiit])).toEqual([]);
  });

  it("drops a cycling-like workout with a long distance", () => {
    const ride = workout("ride", {
      activityType: "cycling",
      displayType: "Cycling",
      isRunLike: false,
      distanceMiles: 30.8,
      durationSeconds: 10943,
    });
    expect(selectRuns([ride])).toEqual([]);
  });

  it("treats a missing isRunLike as not a run", () => {
    const legacy = workout("legacy", {
      isRunLike: undefined as unknown as boolean,
    });
    expect(selectRuns([legacy])).toEqual([]);
  });

  it("preserves input order and returns the same object references", () => {
    const a = workout("a");
    const hiit = workout("hiit", { isRunLike: false });
    const b = workout("b");
    const c = workout("c");
    const result = selectRuns([a, hiit, b, c]);
    expect(result.map((w) => w.workoutId)).toEqual(["a", "b", "c"]);
    expect(result[0]).toBe(a);
  });

  it("does not mutate its input", () => {
    const input = [workout("a"), workout("x", { isRunLike: false })];
    const snapshot = [...input];
    selectRuns(input);
    expect(input).toEqual(snapshot);
  });

  it("returns an empty array for empty input", () => {
    expect(selectRuns([])).toEqual([]);
  });
});
