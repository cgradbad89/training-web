import { describe, it, expect } from "vitest";
import { buildPersonalRecordsByYear } from "./personalRecords";
import { type HealthWorkout } from "@/types/healthWorkout";

const mockWorkout = (
  date: string,
  distanceMiles: number,
  durationSeconds: number
): HealthWorkout => ({
  workoutId: `w_${date}_${distanceMiles}`,
  startDate: new Date(date),
  endDate: new Date(date),
  durationSeconds,
  distanceMiles,
  activityType: "running",
  sourceName: "Apple Watch",
  isRunLike: true,
});

describe("buildPersonalRecordsByYear", () => {
  it("handles a year with no qualifying runs", () => {
    const workouts = [
      mockWorkout("2024-01-01T10:00:00Z", 0.5, 300), // < 1 mile, doesn't qualify for PR buckets
    ];
    const { prs, specificPrs } = buildPersonalRecordsByYear(workouts, 2024);
    expect(prs.every((p) => p === null)).toBe(true);
    expect(specificPrs.every((p) => p === null)).toBe(true);
  });

  it("calculates PRs for multiple years separately", () => {
    const workouts = [
      // 2023: fast 2 miles
      mockWorkout("2023-01-01T10:00:00Z", 2.0, 1000), // pace 500
      // 2024: slower 2 miles
      mockWorkout("2024-01-01T10:00:00Z", 2.0, 1200), // pace 600
    ];

    const result2023 = buildPersonalRecordsByYear(workouts, 2023);
    const result2024 = buildPersonalRecordsByYear(workouts, 2024);

    expect(result2023.prs[0]?.pace).toBe(500); // 1-3 mi bucket
    expect(result2024.prs[0]?.pace).toBe(600); // 1-3 mi bucket
  });

  it("handles bucket boundary edges correctly", () => {
    const workouts = [
      mockWorkout("2024-01-01T10:00:00Z", 3.0, 1500), // Exactly 3.0 miles (should be 3-6 mi bucket)
    ];
    const { prs } = buildPersonalRecordsByYear(workouts, 2024);

    expect(prs[0]).toBeNull(); // 1-3 mi bucket is exclusive of 3.0
    expect(prs[1]?.miles).toBe(3.0); // 3-6 mi bucket is inclusive of 3.0
  });

  it("regression test: produces identical output to previous inline logic", () => {
    const workouts = [
      mockWorkout("2024-06-01T10:00:00Z", 2.0, 1200), // Pace 600
      mockWorkout("2024-06-05T10:00:00Z", 3.107, 1864), // Pace 600 (5K)
      mockWorkout("2024-07-01T10:00:00Z", 6.214, 3728), // Pace 600 (10K)
      mockWorkout("2024-07-02T10:00:00Z", 10.0, 6000), // Pace 600
    ];

    const { prs, specificPrs } = buildPersonalRecordsByYear(workouts, 2024);

    expect(prs).toEqual([
      { pace: 600, miles: 2, date: new Date("2024-06-01T10:00:00Z") },
      { pace: 599.9356292243322, miles: 3.107, date: new Date("2024-06-05T10:00:00Z") },
      { pace: 599.9356292243322, miles: 6.214, date: new Date("2024-07-01T10:00:00Z") },
      null, // 7-10 mi bucket
      { pace: 600, miles: 10, date: new Date("2024-07-02T10:00:00Z") },
    ]);

    expect(specificPrs).toEqual([
      { pace: 599.9356292243322, totalSeconds: 1864, miles: 3.107, date: new Date("2024-06-05T10:00:00Z") },
      null, // 5 Miles
      { pace: 599.9356292243322, totalSeconds: 3728, miles: 6.214, date: new Date("2024-07-01T10:00:00Z") },
      { pace: 600, totalSeconds: 6000, miles: 10, date: new Date("2024-07-02T10:00:00Z") }, // 15K bucket matches 10 miles due to 0.75 tolerance
      { pace: 600, totalSeconds: 6000, miles: 10, date: new Date("2024-07-02T10:00:00Z") },
      null, // Half Marathon
    ]);
  });
});
