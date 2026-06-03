import { describe, expect, it } from "vitest";
import { type HealthWorkout } from "@/types/healthWorkout";
import { computeBestEffortRecords } from "@/utils/bestEffortRecords";

function run(
  workoutId: string,
  date: string,
  bestEfforts: HealthWorkout["bestEfforts"]
): HealthWorkout {
  return {
    workoutId,
    name: "Run",
    activityType: "Run",
    displayType: "Run",
    startDate: new Date(date),
    endDate: new Date(date),
    durationSeconds: 1800,
    sourceName: "Apple Watch",
    isRunLike: true,
    hasRoute: true,
    syncedAt: new Date(date),
    calories: 0,
    avgHeartRate: null,
    distanceMiles: 3,
    distanceMeters: null,
    avgPaceSecPerMile: null,
    avgSpeedMPS: null,
    hrDriftPct: null,
    cadenceSPM: null,
    efficiencyRaw: null,
    efficiencyScore: null,
    elevationGainM: null,
    bestEfforts,
  };
}

describe("computeBestEffortRecords", () => {
  it("picks the minimum effort across multiple runs", () => {
    const records = computeBestEffortRecords(
      [
        run("first", "2026-05-01T12:00:00.000Z", {
          "1mi": 500,
          "5k": null,
          "10k": null,
          "10mi": null,
          half: null,
        }),
        run("fastest", "2026-05-03T12:00:00.000Z", {
          "1mi": 420,
          "5k": null,
          "10k": null,
          "10mi": null,
          half: null,
        }),
        run("latest", "2026-05-05T12:00:00.000Z", {
          "1mi": 480,
          "5k": null,
          "10k": null,
          "10mi": null,
          half: null,
        }),
      ],
      new Date("2026-05-10T12:00:00.000Z")
    );

    expect(records["1mi"]?.workoutId).toBe("fastest");
    expect(records["1mi"]?.timeSeconds).toBe(420);
  });

  it("returns null for a distance no run reached", () => {
    const records = computeBestEffortRecords(
      [
        run("short", "2026-05-01T12:00:00.000Z", {
          "1mi": 500,
          "5k": null,
          "10k": null,
          "10mi": null,
          half: null,
        }),
      ],
      new Date("2026-05-10T12:00:00.000Z")
    );

    expect(records["5k"]).toBeNull();
  });

  it("sets isRecent true within 30 days and false otherwise", () => {
    const records = computeBestEffortRecords(
      [
        run("recent", "2026-05-20T12:00:00.000Z", {
          "1mi": 400,
          "5k": null,
          "10k": null,
          "10mi": null,
          half: null,
        }),
        run("old", "2026-04-01T12:00:00.000Z", {
          "1mi": null,
          "5k": 1500,
          "10k": null,
          "10mi": null,
          half: null,
        }),
      ],
      new Date("2026-06-01T12:00:00.000Z")
    );

    expect(records["1mi"]?.isRecent).toBe(true);
    expect(records["5k"]?.isRecent).toBe(false);
  });

  it("returns all null records for an empty runs array", () => {
    expect(
      computeBestEffortRecords([], new Date("2026-06-01T12:00:00.000Z"))
    ).toEqual({
      "1mi": null,
      "5k": null,
      "10k": null,
      "10mi": null,
      half: null,
    });
  });
});
