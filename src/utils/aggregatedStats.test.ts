import { describe, it, expect } from "vitest";
import {
  AGGREGATED_STATS_VERSION,
  isAggregatedStatsStale,
  buildAggregatedStats,
  type AggregatedStatsDoc,
} from "./aggregatedStats";
import { type HealthWorkout } from "@/types/healthWorkout";

describe("aggregatedStats", () => {
  describe("isAggregatedStatsStale", () => {
    it("returns true for null cache", () => {
      expect(isAggregatedStatsStale(null, "workout1")).toBe(true);
    });

    it("returns true for version mismatch", () => {
      const cached = {
        computationVersion: AGGREGATED_STATS_VERSION - 1,
        latestWorkoutId: "workout1",
      } as AggregatedStatsDoc;
      expect(isAggregatedStatsStale(cached, "workout1")).toBe(true);
    });

    it("returns true for different latestWorkoutId", () => {
      const cached = {
        computationVersion: AGGREGATED_STATS_VERSION,
        latestWorkoutId: "workout1",
      } as AggregatedStatsDoc;
      expect(isAggregatedStatsStale(cached, "workout2")).toBe(true);
    });

    it("returns false for same version and latestWorkoutId", () => {
      const cached = {
        computationVersion: AGGREGATED_STATS_VERSION,
        latestWorkoutId: "workout1",
      } as AggregatedStatsDoc;
      expect(isAggregatedStatsStale(cached, "workout1")).toBe(false);
    });
  });

  describe("buildAggregatedStats", () => {
    it("returns safe defaults for empty workouts", () => {
      const result = buildAggregatedStats({
        workouts: [],
        routePointsByWorkoutId: {},
        mileSplitsByWorkoutId: {},
        healthMetrics: [],
        maxHr: 185,
        restingHr: 50,
        now: new Date("2024-01-01T12:00:00Z"),
      });

      expect(result.computationVersion).toBe(AGGREGATED_STATS_VERSION);
      expect(result.latestWorkoutId).toBe("");
      expect(result.trainingLoad.series).toEqual([]);
      expect(result.racePredictions.t5k).toBeNull();
      expect(result.racePredictions.confidenceLevel).toBe("low");
      expect(result.personalRecordsByYear.prs).toEqual([]);
    });

    it("wires dependencies correctly for populated inputs", () => {
      const now = new Date("2024-01-01T12:00:00Z");
      const mockWorkout: HealthWorkout = {
        workoutId: "workout1",
        startDate: new Date("2024-01-01T10:00:00Z"),
        endDate: new Date("2024-01-01T10:20:00Z"),
        distanceMiles: 3.1,
        durationSeconds: 1200,
        activityType: "Running",
        sourceName: "Apple Watch",
        basalEnergyBurned: 100,
        activeEnergyBurned: 200,
        sourceVersion: "1",
        device: "Apple Watch",
      };

      const result = buildAggregatedStats({
        workouts: [mockWorkout],
        routePointsByWorkoutId: {},
        mileSplitsByWorkoutId: {},
        healthMetrics: [
          { id: "metric1", data: { date: "2024-01-01", vo2_max: 50 } },
        ],
        maxHr: 185,
        restingHr: 50,
        now,
      });

      expect(result.latestWorkoutId).toBe("workout1");
      expect(result.vo2History).toEqual([{ date: "2024-01-01", value: 50 }]);
      expect(result.personalRecordsByYear.specificPrs.length).toBeGreaterThan(0);
      expect(result.racePredictions.modelFit).toBeNull(); // not enough for riegel fit
      expect(result.paceTrends).toBeDefined();
    });
  });
});
