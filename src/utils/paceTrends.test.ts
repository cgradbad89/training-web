import { describe, it, expect } from "vitest";
import { buildPaceTrendsByDistanceBucket } from "./paceTrends";
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

describe("buildPaceTrendsByDistanceBucket", () => {
  it("handles insufficient data for a bucket", () => {
    // Only a short run exists
    const workouts = [mockWorkout("2024-07-15T10:00:00Z", 2.0, 1200)];
    // asOf is Wed Jul 17 2024. Current Monday is Jul 15.
    const result = buildPaceTrendsByDistanceBucket(workouts, 1, new Date("2024-07-17T12:00:00Z"));
    
    expect(result[0].short).toBe(600);
    expect(result[0].medium).toBeNull();
    expect(result[0].long).toBeNull();
  });

  it("handles week-boundary logic correctly", () => {
    // Current Monday is Jul 15.
    // Last week's Monday is Jul 8.
    const workouts = [
      mockWorkout(new Date(2024, 6, 14, 23, 59, 59).toISOString(), 4.0, 2400), // Sunday night (Last week)
      mockWorkout(new Date(2024, 6, 15, 0, 0, 1).toISOString(), 4.0, 2000), // Monday morning (Current week)
    ];

    const result = buildPaceTrendsByDistanceBucket(workouts, 2, new Date(2024, 6, 17, 12, 0, 0));
    
    expect(result.length).toBe(2);
    // Last week
    expect(result[0].label).toBe("Jul 8");
    expect(result[0].medium).toBe(600);
    // Current week
    expect(result[1].label).toBe("Jul 15");
    expect(result[1].medium).toBe(500);
  });

  it("regression test: produces identical output to previous inline logic", () => {
    const workouts = [
      // 1-3 mi bucket
      mockWorkout(new Date(2024, 6, 15, 10, 0, 0).toISOString(), 2.0, 1200), // pace 600
      mockWorkout(new Date(2024, 6, 16, 10, 0, 0).toISOString(), 2.0, 1400), // pace 700
      // 3-6 mi bucket
      mockWorkout(new Date(2024, 6, 15, 10, 0, 0).toISOString(), 4.0, 2400), // pace 600
      // 6+ mi bucket
      mockWorkout(new Date(2024, 6, 15, 10, 0, 0).toISOString(), 10.0, 6000), // pace 600
    ];

    const result = buildPaceTrendsByDistanceBucket(workouts, 1, new Date(2024, 6, 17, 12, 0, 0));
    
    expect(result).toEqual([
      {
        label: "Jul 15",
        short: 650, // (1200*2 + 1400*2) / 4 = 2600 / 4 = 650
        medium: 600,
        long: 600,
      }
    ]);
  });
});
